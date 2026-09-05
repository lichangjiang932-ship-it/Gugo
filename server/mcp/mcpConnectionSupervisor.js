const DEFAULT_OPTIONS = Object.freeze({
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 5,
  stableWindowMs: 60_000,
})

function normalizeKey(value) {
  return String(value ?? '')
}

function normalizeError(error, fallback = 'MCP connection failed') {
  if (error instanceof Error) return error
  return new Error(String(error || fallback))
}

function safeStop(connection) {
  try { connection?.transport?.stop?.() } catch { /* best effort */ }
}

function cancellationError() {
  const error = new Error('MCP connection attempt was cancelled')
  error.code = 'mcp_connection_cancelled'
  return error
}

export function createMcpRecoveringError(state = {}) {
  const attempt = Number(state.attempt || 0)
  const error = new Error(attempt > 0
    ? `MCP connection is recovering (attempt ${attempt})`
    : 'MCP connection is recovering')
  error.code = 'mcp_connection_recovering'
  error.reason = 'mcp_connection_recovering'
  error.retryable = true
  if (attempt > 0) error.attempt = attempt
  return error
}

export function createMcpConnectionFailedError(state = {}) {
  const detail = state.lastError ? `: ${state.lastError}` : ''
  const error = new Error(`MCP connection recovery failed${detail}`)
  error.code = 'mcp_connection_failed'
  error.reason = 'mcp_connection_failed'
  error.retryable = false
  error.attempt = Number(state.attempt || 0)
  return error
}

function getUserEntries(runtime, userId, create = false) {
  const userKey = normalizeKey(userId)
  let entries = runtime.entriesByUser.get(userKey)
  if (!entries && create) {
    entries = new Map()
    runtime.entriesByUser.set(userKey, entries)
  }
  return entries || null
}

function getEntry(runtime, userId, serverId) {
  return getUserEntries(runtime, userId)?.get(normalizeKey(serverId)) || null
}

function createEntry(runtime, userId, server) {
  const userKey = normalizeKey(userId)
  const serverKey = normalizeKey(server?.id)
  const entries = getUserEntries(runtime, userKey, true)
  let entry = entries.get(serverKey)
  if (entry) {
    entry.server = server
    return entry
  }
  entry = {
    userId, userKey, serverId: server?.id, serverKey, server,
    status: 'idle', attempt: 0, generation: 0, connection: null,
    inFlight: null, reconnectTimer: null, stableTimer: null,
    unbindTransport: null, waiters: new Set(), lastError: null, connectedAt: null,
  }
  entries.set(serverKey, entry)
  return entry
}

function isCurrent(runtime, entry, generation) {
  return !runtime.stopped
    && getEntry(runtime, entry.userKey, entry.serverKey) === entry
    && entry.generation === generation
}

function snapshot(entry) {
  if (!entry) return null
  return Object.freeze({
    userId: entry.userId,
    serverId: entry.serverId,
    status: entry.status,
    attempt: entry.attempt,
    generation: entry.generation,
    connectedAt: entry.connectedAt,
    lastError: entry.lastError?.message || null,
  })
}

function emitState(runtime, entry) {
  try { runtime.onStateChange(snapshot(entry)) } catch { /* observers cannot break recovery */ }
}

function setState(runtime, entry, status, { attempt = entry.attempt, error = entry.lastError } = {}) {
  entry.status = status
  entry.attempt = attempt
  entry.lastError = error ? normalizeError(error) : null
  if (status !== 'connected') entry.connectedAt = null
  emitState(runtime, entry)
}

function clearEntryTimer(runtime, entry, field) {
  if (entry[field] == null) return
  runtime.clearTimeoutFn(entry[field])
  entry[field] = null
}

function clearTransportBinding(entry) {
  const unbind = entry.unbindTransport
  entry.unbindTransport = null
  try { unbind?.() } catch { /* best effort */ }
}

function settleWaiters(entry, method, value) {
  const waiters = [...entry.waiters]
  entry.waiters.clear()
  for (const waiter of waiters) {
    try { waiter[method](value) } catch { /* ignore */ }
  }
}

function waitForRecovery(runtime, entry) {
  if (entry.status === 'connected' && runtime.isAlive(entry.connection)) {
    return Promise.resolve(entry.connection)
  }
  if (entry.status === 'failed') return Promise.reject(createMcpConnectionFailedError(snapshot(entry)))
  return new Promise((resolve, reject) => entry.waiters.add({ resolve, reject }))
}

function delayForAttempt(runtime, attempt) {
  const exponent = Math.max(0, Number(attempt || 1) - 1)
  return Math.min(runtime.config.initialDelayMs * (2 ** exponent), runtime.config.maxDelayMs)
}

function scheduleStableReset(runtime, entry, generation) {
  clearEntryTimer(runtime, entry, 'stableTimer')
  entry.stableTimer = runtime.setTimeoutFn(() => {
    entry.stableTimer = null
    if (!isCurrent(runtime, entry, generation)
      || entry.status !== 'connected'
      || !runtime.isAlive(entry.connection)
      || entry.attempt === 0) return
    entry.attempt = 0
    entry.lastError = null
    emitState(runtime, entry)
  }, runtime.config.stableWindowMs)
  entry.stableTimer?.unref?.()
}

function bindTransport(runtime, entry, connection, generation) {
  const transport = connection?.transport
  if (!transport) return () => {}
  const disposers = []
  const report = (reason) => {
    if (reason?.intentional === true) return
    reportTransportFailure(runtime, entry.userId, entry.serverId, reason?.reason || reason, generation)
  }
  for (const subscribe of ['onError', 'onClose', 'onExit']) {
    if (typeof transport[subscribe] !== 'function') continue
    const dispose = transport[subscribe](report)
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* best effort */ }
    }
  }
}

function failPermanently(runtime, entry, error) {
  clearEntryTimer(runtime, entry, 'reconnectTimer')
  clearEntryTimer(runtime, entry, 'stableTimer')
  clearTransportBinding(entry)
  setState(runtime, entry, 'failed', {
    attempt: Math.min(entry.attempt, runtime.config.maxAttempts), error,
  })
  settleWaiters(entry, 'reject', createMcpConnectionFailedError(snapshot(entry)))
}

function scheduleReconnect(runtime, entry, attempt, error) {
  if (attempt > runtime.config.maxAttempts) {
    failPermanently(runtime, entry, error)
    return
  }
  clearEntryTimer(runtime, entry, 'reconnectTimer')
  setState(runtime, entry, 'reconnecting', { attempt, error })
  entry.reconnectTimer = runtime.setTimeoutFn(() => {
    entry.reconnectTimer = null
    void startAttempt(runtime, entry, { reconnecting: true }).catch(() => {})
  }, delayForAttempt(runtime, attempt))
  entry.reconnectTimer?.unref?.()
}

async function startAttempt(runtime, entry, { reconnecting }) {
  if (entry.inFlight) return entry.inFlight
  const generation = ++entry.generation
  clearEntryTimer(runtime, entry, 'reconnectTimer')
  setState(runtime, entry, reconnecting ? 'reconnecting' : 'connecting', {
    attempt: reconnecting ? entry.attempt : 0,
    error: reconnecting ? entry.lastError : null,
  })
  const attemptPromise = Promise.resolve().then(async () => {
    let connection = null
    try {
      connection = await runtime.connect({
        userId: entry.userId,
        serverId: entry.serverId,
        server: entry.server,
        generation,
        reconnecting,
        attempt: entry.attempt,
      })
      if (!isCurrent(runtime, entry, generation)) {
        safeStop(connection)
        throw cancellationError()
      }
      const previousConnection = entry.connection
      await runtime.onConnected({
        userId: entry.userId,
        serverId: entry.serverId,
        server: entry.server,
        connection,
        previousConnection,
        generation,
        reconnecting,
        attempt: entry.attempt,
      })
      if (!isCurrent(runtime, entry, generation)) {
        safeStop(connection)
        throw cancellationError()
      }
      clearTransportBinding(entry)
      entry.connection = connection
      entry.unbindTransport = bindTransport(runtime, entry, connection, generation)
      if (!runtime.isAlive(connection)) throw new Error('MCP transport closed during connection setup')
      entry.connectedAt = runtime.now()
      setState(runtime, entry, 'connected', { attempt: entry.attempt, error: null })
      scheduleStableReset(runtime, entry, generation)
      settleWaiters(entry, 'resolve', connection)
      return connection
    } catch (error) {
      const normalized = normalizeError(error)
      if (!isCurrent(runtime, entry, generation)) throw normalized
      if (connection && connection !== entry.connection) safeStop(connection)
      if (reconnecting) {
        if (entry.attempt >= runtime.config.maxAttempts) failPermanently(runtime, entry, normalized)
        else scheduleReconnect(runtime, entry, entry.attempt + 1, normalized)
      } else failPermanently(runtime, entry, normalized)
      throw normalized
    }
  })
  entry.inFlight = attemptPromise
  const clearInFlight = () => {
    if (entry.inFlight === attemptPromise) entry.inFlight = null
  }
  void attemptPromise.then(clearInFlight, clearInFlight)
  return attemptPromise
}

function reportTransportFailure(runtime, userId, serverId, reason, generation = null) {
  const entry = getEntry(runtime, userId, serverId)
  if (!entry || entry.status !== 'connected') return false
  if (generation != null && generation !== entry.generation) return false
  const error = normalizeError(reason, 'MCP transport disconnected')
  clearEntryTimer(runtime, entry, 'stableTimer')
  clearTransportBinding(entry)
  entry.generation += 1
  safeStop(entry.connection)
  try {
    runtime.onConnectionLost({ ...snapshot(entry), connection: entry.connection, error })
  } catch { /* observer only */ }
  scheduleReconnect(runtime, entry, entry.attempt + 1, error)
  return true
}

async function ensureConnection(runtime, userId, server, { manual = false } = {}) {
  if (runtime.stopped) throw new Error('MCP connection supervisor is shut down')
  if (!server?.id) throw new TypeError('MCP server id is required')
  const entry = createEntry(runtime, userId, server)
  if (entry.status === 'connected') {
    if (runtime.isAlive(entry.connection)) return entry.connection
    reportTransportFailure(
      runtime, userId, server.id, new Error('MCP transport is no longer alive'), entry.generation,
    )
    return waitForRecovery(runtime, entry)
  }
  if (entry.status === 'connecting') return entry.inFlight || waitForRecovery(runtime, entry)
  if (entry.status === 'reconnecting') return waitForRecovery(runtime, entry)
  if (entry.status === 'failed' && !manual) {
    throw createMcpConnectionFailedError(snapshot(entry))
  }
  if (manual) {
    clearEntryTimer(runtime, entry, 'reconnectTimer')
    clearEntryTimer(runtime, entry, 'stableTimer')
    clearTransportBinding(entry)
    entry.generation += 1
    entry.attempt = 0
    entry.lastError = null
    if (entry.connection && !runtime.isAlive(entry.connection)) safeStop(entry.connection)
  }
  return startAttempt(runtime, entry, { reconnecting: false })
}

function disconnectConnection(runtime, userId, serverId) {
  const entries = getUserEntries(runtime, userId)
  const entry = entries?.get(normalizeKey(serverId))
  if (!entry) return false
  entries.delete(entry.serverKey)
  if (entries.size === 0) runtime.entriesByUser.delete(entry.userKey)
  clearEntryTimer(runtime, entry, 'reconnectTimer')
  clearEntryTimer(runtime, entry, 'stableTimer')
  clearTransportBinding(entry)
  entry.generation += 1
  settleWaiters(entry, 'reject', cancellationError())
  safeStop(entry.connection)
  return true
}

function shutdownSupervisor(runtime) {
  if (runtime.stopped) return 0
  const pairs = []
  for (const [userId, entries] of runtime.entriesByUser) {
    for (const serverId of entries.keys()) pairs.push([userId, serverId])
  }
  for (const [userId, serverId] of pairs) disconnectConnection(runtime, userId, serverId)
  runtime.stopped = true
  return pairs.length
}

/** Supervise MCP transports independently for every (userId, serverId) pair. */
export function createMcpConnectionSupervisor({
  connect,
  onConnected = () => {},
  onConnectionLost = () => {},
  onStateChange = () => {},
  isAlive = (connection) => Boolean(connection?.transport?.isAlive?.()),
  now = () => Date.now(),
  setTimeoutFn = (fn, delay) => setTimeout(fn, delay),
  clearTimeoutFn = (timer) => clearTimeout(timer),
  options = {},
} = {}) {
  if (typeof connect !== 'function') throw new TypeError('MCP supervisor requires connect()')
  const runtime = {
    connect,
    onConnected,
    onConnectionLost,
    onStateChange,
    isAlive,
    now,
    setTimeoutFn,
    clearTimeoutFn,
    config: { ...DEFAULT_OPTIONS, ...options },
    entriesByUser: new Map(),
    stopped: false,
  }
  return Object.freeze({
    ensure: (userId, server, options) => ensureConnection(runtime, userId, server, options),
    disconnect: (userId, serverId) => disconnectConnection(runtime, userId, serverId),
    disconnectUser(userId) {
      const entries = getUserEntries(runtime, userId)
      if (!entries) return 0
      const serverIds = [...entries.keys()]
      for (const serverId of serverIds) disconnectConnection(runtime, userId, serverId)
      return serverIds.length
    },
    shutdown: () => shutdownSupervisor(runtime),
    reportTransportFailure: (userId, serverId, reason, generation = null) => (
      reportTransportFailure(runtime, userId, serverId, reason, generation)
    ),
    getState: (userId, serverId) => snapshot(getEntry(runtime, userId, serverId)),
    getConnection: (userId, serverId) => getEntry(runtime, userId, serverId)?.connection || null,
    delayForAttempt: (attempt) => delayForAttempt(runtime, attempt),
  })
}

export const MCP_CONNECTION_SUPERVISOR_DEFAULTS = DEFAULT_OPTIONS

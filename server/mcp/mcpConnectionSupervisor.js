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

/**
 * Supervise MCP transports independently for every (userId, serverId) pair.
 * `connect` only establishes and handshakes a connection. `onConnected` is
 * called after the generation check, so stale attempts can never install
 * themselves after disconnect/shutdown.
 */
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

  const config = { ...DEFAULT_OPTIONS, ...options }
  const entriesByUser = new Map()
  let stopped = false

  function getUserEntries(userId, create = false) {
    const userKey = normalizeKey(userId)
    let entries = entriesByUser.get(userKey)
    if (!entries && create) {
      entries = new Map()
      entriesByUser.set(userKey, entries)
    }
    return entries || null
  }

  function getEntry(userId, serverId) {
    return getUserEntries(userId)?.get(normalizeKey(serverId)) || null
  }

  function createEntry(userId, server) {
    const userKey = normalizeKey(userId)
    const serverKey = normalizeKey(server?.id)
    const entries = getUserEntries(userKey, true)
    let entry = entries.get(serverKey)
    if (entry) {
      entry.server = server
      return entry
    }
    entry = {
      userId,
      userKey,
      serverId: server?.id,
      serverKey,
      server,
      status: 'idle',
      attempt: 0,
      generation: 0,
      connection: null,
      inFlight: null,
      reconnectTimer: null,
      stableTimer: null,
      unbindTransport: null,
      waiters: new Set(),
      lastError: null,
      connectedAt: null,
    }
    entries.set(serverKey, entry)
    return entry
  }

  function isCurrent(entry, generation) {
    return !stopped
      && getEntry(entry.userKey, entry.serverKey) === entry
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

  function emitState(entry) {
    try { onStateChange(snapshot(entry)) } catch { /* observers cannot break recovery */ }
  }

  function setState(entry, status, { attempt = entry.attempt, error = entry.lastError } = {}) {
    entry.status = status
    entry.attempt = attempt
    entry.lastError = error ? normalizeError(error) : null
    if (status !== 'connected') entry.connectedAt = null
    emitState(entry)
  }

  function clearTimer(entry, field) {
    if (entry[field] == null) return
    clearTimeoutFn(entry[field])
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

  function waitForRecovery(entry) {
    if (entry.status === 'connected' && isAlive(entry.connection)) {
      return Promise.resolve(entry.connection)
    }
    if (entry.status === 'failed') return Promise.reject(createMcpConnectionFailedError(snapshot(entry)))
    return new Promise((resolve, reject) => entry.waiters.add({ resolve, reject }))
  }

  function delayForAttempt(attempt) {
    const exponent = Math.max(0, Number(attempt || 1) - 1)
    return Math.min(config.initialDelayMs * (2 ** exponent), config.maxDelayMs)
  }

  function scheduleStableReset(entry, generation) {
    clearTimer(entry, 'stableTimer')
    entry.stableTimer = setTimeoutFn(() => {
      entry.stableTimer = null
      if (!isCurrent(entry, generation) || entry.status !== 'connected' || !isAlive(entry.connection)) return
      if (entry.attempt === 0) return
      entry.attempt = 0
      entry.lastError = null
      emitState(entry)
    }, config.stableWindowMs)
    entry.stableTimer?.unref?.()
  }

  function bindTransport(entry, connection, generation) {
    const transport = connection?.transport
    if (!transport) return () => {}
    const disposers = []
    const report = (reason) => {
      if (reason?.intentional === true) return
      reportTransportFailure(entry.userId, entry.serverId, reason?.reason || reason, generation)
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

  function failPermanently(entry, error) {
    clearTimer(entry, 'reconnectTimer')
    clearTimer(entry, 'stableTimer')
    clearTransportBinding(entry)
    setState(entry, 'failed', { attempt: Math.min(entry.attempt, config.maxAttempts), error })
    settleWaiters(entry, 'reject', createMcpConnectionFailedError(snapshot(entry)))
  }

  function scheduleReconnect(entry, attempt, error) {
    if (attempt > config.maxAttempts) {
      failPermanently(entry, error)
      return
    }
    clearTimer(entry, 'reconnectTimer')
    setState(entry, 'reconnecting', { attempt, error })
    entry.reconnectTimer = setTimeoutFn(() => {
      entry.reconnectTimer = null
      void startAttempt(entry, { reconnecting: true }).catch(() => {})
    }, delayForAttempt(attempt))
    entry.reconnectTimer?.unref?.()
  }

  async function startAttempt(entry, { reconnecting }) {
    if (entry.inFlight) return entry.inFlight
    const generation = ++entry.generation
    clearTimer(entry, 'reconnectTimer')
    setState(entry, reconnecting ? 'reconnecting' : 'connecting', {
      attempt: reconnecting ? entry.attempt : 0,
      error: reconnecting ? entry.lastError : null,
    })

    const attemptPromise = Promise.resolve().then(async () => {
      let connection = null
      try {
        connection = await connect({
          userId: entry.userId,
          serverId: entry.serverId,
          server: entry.server,
          generation,
          reconnecting,
          attempt: entry.attempt,
        })
        if (!isCurrent(entry, generation)) {
          safeStop(connection)
          throw cancellationError()
        }

        const previousConnection = entry.connection
        await onConnected({
          userId: entry.userId,
          serverId: entry.serverId,
          server: entry.server,
          connection,
          previousConnection,
          generation,
          reconnecting,
          attempt: entry.attempt,
        })
        if (!isCurrent(entry, generation)) {
          safeStop(connection)
          throw cancellationError()
        }

        clearTransportBinding(entry)
        entry.connection = connection
        entry.unbindTransport = bindTransport(entry, connection, generation)
        if (!isAlive(connection)) throw new Error('MCP transport closed during connection setup')

        entry.connectedAt = now()
        setState(entry, 'connected', { attempt: entry.attempt, error: null })
        scheduleStableReset(entry, generation)
        settleWaiters(entry, 'resolve', connection)
        return connection
      } catch (error) {
        const normalized = normalizeError(error)
        if (!isCurrent(entry, generation)) throw normalized
        if (connection && connection !== entry.connection) safeStop(connection)
        if (reconnecting) {
          if (entry.attempt >= config.maxAttempts) failPermanently(entry, normalized)
          else scheduleReconnect(entry, entry.attempt + 1, normalized)
        } else {
          failPermanently(entry, normalized)
        }
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

  function reportTransportFailure(userId, serverId, reason, generation = null) {
    const entry = getEntry(userId, serverId)
    if (!entry || entry.status !== 'connected') return false
    if (generation != null && generation !== entry.generation) return false

    const error = normalizeError(reason, 'MCP transport disconnected')
    clearTimer(entry, 'stableTimer')
    clearTransportBinding(entry)
    // Invalidate every callback from the failed transport before stopping it.
    entry.generation += 1
    safeStop(entry.connection)
    try { onConnectionLost({ ...snapshot(entry), connection: entry.connection, error }) } catch { /* observer only */ }
    scheduleReconnect(entry, entry.attempt + 1, error)
    return true
  }

  async function ensure(userId, server, { manual = false } = {}) {
    if (stopped) throw new Error('MCP connection supervisor is shut down')
    if (!server?.id) throw new TypeError('MCP server id is required')
    const entry = createEntry(userId, server)

    if (entry.status === 'connected') {
      if (isAlive(entry.connection)) return entry.connection
      reportTransportFailure(userId, server.id, new Error('MCP transport is no longer alive'), entry.generation)
      return waitForRecovery(entry)
    }
    if (entry.status === 'connecting') return entry.inFlight || waitForRecovery(entry)
    if (entry.status === 'reconnecting') return waitForRecovery(entry)
    if (entry.status === 'failed' && !manual) throw createMcpConnectionFailedError(snapshot(entry))

    if (manual) {
      clearTimer(entry, 'reconnectTimer')
      clearTimer(entry, 'stableTimer')
      clearTransportBinding(entry)
      entry.generation += 1
      entry.attempt = 0
      entry.lastError = null
      if (entry.connection && !isAlive(entry.connection)) safeStop(entry.connection)
    }
    return startAttempt(entry, { reconnecting: false })
  }

  function disconnect(userId, serverId) {
    const entries = getUserEntries(userId)
    const entry = entries?.get(normalizeKey(serverId))
    if (!entry) return false
    entries.delete(entry.serverKey)
    if (entries.size === 0) entriesByUser.delete(entry.userKey)
    clearTimer(entry, 'reconnectTimer')
    clearTimer(entry, 'stableTimer')
    clearTransportBinding(entry)
    entry.generation += 1
    settleWaiters(entry, 'reject', cancellationError())
    safeStop(entry.connection)
    return true
  }

  function disconnectUser(userId) {
    const entries = getUserEntries(userId)
    if (!entries) return 0
    const serverIds = [...entries.keys()]
    for (const serverId of serverIds) disconnect(userId, serverId)
    return serverIds.length
  }

  function shutdown() {
    if (stopped) return 0
    const pairs = []
    for (const [userId, entries] of entriesByUser) {
      for (const serverId of entries.keys()) pairs.push([userId, serverId])
    }
    for (const [userId, serverId] of pairs) disconnect(userId, serverId)
    stopped = true
    return pairs.length
  }

  return Object.freeze({
    ensure,
    disconnect,
    disconnectUser,
    shutdown,
    reportTransportFailure,
    getState: (userId, serverId) => snapshot(getEntry(userId, serverId)),
    getConnection: (userId, serverId) => getEntry(userId, serverId)?.connection || null,
    delayForAttempt,
  })
}

export const MCP_CONNECTION_SUPERVISOR_DEFAULTS = DEFAULT_OPTIONS

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createLspStdioRpc,
  lspSignalError,
  lspStdioError,
} from './lspStdioProtocol.js'

export const DEFAULT_LSP_IDLE_TIMEOUT_MS = 60_000
export const DEFAULT_LSP_MAX_PROCESSES = 4
export const DEFAULT_LSP_CRASH_BACKOFF_MS = 250
const MAX_CRASH_BACKOFF_MS = 10_000
const SHUTDOWN_GRACE_MS = 500

function waitForSpawn(child, signal) {
  if (signal.aborted) return Promise.reject(lspSignalError(signal))
  if (child.pid) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onSpawn = () => { cleanup(); resolve() }
    const onError = (cause) => {
      cleanup()
      reject(lspStdioError('LSP_PROCESS_FAILED', 'LSP server failed to start', cause, true))
    }
    const onAbort = () => { cleanup(); reject(lspSignalError(signal)) }
    child.once('spawn', onSpawn)
    child.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(lspSignalError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(lspSignalError(signal)) }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { cleanup(); resolve(value) },
      (cause) => { cleanup(); reject(cause) },
    )
  })
}

async function terminateChild(child, terminate) {
  if (!child) return
  try { child.stdin?.end() } catch { /* already closed */ }
  if (!Number.isInteger(child.pid) || child.pid <= 0) return
  try { await terminate({ pid: child.pid, child }) } catch { /* best effort */ }
}

function createDocumentSynchronizer(documents, getRpc) {
  let syncTail = Promise.resolve()
  const synchronize = (document, languageId, signal) => {
    const operation = syncTail.then(async () => {
      if (signal?.aborted) throw lspSignalError(signal)
      const uri = pathToFileURL(document.fileReal).href
      const current = documents.get(uri)
      if (!current) {
        const next = {
          version: 1,
          text: document.source,
          languageId,
          snapshotSequence: document.snapshotSequence,
        }
        await getRpc().notify('textDocument/didOpen', {
          textDocument: { uri, languageId, version: next.version, text: next.text },
        })
        documents.set(uri, next)
      } else if (document.snapshotSequence < current.snapshotSequence) {
        return uri
      } else if (current.text !== document.source) {
        const next = {
          ...current,
          version: current.version + 1,
          text: document.source,
          snapshotSequence: document.snapshotSequence,
        }
        await getRpc().notify('textDocument/didChange', {
          textDocument: { uri, version: next.version },
          contentChanges: [{ text: next.text }],
        })
        documents.set(uri, next)
      } else {
        documents.set(uri, { ...current, snapshotSequence: document.snapshotSequence })
      }
      return uri
    })
    syncTail = operation.catch(() => {})
    return operation
  }
  return { synchronize, drain: () => syncTail.catch(() => {}) }
}

function createWorkspaceSession({
  config,
  rootReal,
  spawnImpl,
  terminateProcessTreeFn,
  platform,
  childEnv,
  onCrash,
}) {
  const rootUri = pathToFileURL(rootReal).href
  const lifecycle = new AbortController()
  const documents = new Map()
  let child = null
  let rpc = null
  let initialized = false
  let closing = false
  let closePromise = null
  let startupStreamFailure = null

  const rememberStartupStreamFailure = (cause) => {
    if (!rpc && !closing && !startupStreamFailure) startupStreamFailure = cause
  }

  const startPromise = (async () => {
    try {
      child = spawnImpl(config.command, config.args, {
        cwd: config.cwd || rootReal,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
      })
      child.stdin?.on?.('error', rememberStartupStreamFailure)
      child.stdout?.on?.('error', rememberStartupStreamFailure)
      child.stderr?.on?.('error', rememberStartupStreamFailure)
      child.stderr?.resume?.()
      await waitForSpawn(child, lifecycle.signal)
      rpc = createLspStdioRpc(child, {
        rootUri,
        onFatal(cause) {
          if (!closing) onCrash(cause)
        },
      })
      if (startupStreamFailure) {
        throw lspStdioError(
          'LSP_TRANSPORT_FAILED',
          'LSP server stdio failed during startup',
          startupStreamFailure,
          true,
        )
      }
      await rpc.request('initialize', {
        processId: null,
        clientInfo: { name: 'Gugo', version: '1' },
        rootUri,
        capabilities: {
          workspace: { workspaceFolders: true },
          textDocument: { definition: {}, references: {}, implementation: {}, hover: {} },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(rootReal) || 'workspace' }],
      }, lifecycle.signal)
      await rpc.notify('initialized', {})
      initialized = true
      return session
    } catch (cause) {
      if (!closing) onCrash(cause)
      throw cause
    }
  })()

  const documentSync = createDocumentSynchronizer(documents, () => rpc)

  const execute = async (document, request, method, signal) => {
    await waitWithSignal(startPromise, signal)
    const documentUri = await documentSync.synchronize(document, request.languageId, signal)
    return rpc.request(method, {
      textDocument: { uri: documentUri },
      position: request.position,
      ...(request.operation === 'findReferences'
        ? { context: { includeDeclaration: true } }
        : {}),
    }, signal)
  }

  const close = () => {
    if (closePromise) return closePromise
    closing = true
    const reason = lspStdioError('LSP_DISPOSED', `LSP workspace session for ${config.id} is closed`)
    lifecycle.abort(reason)
    closePromise = (async () => {
      await startPromise.catch(() => {})
      if (rpc) {
        if (!initialized) {
          rpc.close(reason)
          await terminateChild(child, terminateProcessTreeFn)
          return
        }
        await documentSync.drain()
        for (const uri of documents.keys()) {
          await rpc.notify('textDocument/didClose', { textDocument: { uri } }).catch(() => {})
        }
        const shutdown = rpc.request('shutdown', null).catch(() => null)
        await Promise.race([
          shutdown,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS)
            timer.unref?.()
          }),
        ])
        await rpc.notify('exit').catch(() => {})
        rpc.close(reason)
      }
      await terminateChild(child, terminateProcessTreeFn)
    })()
    return closePromise
  }

  const session = Object.freeze({ rootUri, startPromise, execute, close })
  return session
}

function createLspPoolEntry({
  key,
  rootReal,
  config,
  spawnImpl,
  terminateProcessTreeFn,
  platform,
  childEnv,
  entries,
  isClosed,
  nextSequence,
  recordCrash,
  scheduleIdle,
}) {
  let resolveReady
  let rejectReady
  const entry = {
    key,
    rootReal,
    active: 0,
    lastUsed: nextSequence(),
    idleTimer: null,
    session: null,
    evicted: false,
    crashRecorded: false,
    stopPromise: null,
    cleanupPromise: null,
    ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject }),
    startTask: null,
  }
  entries.set(key, entry)
  entry.startTask = (async () => {
    if (isClosed() || entry.evicted) {
      throw lspStdioError('LSP_DISPOSED', `LSP provider ${config.id} is closed`)
    }
    entry.session = createWorkspaceSession({
      config,
      rootReal,
      spawnImpl,
      terminateProcessTreeFn,
      platform,
      childEnv,
      onCrash: () => recordCrash(entry),
    })
    await entry.session.startPromise
    resolveReady(entry.session)
    scheduleIdle(entry)
  })().catch((cause) => {
    recordCrash(entry)
    rejectReady(cause)
    throw cause
  })
  entry.startTask.catch(() => {})
  return entry
}

async function acquireLspPoolSession({
  rootReal,
  signal,
  config,
  platform,
  now,
  entries,
  crashes,
  retiringEntries,
  retirementByKey,
  maxProcesses,
  isClosed,
  stopEntry,
  createEntry,
  scheduleIdle,
  nextSequence,
}) {
  const key = platform === 'win32' ? rootReal.toLowerCase() : rootReal
  let entry = null
  while (!entry) {
    if (isClosed()) throw lspStdioError('LSP_DISPOSED', `LSP provider ${config.id} is closed`)
    entry = entries.get(key) || null
    if (entry) break
    const crash = crashes.get(key)
    if (crash && crash.retryAt > now()) {
      throw lspStdioError(
        'LSP_PROCESS_BACKOFF',
        `LSP provider ${config.id} is backing off after a workspace server crash`,
        undefined,
        true,
      )
    }
    const sameKeyRetirement = retirementByKey.get(key)
    if (sameKeyRetirement) {
      await waitWithSignal(sameKeyRetirement.catch(() => {}), signal)
      continue
    }
    if (entries.size + retiringEntries.size >= maxProcesses) {
      const victim = [...entries.values()]
        .filter((candidate) => candidate.active === 0 && !candidate.evicted)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0] || null
      if (victim) {
        await waitWithSignal(stopEntry(victim).catch(() => {}), signal)
        continue
      }
      const retiring = [...retiringEntries]
        .sort((left, right) => left.lastUsed - right.lastUsed)[0]
      const retirement = retiring?.stopPromise || retiring?.cleanupPromise
      if (retirement) {
        await waitWithSignal(retirement.catch(() => {}), signal)
        continue
      }
      throw lspStdioError(
        'LSP_BUSY',
        `LSP provider ${config.id} reached its workspace process limit`,
        undefined,
        true,
      )
    }
    entry = createEntry(key, rootReal)
  }
  clearTimeout(entry.idleTimer)
  entry.idleTimer = null
  entry.active += 1
  entry.lastUsed = nextSequence()
  try {
    const session = await waitWithSignal(entry.ready, signal)
    return Object.freeze({
      rootUri: session.rootUri,
      async execute(...args) {
        try { return await session.execute(...args) }
        catch (cause) { await entry.cleanupPromise?.catch(() => {}); throw cause }
      },
      markHealthy() { crashes.delete(key) },
      release() {
        if (entry.active > 0) entry.active -= 1
        entry.lastUsed = nextSequence()
        scheduleIdle(entry)
      },
    })
  } catch (cause) {
    if (entry.active > 0) entry.active -= 1
    scheduleIdle(entry)
    await entry.cleanupPromise?.catch(() => {})
    throw cause
  }
}

export function createLspWorkspacePool({
  config,
  spawnImpl,
  terminateProcessTreeFn,
  platform,
  childEnv,
  maxProcesses = DEFAULT_LSP_MAX_PROCESSES,
  idleTimeoutMs = DEFAULT_LSP_IDLE_TIMEOUT_MS,
  crashBackoffMs = DEFAULT_LSP_CRASH_BACKOFF_MS,
  now = Date.now,
}) {
  const entries = new Map()
  const crashes = new Map()
  const pendingCleanups = new Set()
  const retiringEntries = new Set()
  const retirementByKey = new Map()
  let closed = false
  let closePromise = null
  let sequence = 0

  const trackCleanup = (work) => {
    const promise = Promise.resolve(work)
    pendingCleanups.add(promise)
    promise.then(
      () => pendingCleanups.delete(promise),
      () => pendingCleanups.delete(promise),
    )
    return promise
  }

  const removeEntry = (entry) => {
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }

  const trackRetirement = (entry, work) => {
    const promise = trackCleanup(work)
    retiringEntries.add(entry)
    retirementByKey.set(entry.key, promise)
    const forget = () => {
      retiringEntries.delete(entry)
      if (retirementByKey.get(entry.key) === promise) retirementByKey.delete(entry.key)
    }
    promise.then(forget, forget)
    return promise
  }

  const recordCrash = (entry) => {
    if (closed || entry.evicted) return
    if (!entry.crashRecorded) {
      entry.crashRecorded = true
      removeEntry(entry)
      const previous = crashes.get(entry.key)
      const attempts = (previous?.attempts || 0) + 1
      const delay = Math.min(crashBackoffMs * (2 ** (attempts - 1)), MAX_CRASH_BACKOFF_MS)
      crashes.set(entry.key, { attempts, retryAt: now() + delay })
    }
    if (!entry.cleanupPromise && entry.session) {
      entry.cleanupPromise = trackRetirement(entry, entry.session.close())
    }
  }

  const stopEntry = (entry) => {
    if (entry.stopPromise) return entry.stopPromise
    entry.evicted = true
    removeEntry(entry)
    entry.stopPromise = trackRetirement(entry, (async () => {
      const startingSession = entry.session
      const immediateClose = startingSession?.close() || Promise.resolve()
      await Promise.allSettled([entry.startTask, immediateClose])
      if (entry.session && entry.session !== startingSession) await entry.session.close()
    })())
    return entry.stopPromise
  }

  const scheduleIdle = (entry) => {
    if (closed
      || entry.evicted
      || entry.crashRecorded
      || entries.get(entry.key) !== entry
      || entry.active !== 0
      || !entry.session) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      if (entry.active === 0 && entries.get(entry.key) === entry) void stopEntry(entry)
    }, idleTimeoutMs)
    entry.idleTimer.unref?.()
  }

  const nextSequence = () => ++sequence
  const createEntry = (key, rootReal) => createLspPoolEntry({
    key,
    rootReal,
    config,
    spawnImpl,
    terminateProcessTreeFn,
    platform,
    childEnv,
    entries,
    isClosed: () => closed,
    nextSequence,
    recordCrash,
    scheduleIdle,
  })

  const acquire = (rootReal, signal) => acquireLspPoolSession({
    rootReal,
    signal,
    config,
    platform,
    now,
    entries,
    crashes,
    retiringEntries,
    retirementByKey,
    maxProcesses,
    isClosed: () => closed,
    stopEntry,
    createEntry,
    scheduleIdle,
    nextSequence,
  })

  const close = () => {
    if (closePromise) return closePromise
    closed = true
    const snapshot = [...entries.values()]
    entries.clear()
    closePromise = (async () => {
      await Promise.allSettled(snapshot.map(stopEntry))
      while (pendingCleanups.size > 0) {
        await Promise.allSettled([...pendingCleanups])
      }
    })()
    return closePromise
  }

  return Object.freeze({ acquire, close })
}

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import {
  CODEX_APP_SERVER_REASON,
  DEFAULT_EXIT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_HANDSHAKE_TIMEOUT_MS,
  MAX_PROTOCOL_LINE_BYTES,
  createCodexRuntimeError,
  normalizeCodexStageTimeout,
  publicCodexAppServerSnapshot,
} from './codexAppServerContracts.js'

const loadModule = createRequire(import.meta.url)
const { version: CLIENT_VERSION } = loadModule('../../package.json')

function isRpcResponseEnvelope(message, requestId) {
  if (!message || message.id !== requestId || Object.hasOwn(message, 'method')) return false
  return Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error')
}

export function joinCodexStartAttempt(attempt, signal, snapshot) {
  if (!signal) {
    attempt.hasPersistentWaiter = true
    return attempt.promise
  }
  attempt.signalWaiters += 1
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener?.('abort', onAbort)
      attempt.signalWaiters = Math.max(0, attempt.signalWaiters - 1)
      callback(value)
    }
    const onAbort = () => {
      finish(resolve, publicCodexAppServerSnapshot({
        ...snapshot,
        ready: false,
        failureStage: null,
        reasonCode: CODEX_APP_SERVER_REASON.START_ABORTED,
      }))
      if (!attempt.hasPersistentWaiter && attempt.signalWaiters === 0) {
        attempt.controller.abort(signal.reason)
      }
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener?.('abort', onAbort, { once: true })
    attempt.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

function createCodexProtocolLineReader({ emitMessage, fail }) {
  let pendingBuffer = null
  let pendingBytes = 0
  const acceptLine = (lineBuffer) => {
    let normalized = lineBuffer
    if (normalized.length > 0 && normalized[normalized.length - 1] === 0x0d) {
      normalized = normalized.subarray(0, normalized.length - 1)
    }
    if (normalized.length === 0) return fail(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
    let line
    try { line = new TextDecoder('utf-8', { fatal: true }).decode(normalized) }
    catch { return fail(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID) }
    let message
    try { message = JSON.parse(line) }
    catch { return fail(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID) }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return fail(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
    }
    emitMessage(message)
  }
  const appendPending = (chunk, start, end) => {
    const segmentBytes = end - start
    const requiredBytes = pendingBytes + segmentBytes
    if (requiredBytes > MAX_PROTOCOL_LINE_BYTES) return false
    if (segmentBytes === 0) return true
    if (!pendingBuffer || pendingBuffer.length < requiredBytes) {
      let capacity = pendingBuffer?.length || 4096
      while (capacity < requiredBytes) capacity = Math.min(MAX_PROTOCOL_LINE_BYTES, capacity * 2)
      const grown = Buffer.allocUnsafe(capacity)
      if (pendingBytes > 0) pendingBuffer.copy(grown, 0, 0, pendingBytes)
      pendingBuffer = grown
    }
    chunk.copy(pendingBuffer, pendingBytes, start, end)
    pendingBytes = requiredBytes
    return true
  }
  const onData = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline < 0 ? chunk.length : newline
      if (!appendPending(chunk, offset, end)) return fail(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
      if (newline < 0) return
      const line = pendingBuffer ? pendingBuffer.subarray(0, pendingBytes) : Buffer.alloc(0)
      pendingBytes = 0
      acceptLine(line)
      offset = newline + 1
    }
  }
  return { onData, clear() { pendingBuffer = null; pendingBytes = 0 } }
}

function createMessageWaiter({ getFatalReason, messageWaiters }) {
  return (predicate, {
    timeoutMs,
    signal,
    timeoutReason = CODEX_APP_SERVER_REASON.HANDSHAKE_TIMEOUT,
  }) => new Promise((resolve, reject) => {
    const fatalReason = getFatalReason()
    if (fatalReason) return reject(createCodexRuntimeError(fatalReason))
    let timer = null
    const waiter = {
      predicate,
      resolve: (message) => { cleanup(); resolve(message) },
      reject: (error) => { cleanup(); reject(error) },
    }
    const onAbort = () => waiter.reject(createCodexRuntimeError(CODEX_APP_SERVER_REASON.START_ABORTED))
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      messageWaiters.delete(waiter)
      signal?.removeEventListener?.('abort', onAbort)
    }
    if (signal?.aborted) return waiter.reject(createCodexRuntimeError(CODEX_APP_SERVER_REASON.START_ABORTED))
    messageWaiters.add(waiter)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(
      () => waiter.reject(createCodexRuntimeError(timeoutReason)),
      normalizeCodexStageTimeout(timeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, MAX_HANDSHAKE_TIMEOUT_MS),
    )
  })
}

function createFatalRace({ getFatalReason, fatalWaiters }) {
  return (operation) => new Promise((resolve, reject) => {
    let settled = false
    const waiter = { reject: (error) => finish(error) }
    const finish = (error = null, value) => {
      if (settled) return
      settled = true
      fatalWaiters.delete(waiter)
      if (error) reject(error)
      else resolve(value)
    }
    Promise.resolve(operation).then(
      (value) => finish(null, value),
      (error) => finish(error),
    )
    const fatalReason = getFatalReason()
    if (fatalReason) finish(createCodexRuntimeError(fatalReason))
    else fatalWaiters.add(waiter)
  })
}

export function createProcessObserver(child, { onFatal }) {
  let lineReader = null
  let fatalReason = null
  let exited = false
  let unspawnedFailure = false
  const messageWaiters = new Set()
  const fatalWaiters = new Set()
  const exitWaiters = new Set()

  const rejectMessageWaiters = (reason) => {
    for (const waiter of [...messageWaiters]) waiter.reject(createCodexRuntimeError(reason))
  }

  const rejectFatalWaiters = (reason) => {
    for (const waiter of [...fatalWaiters]) waiter.reject(createCodexRuntimeError(reason))
  }

  const fail = (reason) => {
    if (fatalReason) return
    fatalReason = reason
    lineReader?.clear()
    rejectMessageWaiters(reason)
    rejectFatalWaiters(reason)
    try {
      const handling = onFatal?.(reason)
      Promise.resolve(handling).catch(() => {})
    } catch {
      // Runtime failure publication must never become an unhandled exception.
    }
  }

  const emitMessage = (message) => {
    for (const waiter of [...messageWaiters]) {
      let matches = false
      try { matches = waiter.predicate(message) === true } catch { /* invalid predicate */ }
      if (matches) waiter.resolve(message)
    }
  }

  lineReader = createCodexProtocolLineReader({ emitMessage, fail })
  const onStdoutData = (value) => {
    if (!fatalReason) lineReader.onData(value)
  }

  const markExited = () => {
    if (exited) return
    exited = true
    for (const resolve of [...exitWaiters]) resolve(true)
    exitWaiters.clear()
  }
  const onChildError = () => {
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) unspawnedFailure = true
    fail(CODEX_APP_SERVER_REASON.SPAWN_FAILED)
  }
  const onChildExit = () => {
    markExited()
    fail(CODEX_APP_SERVER_REASON.PROCESS_EXITED)
  }
  const onChildClose = () => {
    markExited()
    fail(CODEX_APP_SERVER_REASON.PROCESS_EXITED)
  }
  const onStreamError = () => fail(CODEX_APP_SERVER_REASON.PROCESS_EXITED)
  const onStdoutEnd = () => fail(CODEX_APP_SERVER_REASON.PROCESS_EXITED)

  child?.on?.('error', onChildError)
  child?.on?.('exit', onChildExit)
  child?.on?.('close', onChildClose)
  child?.stdin?.on?.('error', onStreamError)
  child?.stdout?.on?.('error', onStreamError)
  child?.stdout?.on?.('end', onStdoutEnd)
  child?.stdout?.on?.('data', onStdoutData)
  child?.stderr?.on?.('error', onStreamError)
  child?.stderr?.resume?.()

  const waitForMessage = createMessageWaiter({
    getFatalReason: () => fatalReason,
    messageWaiters,
  })

  const waitForExit = (timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) => {
    if (exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      let timer = null
      const finish = (value) => {
        if (timer) clearTimeout(timer)
        exitWaiters.delete(finish)
        resolve(value)
      }
      exitWaiters.add(finish)
      timer = setTimeout(
        () => finish(false),
        normalizeCodexStageTimeout(timeoutMs, DEFAULT_EXIT_TIMEOUT_MS),
      )
    })
  }

  const raceWithFatal = createFatalRace({
    getFatalReason: () => fatalReason,
    fatalWaiters,
  })

  const cleanup = () => {
    rejectMessageWaiters(CODEX_APP_SERVER_REASON.PROCESS_EXITED)
    rejectFatalWaiters(CODEX_APP_SERVER_REASON.PROCESS_EXITED)
    lineReader.clear()
    child?.off?.('error', onChildError)
    child?.off?.('exit', onChildExit)
    child?.off?.('close', onChildClose)
    child?.stdin?.off?.('error', onStreamError)
    child?.stdout?.off?.('error', onStreamError)
    child?.stdout?.off?.('end', onStdoutEnd)
    child?.stdout?.off?.('data', onStdoutData)
    child?.stderr?.off?.('error', onStreamError)
  }

  return Object.freeze({
    cleanup,
    raceWithFatal,
    waitForExit,
    waitForMessage,
    get exited() { return exited },
    get fatalReason() { return fatalReason },
    get unspawnedFailure() { return unspawnedFailure },
  })
}

function writeProtocolMessage(child, message, {
  signal,
  timeoutMs,
  timeoutReason = CODEX_APP_SERVER_REASON.HANDSHAKE_TIMEOUT,
}) {
  return new Promise((resolve, reject) => {
    if (!child?.stdin || typeof child.stdin.write !== 'function') {
      reject(createCodexRuntimeError(CODEX_APP_SERVER_REASON.SPAWN_FAILED))
      return
    }
    let settled = false
    let timer = null
    const finish = (error = null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(createCodexRuntimeError(CODEX_APP_SERVER_REASON.START_ABORTED))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(
      () => finish(createCodexRuntimeError(timeoutReason)),
      normalizeCodexStageTimeout(
        timeoutMs,
        DEFAULT_HANDSHAKE_TIMEOUT_MS,
        MAX_HANDSHAKE_TIMEOUT_MS,
      ),
    )
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) => {
        finish(error ? createCodexRuntimeError(CODEX_APP_SERVER_REASON.PROCESS_EXITED) : null)
      })
    } catch {
      finish(createCodexRuntimeError(CODEX_APP_SERVER_REASON.PROCESS_EXITED))
    }
  })
}

/**
 * Execute the one app-server request Gugo deliberately consumes. Keeping the
 * method and wire params inside this module prevents callers from turning the
 * bridge into an arbitrary JSON-RPC tunnel.
 */
export async function performModelListRequest(runtime, {
  cursor = null,
  limit = 20,
  includeHidden = false,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal = null,
} = {}) {
  const normalizedTimeout = normalizeCodexStageTimeout(
    timeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_HANDSHAKE_TIMEOUT_MS,
  )
  const requestId = `gugo-codex-model-list-${randomUUID()}`
  const linked = createLinkedAbortController(signal)
  const requestSignal = linked.controller.signal
  const captureOutcome = (operation) => Promise.resolve(operation).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  try {
    const responseOutcome = captureOutcome(runtime.observer.waitForMessage(
      (message) => message.id === requestId,
      {
        timeoutMs: normalizedTimeout,
        signal: requestSignal,
        timeoutReason: CODEX_APP_SERVER_REASON.REQUEST_TIMEOUT,
      },
    ))
    const writeOutcome = captureOutcome(runtime.observer.raceWithFatal(writeProtocolMessage(
      runtime.child,
      {
        method: 'model/list',
        id: requestId,
        params: {
          cursor,
          limit,
          includeHidden,
        },
      },
      {
        timeoutMs: normalizedTimeout,
        signal: requestSignal,
        timeoutReason: CODEX_APP_SERVER_REASON.REQUEST_TIMEOUT,
      },
    )))
    const first = await Promise.race([responseOutcome, writeOutcome])
    if (!first.ok) throw first.error
    const [responseResult, writeResult] = await Promise.all([responseOutcome, writeOutcome])
    if (!responseResult.ok) throw responseResult.error
    if (!writeResult.ok) throw writeResult.error

    const message = responseResult.value
    if (!isRpcResponseEnvelope(message, requestId)) {
      throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
    }
    if (Object.hasOwn(message, 'error')) {
      throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.REQUEST_REJECTED)
    }
    if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
      throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
    }
    return message.result
  } finally {
    linked.controller.abort()
    linked.cleanup()
  }
}

export async function performInitializeHandshake(runtime, { timeoutMs, signal }) {
  const normalized = normalizeCodexStageTimeout(
    timeoutMs,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
    MAX_HANDSHAKE_TIMEOUT_MS,
  )
  const deadline = Date.now() + normalized
  const requestId = `gugo-codex-initialize-${randomUUID()}`
  const linked = createLinkedAbortController(signal)
  const handshakeSignal = linked.controller.signal
  const captureOutcome = (operation, source) => Promise.resolve(operation).then(
    (value) => ({ ok: true, source, value }),
    (error) => ({ ok: false, source, error }),
  )
  try {
    // Attach rejection handlers at creation time. A malformed response can be
    // observed before a stalled stdin write callback, and leaving that response
    // promise temporarily unhandled can terminate Node under strict settings.
    const responseOutcome = captureOutcome(runtime.observer.waitForMessage(
      (message) => message.id === requestId,
      { timeoutMs: normalized, signal: handshakeSignal },
    ), 'response')
    const writeOutcome = captureOutcome(writeProtocolMessage(runtime.child, {
      method: 'initialize',
      id: requestId,
      params: {
        clientInfo: {
          name: 'gugo',
          title: 'Gugo',
          version: CLIENT_VERSION,
        },
      },
    }, { timeoutMs: normalized, signal: handshakeSignal }), 'write')

    const first = await Promise.race([responseOutcome, writeOutcome])
    if (!first.ok) throw first.error
    const [responseResult, writeResult] = await Promise.all([responseOutcome, writeOutcome])
    if (!responseResult.ok) throw responseResult.error
    if (!writeResult.ok) throw writeResult.error

    const message = responseResult.value
    if (!isRpcResponseEnvelope(message, requestId)) {
      throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
    }
    if (Object.hasOwn(message, 'error')) {
      throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.INITIALIZE_REJECTED)
    }
    if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
      throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.HANDSHAKE_TIMEOUT)
    }
    await runtime.observer.raceWithFatal(writeProtocolMessage(runtime.child, {
      method: 'initialized',
      params: {},
    }, { timeoutMs: remainingMs, signal: handshakeSignal }))
  } finally {
    linked.controller.abort()
    linked.cleanup()
  }
}

export function codexAppServerChildEnvironment(env, platform) {
  const childEnv = sanitizeChildEnv({}, { sourceEnv: env, platform })
  const blocked = new Set([
    'GUGO_CODEX_CLI_PATH',
    'CODEX_CLI_PATH',
    'CODEX_APP_SERVER_ENABLED',
    'CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS',
    'GUGO_CODEX_SIGNATURE_TARGET',
  ])
  for (const key of Object.keys(childEnv)) {
    if (blocked.has(key.toUpperCase())) delete childEnv[key]
  }
  return childEnv
}

export function createLinkedAbortController(signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener?.('abort', onAbort, { once: true })
  return {
    controller,
    cleanup: () => signal?.removeEventListener?.('abort', onAbort),
  }
}

export function waitForCodexOperation(operation, { signal, timeoutMs, timeoutReason }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(createCodexRuntimeError(CODEX_APP_SERVER_REASON.START_ABORTED))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(
      () => finish(createCodexRuntimeError(timeoutReason)),
      normalizeCodexStageTimeout(timeoutMs, timeoutMs),
    )
    Promise.resolve(operation).then(
      (value) => finish(null, value),
      () => finish(createCodexRuntimeError(timeoutReason)),
    )
  })
}

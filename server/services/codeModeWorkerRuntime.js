/**
 * Fresh-worker runtime for model-authored Code Mode snippets.
 *
 * A worker thread and VM context reduce ambient authority and bound CPU, heap,
 * wall time, and output. They are not an OS security boundary; do not expose
 * file, shell, network, or privileged tool bindings through this seam without
 * a separate fail-closed sandbox and the normal tool authorization pipeline.
 */
import { Worker } from 'node:worker_threads'

const DEFAULT_COMPUTE_MS = 1_000
const DEFAULT_MAX_WALL_MS = 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_MAX_OLD_GENERATION_MB = 32
const DEFAULT_MAX_CODE_BYTES = 64 * 1024
const MAX_COMPUTE_MS = 10_000
const MAX_WALL_MS = 30_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_CODE_BYTES = 256 * 1024

function boundedInteger(value, fallback, { minimum = 1, maximum }) {
  if (value == null) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return null
  return value
}

function resultError(kind, message, logs = []) {
  return Object.freeze({
    ok: false,
    logs: Object.freeze([...logs]),
    error: Object.freeze({ kind, message }),
  })
}

function resultSuccess(value, hasValue, logs) {
  return Object.freeze({
    ok: true,
    logs: Object.freeze([...logs]),
    ...(hasValue ? { value } : {}),
  })
}

function parseWorkerResult(message) {
  if (!message || typeof message !== 'object' || message.type !== 'done') return null
  const logs = Array.isArray(message.logs)
    && message.logs.every((entry) => typeof entry === 'string')
    ? message.logs
    : null
  if (!logs) return null
  if (message.error !== undefined) {
    const kind = message.error?.kind
    const text = message.error?.message
    const allowed = new Set([
      'invalid-request',
      'exception',
      'invalid-output',
      'output-limit',
      'timeout',
    ])
    if (!allowed.has(kind) || typeof text !== 'string') return null
    return resultError(kind, text, logs)
  }
  if (message.valueJson === undefined) return resultSuccess(undefined, false, logs)
  if (typeof message.valueJson !== 'string') return null
  try {
    return resultSuccess(JSON.parse(message.valueJson), true, logs)
  } catch {
    return null
  }
}

function abortMessage(signal) {
  return signal?.reason instanceof Error && signal.reason.name === 'AbortError'
    ? 'Code execution was cancelled'
    : 'Code execution was cancelled'
}

export async function runCodeModeWorker({
  code,
  signal = null,
  computeMs = DEFAULT_COMPUTE_MS,
  maxWallMs = DEFAULT_MAX_WALL_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxOldGenerationSizeMb = DEFAULT_MAX_OLD_GENERATION_MB,
  maxCodeBytes = DEFAULT_MAX_CODE_BYTES,
  WorkerClass = Worker,
} = {}) {
  if (typeof code !== 'string' || !code.trim()) {
    return resultError('invalid-request', 'Code must be a non-empty string')
  }
  const resolvedCodeLimit = boundedInteger(maxCodeBytes, DEFAULT_MAX_CODE_BYTES, {
    maximum: MAX_CODE_BYTES,
  })
  const resolvedComputeMs = boundedInteger(computeMs, DEFAULT_COMPUTE_MS, {
    maximum: MAX_COMPUTE_MS,
  })
  const resolvedWallMs = boundedInteger(maxWallMs, DEFAULT_MAX_WALL_MS, {
    maximum: MAX_WALL_MS,
  })
  const resolvedOutputLimit = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, {
    minimum: 64,
    maximum: MAX_OUTPUT_BYTES,
  })
  const resolvedHeapMb = boundedInteger(
    maxOldGenerationSizeMb,
    DEFAULT_MAX_OLD_GENERATION_MB,
    { minimum: 16, maximum: 256 },
  )
  if (!resolvedCodeLimit || !resolvedComputeMs || !resolvedWallMs
    || !resolvedOutputLimit || !resolvedHeapMb) {
    return resultError('invalid-request', 'Code Mode resource limits are invalid')
  }
  if (Buffer.byteLength(code, 'utf8') > resolvedCodeLimit) {
    return resultError('invalid-request', `Code exceeds ${resolvedCodeLimit} bytes`)
  }
  if (signal !== null
    && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
    return resultError('invalid-request', 'signal must be an AbortSignal')
  }
  if (signal?.aborted) return resultError('cancelled', abortMessage(signal))

  let worker
  try {
    worker = new WorkerClass(new URL('./codeModeWorkerThread.js', import.meta.url), {
      workerData: {
        code,
        computeMs: resolvedComputeMs,
        maxOutputBytes: resolvedOutputLimit,
      },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: resolvedHeapMb,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      },
    })
  } catch {
    return resultError('worker-start', 'Code worker could not be started')
  }

  worker.stdout?.resume?.()
  worker.stderr?.resume?.()

  return new Promise((resolve) => {
    let settling = false
    let wallTimer = null
    let computeTimer = null
    let workerStarted = false
    let computeBaseline = null

    const cleanup = () => {
      if (wallTimer) clearTimeout(wallTimer)
      if (computeTimer) clearInterval(computeTimer)
      signal?.removeEventListener?.('abort', onAbort)
      worker.removeListener('message', onMessage)
      worker.removeListener('error', onError)
      worker.removeListener('exit', onExit)
    }
    const settle = async (result) => {
      if (settling) return
      settling = true
      cleanup()
      try { await worker.terminate() } catch { /* exit is already terminal */ }
      resolve(result)
    }
    const onAbort = () => {
      void settle(resultError('cancelled', abortMessage(signal)))
    }
    const onMessage = (message) => {
      if (message?.type === 'ready') {
        if (workerStarted
          || typeof worker.performance?.eventLoopUtilization !== 'function') {
          void settle(resultError('protocol-invalid', 'Code worker returned an invalid response'))
          return
        }
        workerStarted = true
        computeBaseline = worker.performance.eventLoopUtilization()
        computeTimer = setInterval(() => {
          if (settling || !computeBaseline) return
          let current
          try {
            current = worker.performance.eventLoopUtilization()
          } catch {
            void settle(resultError('worker-exit', 'Code worker utilization could not be measured'))
            return
          }
          if (Number.isFinite(current?.active)
            && current.active - computeBaseline.active >= resolvedComputeMs) {
            void settle(resultError('timeout', 'Code compute budget exceeded'))
          }
        }, 10)
        computeTimer.unref?.()
        try {
          worker.postMessage({ type: 'start' })
        } catch {
          void settle(resultError('worker-exit', 'Code worker exited before execution started'))
        }
        return
      }
      const result = parseWorkerResult(message)
      void settle(result || resultError('protocol-invalid', 'Code worker returned an invalid response'))
    }
    const onError = () => {
      void settle(resultError('worker-exit', 'Code worker exited before producing a result'))
    }
    const onExit = () => {
      if (!settling) void settle(resultError('worker-exit', 'Code worker exited before producing a result'))
    }

    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    wallTimer = setTimeout(() => {
      void settle(resultError('timeout', 'Code wall-clock budget exceeded'))
    }, resolvedWallMs)
    wallTimer.unref?.()
    if (signal?.aborted) onAbort()
  })
}

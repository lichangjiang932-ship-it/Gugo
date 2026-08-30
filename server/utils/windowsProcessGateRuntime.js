import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { prepareWindowsTreeKillWorker } from './windowsTreeKillRuntime.js'

export const WINDOWS_PROCESS_GATE_PROTOCOL = 'gugo.windows-process-gate.v1'

export const WINDOWS_PROCESS_GATE_PATH = fileURLToPath(
  new URL('./windowsProcessGateChild.js', import.meta.url),
)

const WINDOWS_PROCESS_GATE_ENV_DENYLIST = new Set([
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
  'NODE_UNIQUE_ID',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
])

const DEFAULT_PROCESS_TIMEOUT_MS = 60_000

function beforeWindowsExecutionResult(options, {
  error = null,
  aborted = false,
  timedOut = false,
} = {}) {
  const errorMessage = error ? (error?.message || String(error)) : null
  return {
    stdout: '',
    stderr: errorMessage || '',
    code: null,
    signal: null,
    timedOut,
    killed: false,
    processStartFailed: false,
    processStartError: null,
    processIsolationFailed: Boolean(errorMessage && !aborted && !timedOut),
    processIsolationError: errorMessage,
    processTreeCleanupFailed: false,
    truncated: false,
    aborted,
    totalOutputBytes: 0,
    ...(options?.controlPipe === true
      ? {
          control: Buffer.alloc(0),
          controlError: null,
          controlTruncated: false,
          controlTotalBytes: 0,
        }
      : {}),
  }
}

export function windowsProcessGateEnv(targetEnv) {
  const gateEnv = {}
  for (const [key, value] of Object.entries(targetEnv || {})) {
    if (WINDOWS_PROCESS_GATE_ENV_DENYLIST.has(key.toUpperCase())) continue
    gateEnv[key] = value
  }
  gateEnv.ELECTRON_RUN_AS_NODE = '1'
  return gateEnv
}

export function prepareWindowsProcessExecution(options, startExecution) {
  if (options?.signal?.aborted) return startExecution(options)
  const requestedTimeout = options?.timeout == null
    ? DEFAULT_PROCESS_TIMEOUT_MS
    : Math.max(0, Math.floor(Number(options.timeout) || 0))
  if (requestedTimeout <= 0) {
    return Promise.resolve(beforeWindowsExecutionResult(options, { timedOut: true }))
  }
  const startedAt = performance.now()
  return prepareWindowsTreeKillWorker({
    signal: options?.signal || null,
    timeoutMs: requestedTimeout,
  }).then(
    () => {
      if (options?.signal?.aborted) return startExecution(options)
      const elapsed = performance.now() - startedAt
      const remainingTimeout = Math.max(0, Math.floor(requestedTimeout - elapsed))
      if (remainingTimeout <= 0) {
        return beforeWindowsExecutionResult(options, { timedOut: true })
      }
      return startExecution({ ...options, timeout: remainingTimeout })
    },
    (error) => {
      const aborted = Boolean(
        options?.signal?.aborted
        || error?.code === 'WINDOWS_TREE_KILL_WORKER_READY_ABORTED'
      )
      const timedOut = !aborted && error?.code === 'WINDOWS_TREE_KILL_WORKER_READY_TIMEOUT'
      return beforeWindowsExecutionResult(options, {
        error: aborted || timedOut ? null : error,
        aborted,
        timedOut,
      })
    },
  )
}

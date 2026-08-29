export const DESKTOP_PARENT_GUARD_MODE = 'ipc-v1'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000
const MAX_SHUTDOWN_TIMEOUT_MS = 60_000
const INACTIVE_GUARD = Object.freeze({
  active: false,
  dispose() {
    return false
  },
})

function validateTimeoutMs(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SHUTDOWN_TIMEOUT_MS) {
    throw new TypeError('desktop parent guard timeoutMs must be an integer between 1 and 60000')
  }
  return timeoutMs
}

function normalizeExitCode(value) {
  return value === 0 ? 0 : 1
}

/**
 * Keep the packaged backend owned by Electron even when the Electron process
 * crashes or is terminated without emitting `before-quit`. Node's dedicated
 * IPC channel is closed by the operating system on every parent-exit path, so
 * the child receives `disconnect` without PID polling or PID-reuse hazards.
 */
export function bindDesktopParentGuard({
  mode = process.env.GUGO_DESKTOP_PARENT_GUARD,
  processTarget = process,
  requestShutdown,
  exitProcess = (code) => process.exit(code),
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  logger = console,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (mode !== DESKTOP_PARENT_GUARD_MODE) return INACTIVE_GUARD
  if (!processTarget
    || typeof processTarget.once !== 'function'
    || typeof processTarget.off !== 'function') {
    throw new TypeError('desktop parent guard processTarget must expose once() and off()')
  }
  if (typeof requestShutdown !== 'function') {
    throw new TypeError('desktop parent guard requestShutdown must be a function')
  }
  if (typeof exitProcess !== 'function') {
    throw new TypeError('desktop parent guard exitProcess must be a function')
  }
  if (typeof schedule !== 'function' || typeof cancel !== 'function') {
    throw new TypeError('desktop parent guard timer functions are required')
  }
  validateTimeoutMs(timeoutMs)

  let disconnected = false
  let disposed = false
  let completed = false
  let timeout = null

  const detach = () => {
    processTarget.off('disconnect', onDisconnect)
  }

  const finish = (code) => {
    if (completed) return
    completed = true
    if (timeout) {
      cancel(timeout)
      timeout = null
    }
    detach()
    exitProcess(normalizeExitCode(code))
  }

  function onDisconnect() {
    if (disposed || disconnected || completed) return
    disconnected = true
    detach()
    timeout = schedule(() => finish(1), timeoutMs)
    void Promise.resolve()
      .then(() => requestShutdown('desktop_parent_disconnected'))
      .then(
        (code) => finish(code),
        (error) => {
          try {
            logger?.error?.('[desktop] parent disconnect shutdown failed:', error?.message || error)
          } catch { /* diagnostics cannot prevent the bounded exit */ }
          finish(1)
        },
      )
  }

  processTarget.once('disconnect', onDisconnect)
  // Electron can disappear after spawning the backend but before this module
  // evaluates. Register first, then close that race by checking the channel.
  if (processTarget.connected === false) queueMicrotask(onDisconnect)

  return Object.freeze({
    active: true,
    dispose() {
      if (disposed || disconnected || completed) return false
      disposed = true
      detach()
      processTarget.channel?.unref?.()
      return true
    },
  })
}

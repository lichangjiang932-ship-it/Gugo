import { terminateProcessTree } from '../utils/processGroup.js'
import {
  CODEX_APP_SERVER_REASON,
  DEFAULT_EXIT_TIMEOUT_MS,
  DEFAULT_TERMINATE_TIMEOUT_MS,
} from './codexAppServerContracts.js'
import { waitForCodexOperation } from './codexAppServerProcess.js'

async function finalizeRuntime(runtime, { signal, cleanupTimeoutMs }) {
  runtime.closed = true
  runtime.ready = false
  runtime.phase = 'closed'
  runtime.observer?.cleanup?.()
  try { runtime.child?.stdin?.destroy?.() } catch { /* process is already gone */ }
  try { runtime.child?.stdout?.destroy?.() } catch { /* process is already gone */ }
  try { runtime.child?.stderr?.destroy?.() } catch { /* process is already gone */ }
  const executableSnapshot = runtime.executableSnapshot
  runtime.executableSnapshot = null
  if (executableSnapshot) {
    await boundedShutdownStep(
      Promise.resolve().then(() => executableSnapshot.cleanup?.()),
      { signal, timeoutMs: cleanupTimeoutMs },
    )
  }
}

async function boundedShutdownStep(operation, { signal, timeoutMs }) {
  try {
    return await waitForCodexOperation(operation, {
      signal,
      timeoutMs,
      timeoutReason: CODEX_APP_SERVER_REASON.TERMINATION_FAILED,
    })
  } catch {
    return false
  }
}

export async function disposeCodexAppServerRuntime(runtime, {
  terminate = terminateProcessTree,
  exitTimeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
  terminateTimeoutMs = DEFAULT_TERMINATE_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (!runtime || runtime.closed) return true
  if (runtime.disposing) {
    return boundedShutdownStep(runtime.disposing, {
      signal,
      timeoutMs: terminateTimeoutMs + exitTimeoutMs,
    })
  }
  const operation = (async () => {
    runtime.ready = false
    runtime.phase = 'stopping'
    if (runtime.observer?.exited) {
      await finalizeRuntime(runtime, { signal, cleanupTimeoutMs: exitTimeoutMs })
      return true
    }
    if (runtime.observer?.unspawnedFailure) {
      const closed = await boundedShutdownStep(runtime.observer.waitForExit(exitTimeoutMs), {
        signal, timeoutMs: exitTimeoutMs,
      })
      if (!closed) {
        runtime.phase = 'failed'
        return false
      }
      await finalizeRuntime(runtime, { signal, cleanupTimeoutMs: exitTimeoutMs })
      return true
    }
    const terminated = await boundedShutdownStep(
      Promise.resolve().then(() => terminate({
        pid: runtime.child?.pid,
        child: runtime.child,
        signal,
      })),
      { signal, timeoutMs: terminateTimeoutMs },
    ) === true
    if (!terminated) {
      runtime.phase = 'failed'
      return false
    }
    const exited = await boundedShutdownStep(runtime.observer.waitForExit(exitTimeoutMs), {
      signal, timeoutMs: exitTimeoutMs,
    })
    if (!exited) {
      runtime.phase = 'failed'
      return false
    }
    await finalizeRuntime(runtime, { signal, cleanupTimeoutMs: exitTimeoutMs })
    return true
  })()
  runtime.disposing = operation
  const result = await operation
  runtime.disposing = null
  return result
}

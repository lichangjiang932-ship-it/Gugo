import {
  CODEX_APP_SERVER_REASON,
  createCodexRuntimeError,
} from './codexAppServerContracts.js'
import {
  createLinkedAbortController,
  waitForCodexOperation,
} from './codexAppServerProcess.js'

export async function cleanupCodexExecutableSnapshot(snapshot, timeoutMs) {
  if (!snapshot || typeof snapshot.cleanup !== 'function') return
  try {
    await waitForCodexOperation(
      Promise.resolve().then(() => snapshot.cleanup()),
      {
        signal: null,
        timeoutMs,
        timeoutReason: CODEX_APP_SERVER_REASON.TERMINATION_FAILED,
      },
    )
  } catch {
    // Snapshot cleanup is best effort and remains detached after its deadline.
  }
}

export async function runBoundedCodexStartStage(operationFactory, {
  signal,
  timeoutMs,
  timeoutReason,
  onLateValue = null,
}) {
  const linked = createLinkedAbortController(signal)
  const stageSignal = linked.controller.signal
  const operation = Promise.resolve().then(() => {
    assertCodexStartActive(stageSignal)
    return operationFactory(stageSignal)
  })
  try {
    return await waitForCodexOperation(operation, {
      signal,
      timeoutMs,
      timeoutReason,
    })
  } catch (error) {
    linked.controller.abort(error)
    if (typeof onLateValue === 'function') {
      void operation.then(onLateValue, () => {})
    }
    throw error
  } finally {
    linked.controller.abort()
    linked.cleanup()
  }
}

export function assertCodexStartActive(signal) {
  if (signal.aborted) {
    throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.START_ABORTED)
  }
}

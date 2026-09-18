import { runResultSucceeded } from './runDiagnostics.js'

/**
 * Decide whether a tripped local deadline may replace the runtime outcome.
 *
 * The deadline is a local wall clock; the runtime state machine owns terminal
 * semantics. A deadline therefore only explains an outcome that has no more
 * specific terminal evidence of its own:
 * - success (completed + observed turn.completed) is kept: a finished turn is
 *   more specific than the clock, and replacing it would contradict the
 *   persisted terminal state;
 * - failed / blocked / unknown terminals are kept: each is more specific than
 *   a local deadline;
 * - only a cooperative cancellation with no other terminal event is replaced,
 *   because the deadline is the only available explanation for it.
 */
export function timeoutReplacesResult(result, observedTerminal) {
  if (runResultSucceeded(result, observedTerminal)) return false
  if (result?.status !== 'cancelled') return false
  return [result.lastEvent, observedTerminal].every((event) => !event || event.type === 'turn.cancelled')
}

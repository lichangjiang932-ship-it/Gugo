import { CliError } from './errors.js'
import { completedEventSucceeded, completionIsExplicitlyIncomplete, runResultSucceeded,
  isFinalRunTerminal, runOutcomeConflictError, runTerminalsConflict, terminalDescriptor } from './runDiagnostics.js'

const TRANSIENT_PHASES = new Set(['turn.waiting', 'turn.awaiting_approval'])

function specificCancellation(source = {}) {
  if (!source || typeof source !== 'object') return false
  const code = source.code || source.error?.code
  const reason = source.incompleteReason || source.error?.incompleteReason
  return Boolean((code && !['TURN_CANCELLED', 'CLI_RUN_TIMEOUT'].includes(code))
    || (reason && !['turn_incomplete', 'turn_cancelled', 'cancelled', 'run_timeout'].includes(reason))
    || source.recoveryKind || source.recovery || source.unsafeToReplay || source.requiresUserVerification)
}

function specificStoppedTerminal(event) {
  return event?.type?.startsWith('turn.') && !TRANSIENT_PHASES.has(event.type)
    && Boolean(terminalDescriptor(event))
    && (event.type !== 'turn.cancelled' || specificCancellation(event.payload))
}

function terminalResult(event, result = {}) {
  return {
    ...result,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    status: event.type === 'turn.completed' ? 'incomplete' : event.type.slice('turn.'.length),
    exitCode: Number.isInteger(result?.exitCode) && result.exitCode !== 0 ? result.exitCode : 1,
    lastEvent: event,
  }
}

/**
 * Decide whether a tripped local deadline may replace the runtime outcome.
 *
 * The deadline is a local wall clock; the runtime state machine owns terminal
 * semantics. A deadline therefore only explains an outcome that has no more
 * specific terminal evidence of its own:
 * - false does not itself prove success or reconcile contradictory outcomes;
 *   resolveRunDeadlineOutcome applies that evidence check before formatting;
 * - failed / blocked / unknown terminals are kept: each is more specific than
 *   a local deadline;
 * - only a cooperative cancellation with no other terminal event is replaced,
 *   because the deadline is the only available explanation for it.
 */
export function timeoutReplacesResult(result, observedTerminal) {
  if (runResultSucceeded(result, observedTerminal)) return false
  if (result?.status !== 'cancelled' || specificCancellation(result)) return false
  return [result.lastEvent, observedTerminal].every((event) => !event || TRANSIENT_PHASES.has(event.type)
    || (event.type === 'turn.cancelled' && !specificCancellation(event.payload)))
}

/** Called only after this exact local deadline won cancellation, never for an external abort. */
export function resolveRunDeadlineOutcome({ result, error, didThrow = false, timeoutError,
  observedTerminal = null, terminalConflict = false }) {
  if (didThrow) {
    if (error !== timeoutError) return { error }
    if (terminalConflict || completedEventSucceeded(observedTerminal)) return { error: runOutcomeConflictError(observedTerminal) }
    if (specificStoppedTerminal(observedTerminal)) return { result: terminalResult(observedTerminal) }
    return { error }
  }
  if (terminalConflict || runTerminalsConflict(result?.lastEvent, observedTerminal)) return { error: runOutcomeConflictError(observedTerminal) }
  const completion = completedEventSucceeded(result?.lastEvent) || completedEventSucceeded(observedTerminal)
  if (completion && (!result || !runResultSucceeded(result, observedTerminal))) {
    return { error: runOutcomeConflictError(observedTerminal || result?.lastEvent) }
  }
  const candidates = [result?.lastEvent, observedTerminal]
  const stopped = candidates.find((event) => isFinalRunTerminal(event) && specificStoppedTerminal(event))
    || candidates.find(specificStoppedTerminal)
  if (stopped && !completion) return { result: terminalResult(stopped, result) }
  if (completionIsExplicitlyIncomplete(result) && result?.status !== 'cancelled') {
    return { result: { ...result, status: result.status === 'completed' ? 'incomplete' : result.status,
      exitCode: Number.isInteger(result.exitCode) && result.exitCode !== 0 ? result.exitCode : 1 } }
  }
  if (timeoutReplacesResult(result, observedTerminal)) return { error: timeoutError }
  if (runResultSucceeded(result, observedTerminal) && !completion) {
    return { error: new CliError('CLI_RUN_TERMINAL_MISSING', 'runtime success after the deadline has no completed terminal evidence') }
  }
  return { result }
}

import { logWarn } from '../utils/logger.js'

/**
 * Canary terminal-outcome recording, extracted from the TurnEngine
 * compatibility shell (KERNEL_BOUNDARY transition debt).
 *
 * Evolution telemetry is host-owned and strictly optional: a canary recording
 * failure must never fail the turn. The engine supplies the live run context
 * explicitly on every call because usage counters and the canary assignment
 * mutate during execution.
 */
export function createTurnCanaryOutcomeRuntime({ deps }) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('turnCanaryOutcomeRuntime requires deps')
  }
  return async function recordCanaryTerminal({
    canaryAssignment,
    userId,
    sessionId,
    turnId,
    effectiveTurnStartedAt,
    turnModelUsage = null,
    latestModelUsage = null,
    modelProviderId = null,
    modelName = null,
    modelConfigRevision = null,
    evaluationInput = '',
    terminalState,
    errorCode = null,
    completedAt,
    evaluationOutput = '',
  }) {
    if (!canaryAssignment?.id) return
    try {
      await deps.recordCanaryOutcome({
        userId,
        sessionId,
        turnId,
        terminalState,
        durationMs: Math.max(0, completedAt - effectiveTurnStartedAt),
        usage: turnModelUsage || latestModelUsage,
        errorCode,
        effectiveVariant: canaryAssignment.variant,
        decisionReason: canaryAssignment.decisionReason,
        modelProviderId,
        modelName,
        modelConfigRevision,
        evaluationInput,
        evaluationOutput,
        env: deps.env,
        now: completedAt,
      })
    } catch (error) {
      try { logWarn('evolution.canary.outcome', error, { userId, sessionId, turnId }) } catch { /* optional */ }
    }
  }
}

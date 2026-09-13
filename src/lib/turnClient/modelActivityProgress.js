import { normalizeModelPhaseProgress } from '../../../shared/modelPhaseProgress.js'

/** Only public counters and timing cross from the model stream into UI state. */
export function modelActivityFromPhase(payload = {}, createdAt) {
  const progress = normalizeModelPhaseProgress(payload)
  const at = typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null
  const startedAt = at !== null && Number.isFinite(progress.elapsedMs) && at - progress.elapsedMs > 0
    ? at - progress.elapsedMs : undefined
  return {
    kind: payload.phase === 'tool_arguments' ? 'tool_arguments'
      : payload.phase === 'streaming' ? 'responding' : 'model',
    phase: payload.phase,
    iteration: payload.iteration,
    ...progress,
    ...(startedAt !== undefined ? { startedAt } : {}),
  }
}

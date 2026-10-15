import { estimateContextTokens } from '../contextCompactionMetrics.js'
import { normalizeOptionalUsageNumber } from '../../../shared/modelUsage.js'
import { modelContextUsageSchema } from '../../../shared/modelContextUsage.js'
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null
const name = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null

/** Reuse the assembled conversation; observing never prepares prompts or calls a model. */
function buildContextUsageObservation(state, { stage, messages = state.convo, tools = state.activeToolSpecs, inputTokens } = {}) {
  const invocation = state.modelInvocation, attempt = invocation?.providerAttempts?.at(-1)
  const restored = modelContextUsageSchema.safeParse(state.modelContextUsage || state.restoredState?.requestDiagnostics?.modelContextUsage)
  const old = restored.success && (restored.data.requestId === invocation?.id || (!invocation && stage === 'retained')) ? restored.data : null
  const estimated = Math.max(0, Math.ceil(estimateContextTokens(messages || [], tools || [])))
  const measured = normalizeOptionalUsageNumber(inputTokens)
  const inputEstimate = stage === 'prepared' ? estimated : old?.inputEstimatedTokens ?? null
  const actualInput = measured === null ? old?.inputTokens ?? null : Math.floor(measured)
  const modelName = name(attempt?.modelName) ?? old?.modelName ?? null, providerId = name(attempt?.providerId) ?? old?.providerId ?? null
  const configuredModelName = name(state.job?.modelName), configuredProviderId = name(state.job?.modelProviderId)
  const sameRoute = modelName === configuredModelName && (providerId === configuredProviderId || (configuredProviderId === null && attempt?.failoverIndex === 0))
  const value = { version: 1, stage, requestId: name(invocation?.id) ?? old?.requestId ?? null, physicalAttempt: positive(attempt?.sequence) ?? old?.physicalAttempt ?? null,
    modelName, providerId, configuredModelName, configuredProviderId, configRevision: positive(invocation?.configRevision) ?? old?.configRevision ?? null,
    contextWindow: invocation ? (sameRoute ? positive(state.contextWindow) : null) : old?.contextWindow ?? null,
    inputEstimatedTokens: inputEstimate, inputTokens: actualInput,
    retainedEstimatedTokens: stage === 'retained'
      ? Math.max(0, actualInput !== null && inputEstimate !== null ? actualInput + estimated - inputEstimate : estimated) : null }
  const parsed = modelContextUsageSchema.safeParse(value)
  if (!parsed.success) return null
  state.modelContextUsage = parsed.data
  return parsed.data
}

export function contextUsageObservation(state, options) {
  try { return buildContextUsageObservation(state, options) } catch { return null }
}

export async function publishContextUsage(state, options) {
  let observation
  try { observation = contextUsageObservation(state, options) } catch { return }
  if (observation && typeof state.onModelPhase === 'function') {
    await state.onModelPhase({ phase: 'context_usage', iteration: state.iter, contextUsage: observation })
  }
}

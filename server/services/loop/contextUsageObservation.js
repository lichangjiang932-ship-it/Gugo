import { estimateContextTokens } from '../contextCompactionMetrics.js'
import { normalizeOptionalUsageNumber } from '../../../shared/modelUsage.js'
import { modelContextUsageSchema } from '../../../shared/modelContextUsage.js'
import { createStreamingTextTokenCounter } from '../../../shared/textTokenEstimate.js'
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null
const name = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null

/** Reuse the assembled conversation; observing never prepares prompts or calls a model. */
function buildContextUsageObservation(state, { stage, messages = state.convo, tools = state.activeToolSpecs, inputTokens, outputEstimatedTokens } = {}) {
  const invocation = state.modelInvocation, attempt = invocation?.providerAttempts?.at(-1)
  const restored = modelContextUsageSchema.safeParse(state.modelContextUsage || state.restoredState?.requestDiagnostics?.modelContextUsage)
  const old = restored.success && ((restored.data.requestId === invocation?.id && restored.data.physicalAttempt === attempt?.sequence)
    || (!invocation && stage === 'retained')) ? restored.data : null
  const streaming = normalizeOptionalUsageNumber(outputEstimatedTokens)
  const estimated = streaming !== null && old?.inputEstimatedTokens != null
    ? old.inputEstimatedTokens : Math.max(0, Math.ceil(estimateContextTokens(messages || [], tools || [])))
  const measured = normalizeOptionalUsageNumber(inputTokens)
  const inputEstimate = stage === 'prepared'
    ? (streaming === null ? estimated : old?.inputEstimatedTokens ?? estimated)
    : old?.inputEstimatedTokens ?? null
  const actualInput = measured === null ? old?.inputTokens ?? null : Math.floor(measured)
  const modelName = name(attempt?.modelName) ?? old?.modelName ?? null, providerId = name(attempt?.providerId) ?? old?.providerId ?? null
  const configuredModelName = name(state.job?.modelName), configuredProviderId = name(state.job?.modelProviderId)
  const primaryBinding = attempt?.failoverIndex === 0
    && (configuredProviderId === null || invocation?.providerId === configuredProviderId)
  const sameRoute = modelName === configuredModelName && (providerId === configuredProviderId || primaryBinding)
  const value = { version: 1, stage, requestId: name(invocation?.id) ?? old?.requestId ?? null, physicalAttempt: positive(attempt?.sequence) ?? old?.physicalAttempt ?? null,
    modelName, providerId, configuredModelName, configuredProviderId, configRevision: positive(invocation?.configRevision) ?? old?.configRevision ?? null,
    contextWindow: invocation ? (sameRoute ? positive(state.contextWindow) : null) : old?.contextWindow ?? null,
    inputEstimatedTokens: inputEstimate, inputTokens: actualInput,
    retainedEstimatedTokens: streaming !== null ? Math.max(0, (actualInput ?? inputEstimate) + Math.ceil(streaming))
      : stage === 'retained' || stage === 'completed'
        ? Math.max(0, actualInput !== null && inputEstimate !== null ? actualInput + estimated - inputEstimate : estimated) : null }
  const parsed = modelContextUsageSchema.safeParse(value)
  if (!parsed.success) return null
  state.modelContextUsage = parsed.data
  return parsed.data
}

export function contextUsageObservation(state, options) {
  try { return buildContextUsageObservation(state, options) } catch { return null }
}

export function observeContextTextDeltas(state, publishText, { now = Date.now, minInterval = 1000 } = {}) {
  const count = createStreamingTextTokenCounter()
  let last = -Infinity
  return async (text, metadata) => {
    const outputEstimatedTokens = count(text)
    const result = await publishText(text, metadata)
    const time = now()
    if (text && !state.signal?.aborted && time - last >= minInterval) {
      last = time
      await publishContextUsage(state, { stage: 'prepared', outputEstimatedTokens })
    }
    return result
  }
}

export async function publishContextUsage(state, options) {
  let observation
  try { observation = contextUsageObservation(state, options) } catch { return }
  if (observation && typeof state.onModelPhase === 'function') {
    await state.onModelPhase({ phase: 'context_usage', iteration: state.iter, contextUsage: observation })
  }
}

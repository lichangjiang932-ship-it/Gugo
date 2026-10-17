import { modelContextUsageSchema } from '../../shared/modelContextUsage.js'
import { estimateClientContextUsage, normalizeOptionalTokenCount } from './contextUsage.js'
const count = normalizeOptionalTokenCount
const windowSize = value => count(value) > 0 ? Math.floor(Number(value)) : null

/** Display staleness guard, not a security hash. Cache numbers only, never copies of message text. */
export function createContextHistoryGuard() {
  const hashes = new WeakMap()
  let key = null, signature = '', valid = false
  const digest = message => {
    if (hashes.has(message)) return hashes.get(message)
    const value = JSON.stringify([message.id, message.role, message.content, message.tool_calls || message.meta?.toolCalls || [], message.attachments || message.meta?.attachments || []])
    let hash = 2166136261
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
    const result = `${value.length}:${hash >>> 0}`
    hashes.set(message, result)
    return result
  }
  return (nextKey, messages) => {
    const next = messages.map(digest).join('|')
    if (key !== nextKey) { key = nextKey; signature = next; valid = true }
    else if (signature !== next) valid = false
    return valid
  }
}

/** Keep numeric streaming anchors per fenced request, never message copies. */
export function createStreamingContextAnchor() {
  const anchors = new Map()
  return (scope, value, visibleTokens) => {
    const parsed = modelContextUsageSchema.safeParse(value)
    if (!parsed.success || parsed.data.stage !== 'prepared' || !parsed.data.requestId || !parsed.data.physicalAttempt) return 0
    const key = JSON.stringify([scope, parsed.data.requestId, parsed.data.physicalAttempt, parsed.data.retainedEstimatedTokens])
    if (!anchors.has(key)) {
      anchors.set(key, visibleTokens)
      if (anchors.size > 32) anchors.delete(anchors.keys().next().value)
    }
    return Math.max(0, visibleTokens - anchors.get(key))
  }
}

export function observationMatchesSelection(observation, options) {
  const configured = observation?.configuredProviderId ?? ''
  const selected = options.selectedModelProviderId || ''
  // A primary runtime key can differ from the durable UI Provider ID. The
  // authenticated host supplies a window only after validating that binding;
  // failover observations intentionally carry no configured-route window.
  const routeMatches = observation?.providerId === selected
    || (configured === selected && windowSize(observation?.contextWindow) !== null)
  return Boolean(observation && observation.modelName && observation.providerId && routeMatches
    && observation.modelName === options.selectedModel
    && observation.configuredModelName === options.selectedModel && configured === selected
    && (count(observation.configRevision) ?? null) === (count(options.selectedConfigRevision) ?? null))
}

export function buildPendingContextUsage(options) {
  const { messages = [], tools = [], systemPrompt = '', input = '', attachments = [], estimate = estimateClientContextUsage } = options
  const base = estimate({ messages, tools, systemPrompt, contextWindow: options.contextWindow })
  const pending = input || attachments.length ? [...messages, { role: 'user', content: input, attachments }] : messages
  const local = pending === messages ? base : estimate({ messages: pending, tools, systemPrompt, contextWindow: options.contextWindow })
  const draftTokens = Math.max(0, local.estimatedTokens - base.estimatedTokens)
  const parsed = modelContextUsageSchema.safeParse(options.observation)
  const observation = parsed.success ? parsed.data : null
  const comparable = observationMatchesSelection(observation, options)
  const observedTokens = count(observation?.retainedEstimatedTokens)
    ?? (observation?.stage === 'prepared' ? count(observation.inputEstimatedTokens) : null)
  const host = comparable && options.allowServerBaseline === true && observedTokens !== null
  const tail = options.tailMessages?.length ? Math.max(0, estimate({ messages: options.tailMessages }).estimatedTokens - estimate({ messages: [] }).estimatedTokens) : 0
  const liveDelta = observation?.stage === 'prepared' ? count(options.observationDeltaTokens) ?? 0 : 0
  const usedTokens = host ? observedTokens + draftTokens + tail + liveDelta : local.estimatedTokens
  const serverWindow = comparable ? windowSize(observation.contextWindow) : null
  // A catalogue/default window is still a real denominator for the reader: it
  // is what compaction plans with. It is marked estimated rather than hidden,
  // because "unknown" alongside a 14% reading was the confusing state.
  const catalogWindow = options.contextWindowKnown === false ? null : windowSize(options.contextWindow)
  const contextWindow = serverWindow ?? catalogWindow
  const contextWindowEstimated = contextWindow !== null
    && serverWindow === null
    && (options.contextWindowEstimated === true || options.contextWindowAuthoritative === false)
  const contextWindowSource = serverWindow !== null
    ? 'server'
    : contextWindow !== null
      ? String(options.contextWindowSource || (contextWindowEstimated ? 'catalog_estimate' : 'catalog'))
      : 'unknown'
  const unknownAttachments = attachments.filter(item => !item || typeof item.text !== 'string' || item.truncated === true || /image/i.test(item.kind || item.type || '')).length
  return { ...local, meter: { version: 1, usedTokens, estimated: true, source: host ? 'retained_estimate' : 'client_estimate',
    contextWindow, contextWindowKnown: contextWindow !== null, contextWindowEstimated, contextWindowSource,
    windowSource: contextWindowSource,
    percent: contextWindow ? usedTokens / contextWindow * 100 : null, draftTokens, unknownAttachments,
    coverage: 'partial', lastRequest: { inputTokens: observation?.inputTokens ?? count(options.actualPromptTokens),
      estimatedInputTokens: observation?.inputEstimatedTokens ?? count(options.serverEstimatedPromptTokens),
      contextWindow: observation?.contextWindow ?? null, modelName: observation?.modelName ?? null, comparable } } }
}

/** Ring and popover must consume the same value. Legacy actualPromptTokens is historical, never current. */
export function resolveContextMeter(usage = {}) {
  if (usage.meter?.version === 1) return usage.meter
  const usedTokens = count(usage.estimatedTokens) ?? 0
  // Older payloads carry only the window and the authoritative flag. A
  // non-authoritative window is still shown, marked estimated: dropping it
  // produced an "unknown" meter next to a concrete percentage elsewhere.
  const contextWindow = usage.contextWindowKnown === false ? null : windowSize(usage.contextWindow)
  const contextWindowEstimated = contextWindow !== null
    && (usage.contextWindowAuthoritative === false || usage.contextWindowEstimated === true)
  const contextWindowSource = contextWindow === null
    ? 'unknown'
    : String(usage.contextWindowSource || (contextWindowEstimated ? 'catalog_estimate' : 'catalog'))
  return { version: 1, usedTokens, estimated: true, source: 'client_estimate', contextWindow,
    contextWindowKnown: contextWindow !== null, contextWindowEstimated, contextWindowSource,
    percent: contextWindow ? usedTokens / contextWindow * 100 : null, draftTokens: 0, unknownAttachments: 0,
    coverage: 'partial', lastRequest: { inputTokens: count(usage.actualPromptTokens), estimatedInputTokens: count(usage.serverEstimatedPromptTokens), comparable: false } }
}
export function formatContextPercent(percent) {
  if (percent === null) return null
  if (percent > 100) return '>100%'
  if (percent > 0 && percent < .1) return '<0.1%'
  return `${percent > 0 && percent < 10 ? Number(percent.toFixed(1)) : Math.round(percent)}%`
}

import { normalizeModelContentForEndpoint } from '../utils/modelContentCapabilities.js'
import { replaceUnsupportedVisionContent } from './visionAssist.js'

// Anthropic/Gemini express reasoning as thinking/thought blocks and reject the
// OpenAI-compatible `reasoning_content` field. Retention must stay off for
// those native kinds unless a deployment explicitly opts in; every other kind
// (ollama / lmstudio / llamacpp / vllm / openai-compatible) round-trips the
// field natively and benefits from the default-on replay.
const REASONING_REJECTION_KINDS = new Set(['anthropic', 'gemini'])

const CORE_MESSAGE_KEYS = new Set(['role', 'content', 'name', 'tool_call_id', 'tool_calls'])
const INTERNAL_KEYS = new Set([
  '_display',
  '_displayOnly',
  '_internal',
  '_providerSidecars',
  'displayOnly',
  'internal',
  'kind',
  'modelContext',
  'modelVisible',
  'providerSidecars',
  'reasoning',
  'reasoning_content',
  'source',
  'ts',
  'type',
  'usage',
])

/**
 * Chain-of-thought replay gate (Codex-style retained reasoning).
 *
 * Default-on for OpenAI-compatible providers, whose native field IS
 * `reasoning_content`: assistant turns inside a tool loop carry their captured
 * chain-of-thought back to the provider, which measurably improves multi-step
 * task convergence. Anthropic/Gemini keep it off by default because they
 * express reasoning as thinking/thought blocks and reject `reasoning_content`.
 * A deployment can still force either direction:
 *   MODEL_REASONING_RETENTION=1  => always retain
 *   MODEL_REASONING_RETENTION=0  => never retain
 */
export function retainReasoningForEnv(env = process.env, { providerKind = '' } = {}) {
  const explicit = String(env?.MODEL_REASONING_RETENTION || '').trim().toLowerCase()
  if (explicit === '1') return true
  if (explicit === '0') return false
  return !REASONING_REJECTION_KINDS.has(String(providerKind || '').trim().toLowerCase())
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]))
}

function isDisplayOnly(value = {}) {
  if (value?._display === true || value?._displayOnly === true || value?.displayOnly === true) return true
  if (value?.modelVisible === false) return true
  if (value?.role === 'notice') return true
  return (value?.kind === 'notice' || value?.type === 'notice')
    && (value?._internal === true || value?.internal === true)
}

function activeProviderKeys({ profile = {}, providerKind = '', providerId = '' } = {}) {
  const keys = new Set([
    String(providerId || '').trim(),
    String(providerKind || profile.kind || '').trim(),
  ].filter(Boolean))
  const kind = String(providerKind || profile.kind || '').trim()
  if (!['anthropic', 'gemini'].includes(kind)) {
    keys.add('openai')
    keys.add('openai-compatible')
  }
  return keys
}

function activeSidecar(message, providerKeys) {
  const maps = [message?._providerSidecars, message?.providerSidecars]
  const merged = {}
  for (const map of maps) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    for (const key of providerKeys) {
      const sidecar = map[key]
      if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) continue
      for (const [field, value] of Object.entries(sidecar)) {
        if (CORE_MESSAGE_KEYS.has(field) || INTERNAL_KEYS.has(field)) continue
        merged[field] = cloneValue(value)
      }
    }
  }
  return merged
}

function sanitizeToolCalls(toolCalls = []) {
  return toolCalls.flatMap((call) => {
    const id = String(call?.id || '').trim()
    const name = String(call?.function?.name || call?.name || '').trim()
    if (!id || !name) return []
    const rawArguments = call?.function?.arguments ?? call?.arguments ?? '{}'
    return [{
      id,
      type: 'function',
      function: {
        name,
        arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments),
      },
    }]
  })
}

function sanitizeMessage(message, providerKeys, { retainReasoning = false } = {}) {
  const clean = {
    role: message.role,
    ...(Object.hasOwn(message, 'content') ? { content: cloneValue(message.content) } : {}),
    ...(typeof message.name === 'string' ? { name: message.name } : {}),
    ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
    // Opt-in chain-of-thought replay (MODEL_REASONING_RETENTION=1). Only the
    // assistant's own retained reasoning travels back, and only to the same
    // request pipeline that produced it; every other consumer keeps the
    // historical strip-everything behavior.
    ...(retainReasoning
      && message.role === 'assistant'
      && typeof message.reasoning_content === 'string'
      && message.reasoning_content.trim()
      ? { reasoning_content: message.reasoning_content }
      : {}),
  }
  if (Array.isArray(message.tool_calls)) clean.tool_calls = sanitizeToolCalls(message.tool_calls)
  return { ...clean, ...activeSidecar(message, providerKeys) }
}

function removeOrphanToolResults(messages = []) {
  const callIds = new Set()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      const id = String(call?.id || '').trim()
      if (id) callIds.add(id)
    }
  }
  return messages.filter((message) => (
    message.role !== 'tool' || callIds.has(String(message.tool_call_id || '').trim())
  ))
}

function appendEphemeralContext(messages, ephemeralContext) {
  const context = String(ephemeralContext || '').trim()
  if (!context) return messages
  let target = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      target = index
      break
    }
  }
  if (target < 0) return messages
  const next = messages.slice()
  const message = next[target]
  if (Array.isArray(message.content)) {
    next[target] = {
      ...message,
      content: [...message.content, { type: 'text', text: context }],
    }
  } else {
    const content = String(message.content || '')
    next[target] = { ...message, content: [content, context].filter(Boolean).join('\n\n') }
  }
  return next
}

/**
 * Build the provider-facing transcript without mutating durable conversation state.
 * Every adapter uses this boundary so failover candidates re-evaluate private
 * sidecars and content capabilities for the actual target endpoint.
 */
export function prepareOutboundMessages({
  messages = [],
  profile = {},
  modelName = '',
  providerKind = '',
  providerId = '',
  ephemeralContext = '',
  retainReasoning = false,
} = {}) {
  const providerKeys = activeProviderKeys({ profile, providerKind, providerId })
  const sanitized = removeOrphanToolResults((Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message === 'object' && !isDisplayOnly(message))
    .map((message) => sanitizeMessage(message, providerKeys, { retainReasoning })))
  const withContext = appendEphemeralContext(sanitized, ephemeralContext)
  const visionSafe = profile?.supportsVision === true
    ? withContext
    : replaceUnsupportedVisionContent({ messages: withContext, modelName }).messages
  return normalizeModelContentForEndpoint(visionSafe, profile)
}

export const _testing = Object.freeze({
  activeProviderKeys,
  appendEphemeralContext,
  isDisplayOnly,
  removeOrphanToolResults,
  sanitizeMessage,
})

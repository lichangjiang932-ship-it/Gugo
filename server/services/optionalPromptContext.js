import { logWarn } from '../utils/logger.js'
import { prepareBackgroundPromptContext, prepareBackgroundPromptContextAsync } from './turnPromptContext.js'
import { assertPromptContextActive, promptMemoryDiagnostics } from './backgroundMemoryQuery.js'

export function normalizePromptContextIds(values, limit = 32) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean))]
    .slice(0, limit)
}

function normalizeOptionalContext(context = {}) {
  return {
    messages: Array.isArray(context.messages) ? context.messages.filter((message) => (
      message?.role === 'system' && typeof message.content === 'string' && message.content
    )) : [],
    skillIds: normalizePromptContextIds(context.skillIds),
    ...(Array.isArray(context.memoryIds) ? { memoryIds: normalizePromptContextIds(context.memoryIds) } : {}),
    ...(context.memoryDiagnostics ? { memoryDiagnostics: promptMemoryDiagnostics(context.memoryDiagnostics) } : {}),
  }
}

function optionalFailure(scope, signal) {
  assertPromptContextActive(signal)
  try { logWarn(scope, 'optional prompt context failed (PROMPT_CONTEXT_UNAVAILABLE)') } catch { /* optional logging */ }
  return { messages: [], skillIds: [], memoryIds: [], memoryDiagnostics: { failed: true } }
}

export function prepareOptionalPromptContext({
  preparePromptContext = prepareBackgroundPromptContext,
  input = {},
  scope = 'prompt.context',
} = {}) {
  try {
    assertPromptContextActive(input.signal)
    return normalizeOptionalContext(preparePromptContext(input) || {})
  } catch { return optionalFailure(scope, input.signal) }
}

export async function prepareOptionalPromptContextAsync({
  preparePromptContext = prepareBackgroundPromptContextAsync, input = {}, scope = 'prompt.context',
} = {}) {
  assertPromptContextActive(input.signal)
  try {
    const context = await preparePromptContext(input)
    assertPromptContextActive(input.signal)
    return normalizeOptionalContext(context || {})
  } catch { return optionalFailure(scope, input.signal) }
}

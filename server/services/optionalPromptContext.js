import { logWarn } from '../utils/logger.js'
import { prepareBackgroundPromptContext } from './turnPromptContext.js'

export function normalizePromptContextIds(values, limit = 32) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean))]
    .slice(0, limit)
}

export function prepareOptionalPromptContext({
  preparePromptContext = prepareBackgroundPromptContext,
  input = {},
  scope = 'prompt.context',
} = {}) {
  try {
    const context = preparePromptContext(input) || {}
    return {
      messages: Array.isArray(context.messages)
        ? context.messages.filter((message) => (
            message?.role === 'system'
            && typeof message.content === 'string'
            && message.content
          ))
        : [],
      skillIds: normalizePromptContextIds(context.skillIds),
    }
  } catch (error) {
    try { logWarn(scope, `optional prompt context failed: ${error?.message || error}`) } catch { /* optional logging */ }
    return { messages: [], skillIds: [] }
  }
}

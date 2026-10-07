import { registerOpenAIResponsesAdapter } from './openaiResponses.js'

/** Built-in protocol adapters, registered once when the LLM layer loads. */
export function registerBuiltinLlmAdapters() {
  registerOpenAIResponsesAdapter()
}

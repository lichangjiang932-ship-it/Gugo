import { cloneProviderReplay, geminiReplayParts } from '../../adapters/providerReplayState.js'

/** Keep signed model history distinct from a host-composed/display-safe answer. */
export function modelAssistantHistoryMessage(content, response, extra = {}) {
  const providerReplay = cloneProviderReplay(response?.providerReplay)
  const message = {
    role: 'assistant',
    content: providerReplay ? String(response.content ?? '') : content,
    ...extra,
    ...(providerReplay ? { providerReplay } : {}),
  }
  if (providerReplay) geminiReplayParts(message, providerReplay)
  return message
}

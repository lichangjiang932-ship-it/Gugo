import { isCompositionEvent as isChatCompositionEvent } from '../../lib/compositionEvent.js'
export { isChatCompositionEvent }

export function shouldSubmitChatKey(event = {}) {
  if (isChatCompositionEvent(event)) return false
  return event.key === 'Enter' && event.shiftKey !== true
}

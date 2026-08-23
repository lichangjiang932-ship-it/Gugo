export function isChatCompositionEvent(event = {}) {
  const keyCode = Number(event.keyCode ?? event.which ?? event.nativeEvent?.keyCode)
  return event.isComposing === true || event.nativeEvent?.isComposing === true || keyCode === 229
}

export function shouldSubmitChatKey(event = {}) {
  if (isChatCompositionEvent(event)) return false
  return event.key === 'Enter' && event.shiftKey !== true
}

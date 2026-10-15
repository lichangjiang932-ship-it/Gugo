export function isCompositionEvent(event = {}) {
  const keyCode = Number(event.keyCode ?? event.which ?? event.nativeEvent?.keyCode)
  return event.isComposing === true || event.nativeEvent?.isComposing === true || keyCode === 229
}

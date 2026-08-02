export const DEFAULT_MESSAGE_WINDOW_SIZE = 80

export function getMessageWindow(messages, visibleCount = DEFAULT_MESSAGE_WINDOW_SIZE) {
  const list = Array.isArray(messages) ? messages : []
  const safeCount = Math.max(1, Number(visibleCount) || DEFAULT_MESSAGE_WINDOW_SIZE)
  const hiddenCount = Math.max(0, list.length - safeCount)
  return {
    hiddenCount,
    visibleMessages: hiddenCount > 0 ? list.slice(hiddenCount) : list,
  }
}

export function getExpandedWindowCount(messageCount, targetIndex, windowSize = DEFAULT_MESSAGE_WINDOW_SIZE) {
  const required = Math.max(0, Number(messageCount) - Number(targetIndex))
  return Math.ceil(required / windowSize) * windowSize
}

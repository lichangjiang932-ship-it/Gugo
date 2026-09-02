export const DEFAULT_MESSAGE_WINDOW_SIZE = 80

export function getMessageWindow(messages, visibleCount = DEFAULT_MESSAGE_WINDOW_SIZE, startIndex = null) {
  const list = Array.isArray(messages) ? messages : []
  const safeCount = Math.max(1, Number(visibleCount) || DEFAULT_MESSAGE_WINDOW_SIZE)
  const latestStart = Math.max(0, list.length - safeCount)
  const requestedStart = Number.isInteger(startIndex) ? startIndex : latestStart
  const hiddenCount = Math.min(latestStart, Math.max(0, requestedStart))
  const endIndex = Math.min(list.length, hiddenCount + safeCount)
  return {
    hiddenCount,
    hiddenAfterCount: Math.max(0, list.length - endIndex),
    visibleMessages: list.slice(hiddenCount, endIndex),
  }
}

export function getAnchoredWindowStart(messageCount, targetIndex, windowSize = DEFAULT_MESSAGE_WINDOW_SIZE) {
  const safeMessageCount = Math.max(0, Number(messageCount) || 0)
  const safeWindowSize = Math.max(1, Number(windowSize) || DEFAULT_MESSAGE_WINDOW_SIZE)
  const latestStart = Math.max(0, safeMessageCount - safeWindowSize)
  const safeTarget = Math.min(
    Math.max(0, safeMessageCount - 1),
    Math.max(0, Number(targetIndex) || 0),
  )
  return Math.min(latestStart, Math.max(0, safeTarget - Math.floor(safeWindowSize / 2)))
}

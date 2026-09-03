const SUMMARY_LIMIT = 72
export const CHAT_TIMELINE_MARKER_LIMIT = 11

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function truncateSummary(value) {
  const characters = Array.from(compactText(value))
  if (characters.length <= SUMMARY_LIMIT) return characters.join('')
  return `${characters.slice(0, SUMMARY_LIMIT - 1).join('')}…`
}

export function buildChatTurnMarkers(messages, attachmentFallback) {
  const list = Array.isArray(messages) ? messages : []
  let turnNumber = 0
  return list.flatMap((message, messageIndex) => {
    if (message?.role !== 'user') return []
    turnNumber += 1
    const attachmentNames = Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => compactText(attachment?.name)).filter(Boolean).join(', ')
      : ''
    const summary = truncateSummary(message.content || attachmentNames || attachmentFallback)
    return [{
      key: message.id || `turn-${messageIndex}`,
      messageIndex,
      number: turnNumber,
      summary,
    }]
  })
}

function findActiveTurnPosition(turns, activeTurnIndex) {
  if (!Number.isInteger(activeTurnIndex)) return turns.length - 1
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].messageIndex <= activeTurnIndex) return index
  }
  return 0
}

export function getBoundedChatTimeline(turns, activeTurnIndex) {
  const items = Array.isArray(turns) ? turns : []
  if (items.length === 0) {
    return {
      activeMessageIndex: null,
      visibleTurns: [],
      earlierTurn: null,
      laterTurn: null,
    }
  }

  const activePosition = findActiveTurnPosition(items, activeTurnIndex)
  const centeredStart = activePosition - Math.floor(CHAT_TIMELINE_MARKER_LIMIT / 2)
  const maxStart = Math.max(0, items.length - CHAT_TIMELINE_MARKER_LIMIT)
  const start = Math.min(Math.max(0, centeredStart), maxStart)
  const end = Math.min(items.length, start + CHAT_TIMELINE_MARKER_LIMIT)

  return {
    activeMessageIndex: items[activePosition].messageIndex,
    visibleTurns: items.slice(start, end),
    earlierTurn: start > 0 ? items[start - 1] : null,
    laterTurn: end < items.length ? items[end] : null,
  }
}

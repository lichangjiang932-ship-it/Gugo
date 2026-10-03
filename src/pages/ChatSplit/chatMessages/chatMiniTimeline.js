function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/**
 * One marker per user turn. The summary is the whole message, whitespace
 * collapsed — never shortened: a timeline that hides the end of a request cannot
 * be used to tell two similar turns apart, which is the only reason to look at it.
 */
export function buildChatTurnMarkers(messages, attachmentFallback) {
  const list = Array.isArray(messages) ? messages : []
  let turnNumber = 0
  return list.flatMap((message, messageIndex) => {
    if (message?.role !== 'user') return []
    turnNumber += 1
    const attachmentNames = Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => compactText(attachment?.name)).filter(Boolean).join(', ')
      : ''
    return [{
      key: message.id || `turn-${messageIndex}`,
      messageIndex,
      number: turnNumber,
      summary: compactText(message.content || attachmentNames || attachmentFallback),
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

/**
 * Every turn, plus which one the reader is on.
 *
 * The list used to be windowed to a fixed number of markers with two "…" controls
 * standing in for the rest, which meant the timeline could not be used to see where
 * you are in a long conversation — the turns it hid were exactly the ones worth
 * scanning. The strip scrolls, so all of them fit without taking more room; the
 * active marker is kept in view instead.
 */
export function resolveChatTimeline(turns, activeTurnIndex) {
  const items = Array.isArray(turns) ? turns : []
  if (items.length === 0) return { activeMessageIndex: null, turns: [] }
  const activePosition = findActiveTurnPosition(items, activeTurnIndex)
  return {
    activeMessageIndex: items[activePosition].messageIndex,
    turns: items,
  }
}

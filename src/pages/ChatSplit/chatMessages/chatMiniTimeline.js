const SUMMARY_LIMIT = 72

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

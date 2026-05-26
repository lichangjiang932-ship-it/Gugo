export function getMentionQuery(value, cursor = value?.length || 0) {
  const text = String(value || '')
  const left = text.slice(0, cursor)
  const match = left.match(/(^|[\s([{（【《「『,，。.!！?？;；:：])@([^\s@]*)$/u)
  if (!match) return null
  if (match[0].startsWith('\\@') || left[left.length - match[2].length - 2] === '\\') return null
  return { query: match[2] || '', start: cursor - (match[2]?.length || 0) - 1, end: cursor }
}

export function applyMention(value, mentionState, agent) {
  if (!mentionState || !agent) return value
  const text = String(value || '')
  const label = agent.handle || agent.name || agent.id
  return `${text.slice(0, mentionState.start)}@${label} ${text.slice(mentionState.end)}`
}

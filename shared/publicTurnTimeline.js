export const PUBLIC_TURN_TIMELINE_LIMITS = Object.freeze({ textChars: 262_144, toolAnchors: 512 })

function boundedId(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/\p{Cc}/u.test(value)
}

/** Display-only evidence. Offsets index this exact UTF-16 text, never canonicalText. */
export function normalizePublicTurnTimeline(value, { turnId, canonicalText } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !boundedId(value.turnId) || (turnId !== undefined && value.turnId !== turnId)
    || typeof value.text !== 'string' || value.text.length > PUBLIC_TURN_TIMELINE_LIMITS.textChars
    || typeof value.canonicalText !== 'string' || value.canonicalText.length > PUBLIC_TURN_TIMELINE_LIMITS.textChars
    || (canonicalText !== undefined && value.canonicalText !== canonicalText)
    || !Array.isArray(value.toolAnchors) || value.toolAnchors.length > PUBLIC_TURN_TIMELINE_LIMITS.toolAnchors) return null
  const seen = new Set()
  const toolAnchors = []
  let previousOffset = 0
  for (const anchor of value.toolAnchors) {
    if (!anchor || !boundedId(anchor.id) || !boundedId(anchor.name, 128) || seen.has(anchor.id)
      || !Number.isSafeInteger(anchor.textOffset) || anchor.textOffset < previousOffset
      || anchor.textOffset > value.text.length) return null
    seen.add(anchor.id)
    previousOffset = anchor.textOffset
    toolAnchors.push({ id: anchor.id, name: anchor.name, textOffset: anchor.textOffset })
  }
  return { version: 1, turnId: value.turnId, canonicalText: value.canonicalText, text: value.text, toolAnchors }
}

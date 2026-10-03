import { normalizePublicTurnTimeline, PUBLIC_TURN_TIMELINE_LIMITS } from '../../shared/publicTurnTimeline.js'

export function copyPublicTimelineCheckpoint(value, scope) {
  if (!value || value.userId !== scope.userId || value.sessionId !== scope.sessionId || value.turnId !== scope.turnId) return null
  const normalized = normalizePublicTurnTimeline({ ...value, canonicalText: value.text }, { turnId: scope.turnId })
  return normalized ? { version: 1, ...scope, text: normalized.text, toolAnchors: normalized.toolAnchors } : null
}

export function createTurnPublicTimeline(scope, restoredCheckpointState, initialText = '') {
  const record = restoredCheckpointState
    ? copyPublicTimelineCheckpoint(restoredCheckpointState.publicTimeline, scope)
    : initialText ? null : { version: 1, ...scope, text: '', toolAnchors: [] }
  if (!record || !initialText || record.text === initialText) return record
  const state = { publicTimeline: record }
  updateTurnPublicText(state, initialText)
  return state.publicTimeline
}

/** Called only with the host's accumulated public assistant deltas, never reasoning. */
export function updateTurnPublicText(state, text) {
  const record = state.publicTimeline
  if (!record) return
  if (typeof text !== 'string' || text.length > PUBLIC_TURN_TIMELINE_LIMITS.textChars
    || (!text.startsWith(record.text) && !record.text.startsWith(text))) {
    state.publicTimeline = null
    return
  }
  record.text = text
  record.toolAnchors = record.toolAnchors.filter((anchor) => anchor.textOffset <= text.length)
}

/** Capture the first durable declaration/start/outcome once; later updates do not move it. */
export function recordPublicToolAnchor(state, call, textOffset) {
  const record = state.publicTimeline
  if (!record) return
  const previous = record.toolAnchors.find((anchor) => anchor.id === call?.id)
  if (previous) {
    if (previous.name !== call?.name) state.publicTimeline = null
    return
  }
  const candidate = { ...record, canonicalText: record.text,
    toolAnchors: [...record.toolAnchors, { id: call?.id, name: call?.name, textOffset }] }
  const normalized = normalizePublicTurnTimeline(candidate, { turnId: record.turnId })
  if (!normalized) state.publicTimeline = null
  else record.toolAnchors = normalized.toolAnchors
}

export function publicTimelineContext(value, scope, canonicalText) {
  const record = copyPublicTimelineCheckpoint(value, scope)
  if (!record || !record.toolAnchors.length || typeof canonicalText !== 'string' || !canonicalText.trim()) return {}
  let text = record.text
  if (!text.endsWith(canonicalText) && !text.trimEnd().endsWith(canonicalText)) {
    // A non-streaming final answer may arrive only in the terminal result.
    // Append it only when no public text has followed the final tool anchor.
    if (text.slice(record.toolAnchors.at(-1).textOffset).trim()) return {}
    text += canonicalText
  }
  const projection = normalizePublicTurnTimeline({ ...record, text, canonicalText }, { turnId: scope.turnId, canonicalText })
  return projection ? { publicTimeline: projection } : {}
}

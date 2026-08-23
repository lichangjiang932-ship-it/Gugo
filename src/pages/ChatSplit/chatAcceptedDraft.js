import { normalizeDraftAttachments } from '../../lib/chatDrafts.js'

function attachmentDraftKey(value) {
  const [normalized] = normalizeDraftAttachments([value])
  return normalized ? JSON.stringify(normalized) : null
}

function sameAttachmentDraft(left = [], right = []) {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const key = attachmentDraftKey(item)
    return key !== null && key === attachmentDraftKey(right[index])
  })
}

function subtractAcceptedAttachments(current = [], accepted = []) {
  const acceptedCounts = new Map()
  for (const item of accepted) {
    const key = attachmentDraftKey(item)
    if (key) acceptedCounts.set(key, (acceptedCounts.get(key) || 0) + 1)
  }

  let removed = 0
  const remaining = current.filter((item) => {
    const key = attachmentDraftKey(item)
    const count = key ? acceptedCounts.get(key) || 0 : 0
    if (count === 0) return true
    if (count === 1) acceptedCounts.delete(key)
    else acceptedCounts.set(key, count - 1)
    removed += 1
    return false
  })
  return { remaining, removed }
}

export function applyAcceptedChatDraft({
  acceptedSessionId = null,
  activeSessionId = null,
  attachments = [],
  dispatch,
  draftSessionId = null,
  input = '',
  inputSnapshot = '',
  sentAttachments = [],
  setAttachments,
  setInput,
} = {}) {
  const originStillActive = activeSessionId === draftSessionId
  const textUnchanged = originStillActive && input === inputSnapshot
  const attachmentsUnchanged = originStillActive
    && sameAttachmentDraft(attachments, sentAttachments)
  const acceptedAttachments = originStillActive
    ? subtractAcceptedAttachments(attachments, sentAttachments)
    : { remaining: attachments, removed: 0 }
  const attachmentsAccepted = acceptedAttachments.removed > 0
  const nextAttachments = attachmentsAccepted
    ? acceptedAttachments.remaining
    : attachments

  if (textUnchanged) setInput?.('')
  if (attachmentsAccepted) setAttachments?.(nextAttachments)

  if (draftSessionId && originStillActive && (textUnchanged || attachmentsAccepted)) {
    dispatch?.({
      type: 'SET_SESSION_DRAFT',
      payload: {
        sessionId: draftSessionId,
        ...(textUnchanged ? { text: '' } : {}),
        ...(attachmentsAccepted
          ? { attachments: normalizeDraftAttachments(nextAttachments) }
          : {}),
      },
    })
  } else if (!draftSessionId && acceptedSessionId && originStillActive
    && (!textUnchanged || !attachmentsUnchanged)) {
    // The ACK callback deliberately runs before NEW_SESSION is dispatched.
    // Persist edits made while ACK was pending under the accepted id first, so
    // the following session transition restores them instead of an empty draft.
    dispatch?.({
      type: 'SET_SESSION_DRAFT',
      payload: {
        sessionId: acceptedSessionId,
        text: textUnchanged ? '' : input,
        attachments: normalizeDraftAttachments(nextAttachments),
      },
    })
  }

  return { attachmentsAccepted, attachmentsUnchanged, originStillActive, textUnchanged }
}

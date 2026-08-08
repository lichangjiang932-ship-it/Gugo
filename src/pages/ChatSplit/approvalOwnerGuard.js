function normalizeOwner(owner) {
  const sessionId = String(owner?.sessionId || '').trim()
  const turnId = String(owner?.turnId || '').trim()
  return sessionId && turnId ? { sessionId, turnId } : null
}

function ownersEqual(left, right) {
  return !!left && !!right && left.sessionId === right.sessionId && left.turnId === right.turnId
}

export function createApprovalOwnerGuard() {
  let current = null
  return {
    claim(owner) {
      const next = normalizeOwner(owner)
      if (!next) throw new TypeError('approval owner requires sessionId and turnId')
      const previous = current
      current = next
      return previous
    },
    matches(owner) {
      return ownersEqual(current, normalizeOwner(owner))
    },
    release(owner) {
      if (!ownersEqual(current, normalizeOwner(owner))) return false
      current = null
      return true
    },
    clear() {
      current = null
    },
  }
}

export function createApprovalEpochGuard() {
  let epoch = 0
  return {
    current() {
      return epoch
    },
    advance() {
      epoch += 1
      return epoch
    },
    isCurrent(value) {
      return value === epoch
    },
  }
}

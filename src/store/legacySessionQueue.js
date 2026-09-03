function jsonEqual(left, right) {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function contentHash(value) {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function messageBodyKey(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return stableJson(message)
  const body = { ...message }
  delete body.id
  return stableJson(body)
}

function conflictMessageId(message, sessionId, occupiedIds) {
  const originalId = String(message?.id || 'message').trim() || 'message'
  const fingerprint = contentHash(`${sessionId}\0${originalId}\0${messageBodyKey(message)}`)
  let ordinal = 1
  while (true) {
    const suffix = `~legacy-${fingerprint}${ordinal === 1 ? '' : `-${ordinal}`}`
    const candidate = `${originalId.slice(0, Math.max(1, 512 - suffix.length))}${suffix}`
    if (!occupiedIds.has(candidate)) return candidate
    ordinal += 1
  }
}

function mergeLegacyMessages(primary, secondary, sessionId) {
  const merged = []
  const messagesById = new Map()
  const bodyKeysById = new Map()
  for (const message of [...primary, ...secondary]) {
    const id = String(message?.id || '').trim()
    if (!id) {
      merged.push(message)
      continue
    }
    const bodyKey = messageBodyKey(message)
    if (!messagesById.has(id)) {
      merged.push(message)
      messagesById.set(id, message)
      bodyKeysById.set(id, bodyKey)
      continue
    }
    if (jsonEqual(messagesById.get(id), message)) continue

    const expectedConflictId = conflictMessageId(message, sessionId, new Set())
    if (bodyKeysById.get(expectedConflictId) === bodyKey) continue
    const conflictId = conflictMessageId(message, sessionId, new Set(messagesById.keys()))
    const preserved = { ...message, id: conflictId }
    merged.push(preserved)
    messagesById.set(conflictId, preserved)
    bodyKeysById.set(conflictId, bodyKey)
  }
  return merged
}

function mergeLegacySession(left, right, preferRight) {
  if (jsonEqual(left, right)) return left
  if (!left || typeof left !== 'object' || Array.isArray(left)) return preferRight ? right : left
  if (!right || typeof right !== 'object' || Array.isArray(right)) return preferRight ? right : left
  const primary = preferRight ? right : left
  const secondary = preferRight ? left : right
  return {
    ...secondary,
    ...primary,
    messages: mergeLegacyMessages(
      Array.isArray(primary.messages) ? primary.messages : [],
      Array.isArray(secondary.messages) ? secondary.messages : [],
      String(primary.id || secondary.id || ''),
    ),
  }
}

export function mergeLegacySessionQueues(leftValue, rightValue, { preferRight = false } = {}) {
  const left = Array.isArray(leftValue) ? leftValue : []
  const right = Array.isArray(rightValue) ? rightValue : []
  const primary = preferRight ? right : left
  const secondary = preferRight ? left : right
  const merged = []
  const indexById = new Map()

  for (const session of [...primary, ...secondary]) {
    const id = String(session?.id || '').trim()
    if (!id) {
      merged.push(session)
      continue
    }
    if (!indexById.has(id)) {
      indexById.set(id, merged.length)
      merged.push(session)
      continue
    }
    const index = indexById.get(id)
    merged[index] = mergeLegacySession(merged[index], session, false)
  }
  return merged
}

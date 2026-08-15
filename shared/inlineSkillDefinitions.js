const KIB = 1024

/**
 * Inline skill metadata is bounded by Unicode characters and UTF-8 bytes.
 * The prompt is bounded only by UTF-8 bytes because it is compiled into the
 * model request budget. Keep these limits shared by request cleanup and the
 * durable turn-event schema so a value accepted at startup remains replayable.
 */
export const INLINE_SKILL_DEFINITION_LIMITS = Object.freeze({
  maxDefinitions: 8,
  maxPermissions: 32,
  id: Object.freeze({ maxCharacters: 96 }),
  name: Object.freeze({ maxCharacters: 160, maxUtf8Bytes: 512 }),
  description: Object.freeze({ maxCharacters: 2_000, maxUtf8Bytes: 8 * KIB }),
  permission: Object.freeze({ maxCharacters: 160, maxUtf8Bytes: 512 }),
  systemPrompt: Object.freeze({ maxUtf8Bytes: 96 * KIB }),
})

const encoder = new TextEncoder()

export function unicodeCharacterLength(value) {
  return Array.from(String(value ?? '')).length
}

export function utf8ByteLength(value) {
  return encoder.encode(String(value ?? '')).byteLength
}

export function truncateInlineSkillText(value, {
  maxCharacters = Number.POSITIVE_INFINITY,
  maxUtf8Bytes = Number.POSITIVE_INFINITY,
} = {}) {
  const text = String(value ?? '').trim()
  if (unicodeCharacterLength(text) <= maxCharacters && utf8ByteLength(text) <= maxUtf8Bytes) return text

  const kept = []
  let characters = 0
  let bytes = 0
  for (const character of text) {
    const characterBytes = utf8ByteLength(character)
    if (characters + 1 > maxCharacters || bytes + characterBytes > maxUtf8Bytes) break
    kept.push(character)
    characters += 1
    bytes += characterBytes
  }
  return kept.join('')
}

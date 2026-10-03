/**
 * How many tokens a piece of text costs, near enough to plan with.
 *
 * ASCII packs about four characters per token. Han characters are the one
 * non-ASCII range that modern tokenizers really do merge — the Qwen/Llama BPEs
 * this app talks to hold common written Chinese at roughly 1.5–2.5 characters per
 * token — so counting them as one token each made a Chinese conversation look
 * about twice its real size. That is not a harmless rounding error: the
 * attachment budget guard compared the inflated estimate against the compaction
 * threshold and refused requests the endpoint had already been serving happily.
 *
 * Everything else non-ASCII stays at one token per character on purpose. It is
 * the safe direction, and emoji, kana, Hangul and rare scripts genuinely cost
 * that much or more.
 *
 * Counted by code point, so an astral character (emoji, rare ideograph) is one
 * unit rather than two surrogate halves.
 *
 * This lives in `shared/` because the server plans compaction with it and the
 * interface shows a context meter with it: one rule, or the meter and the planner
 * disagree about the same conversation.
 */
const ASCII_CHARACTERS_PER_TOKEN = 4
const HAN_TOKENS_PER_CHARACTER = 0.6

function isHanCodePoint(code) {
  return (code >= 0x3400 && code <= 0x4dbf) // CJK Unified Ideographs Extension A
    || (code >= 0x4e00 && code <= 0x9fff) // CJK Unified Ideographs
    || (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
}

/** The cost of one character, as a fraction of a token. */
export function characterTokenWeight(character) {
  const code = character.codePointAt(0)
  if (code <= 0x7f) return 1 / ASCII_CHARACTERS_PER_TOKEN
  return isHanCodePoint(code) ? HAN_TOKENS_PER_CHARACTER : 1
}

export function textTokens(value) {
  if (value === undefined || value === null || value === '') return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let total = 0
  for (const character of text) total += characterTokenWeight(character)
  return Math.ceil(total)
}

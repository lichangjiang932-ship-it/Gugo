/** Literal transcript matching, with normalized positions mapped back to original graphemes. */
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })

export function normalizedSessionSearchText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
}

export function findSessionLiteralMatch(value, query) {
  const text = String(value ?? '')
  const needle = normalizedSessionSearchText(query).trim()
  if (!needle) return null
  const compatible = text.normalize('NFKC')
  const normalized = compatible.toLowerCase()
  const found = normalized.indexOf(needle)
  if (found < 0) return null
  if (compatible === text && normalized.length === text.length) {
    return { index: found, length: needle.length }
  }
  let normalizedOffset = 0
  let start = null
  let end = text.length
  for (const part of graphemes.segment(text)) {
    const nextOffset = normalizedOffset + normalizedSessionSearchText(part.segment).length
    if (start == null && nextOffset > found) start = part.index
    if (nextOffset >= found + needle.length) { end = part.index + part.segment.length; break }
    normalizedOffset = nextOffset
  }
  return { index: start ?? found, length: end - (start ?? found) }
}

export function sessionSearchExcerpt(text, index, length, padding = 48) {
  const source = String(text ?? '')
  let from = Math.max(0, index - padding)
  let to = Math.min(source.length, index + length + padding)
  if (from > 0 && /[\uDC00-\uDFFF]/u.test(source[from])) from += 1
  if (to < source.length && /[\uD800-\uDBFF]/u.test(source[to - 1])) to -= 1
  return `${from > 0 ? '…' : ''}${source.slice(from, to).replace(/\s+/gu, ' ').trim()}${to < source.length ? '…' : ''}`
}

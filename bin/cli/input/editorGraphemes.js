import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Terminal controls never belong to a draft; keep LF, tabs and Unicode joiners. */
export function normalizeEditorText(value) {
  return stripVTControlCharacters(String(value ?? '').replace(/\r\n?/gu, '\n'))
    .replace(/\p{Cc}/gu, (character) => character === '\n' || character === '\t' ? character : '')
    .toWellFormed()
}

export function editorGraphemes(text) {
  return segmenter.segment(text)
}

function boundedOffset(text, offset) {
  const number = Number(offset)
  return Number.isFinite(number) ? Math.max(0, Math.min(text.length, Math.floor(number))) : 0
}

/** Offsets remain UTF-16, but every exported edit places the caret at a cluster edge. */
export function graphemeOffset(text, offset, affinity = 'backward') {
  const bounded = boundedOffset(text, offset)
  if (bounded === text.length) return bounded
  const cluster = editorGraphemes(text).containing(bounded)
  if (!cluster || cluster.index === bounded) return bounded
  return affinity === 'forward' ? cluster.index + cluster.segment.length : cluster.index
}

export function previousGraphemeOffset(text, offset) {
  const bounded = boundedOffset(text, offset)
  return bounded > 0 ? editorGraphemes(text).containing(bounded - 1).index : 0
}

export function nextGraphemeOffset(text, offset) {
  const cluster = editorGraphemes(text).containing(boundedOffset(text, offset))
  return cluster ? cluster.index + cluster.segment.length : text.length
}

export function graphemeWidth(grapheme, column = 0) {
  return grapheme === '\t' ? 4 - (column % 4) : stringWidth(grapheme)
}

export function editorDisplayWidth(text) {
  let column = 0
  for (const { segment } of editorGraphemes(text)) column += graphemeWidth(segment, column)
  return column
}

/** If the desired column is inside a double-width glyph, stop before that glyph. */
export function offsetAtVisualColumn(text, preferredColumn) {
  let column = 0
  let offset = 0
  for (const { segment, index } of editorGraphemes(text)) {
    const width = graphemeWidth(segment, column)
    if (column + width > preferredColumn) break
    column += width
    offset = index + segment.length
  }
  return offset
}

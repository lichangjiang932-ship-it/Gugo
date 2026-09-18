import {
  editorDisplayWidth, editorGraphemes, graphemeOffset, graphemeWidth, normalizeEditorText,
} from './editorGraphemes.js'

function terminalWidth(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : 80
}

function fitPrompt(prompt, width) {
  const limit = width - Math.min(width, 2)
  let result = ''
  for (const { segment } of editorGraphemes(normalizeEditorText(prompt).replace(/[\n\t]/gu, ' '))) {
    if (editorDisplayWidth(result + segment) > limit) break
    result += segment
  }
  return result
}

function createRow(sourceOffset) {
  return { text: '', start: sourceOffset, end: sourceOffset, width: 0, units: [] }
}

function layoutLine(line, width) {
  const rows = []
  let current = createRow(0)
  let logicalColumn = 0
  for (const { segment, index } of editorGraphemes(line)) {
    const originalWidth = graphemeWidth(segment, logicalColumn)
    const cells = Math.min(width, originalWidth)
    if (current.width + cells > width && current.units.length) {
      rows.push(current)
      current = createRow(index)
    }
    // A single-cell terminal cannot show a double-width glyph. Only the display gets
    // a replacement; source offsets and the submitted buffer remain untouched.
    let display = originalWidth > width ? '�' : segment
    if (segment === '\t') display = ' '.repeat(cells)
    current.units.push({ index, end: index + segment.length, offset: current.text.length, display, column: current.width })
    current.text += display
    current.end = index + segment.length
    current.width += cells
    logicalColumn += originalWidth
  }
  rows.push(current)
  return rows
}

function findCursor(rows, offset, width) {
  let rowIndex = rows.length - 1
  for (let index = 0; index < rows.length; index += 1) {
    if (offset < rows[index].end) { rowIndex = index; break }
  }
  let row = rows[rowIndex]
  if (offset === row.end && row.width === width) {
    rows.push(createRow(offset))
    rowIndex = rows.length - 1
    row = rows[rowIndex]
  }
  const unit = row.units.find((entry) => entry.index >= offset)
  const cursorOffset = unit?.offset ?? row.text.length
  const at = unit?.display || ' '
  return {
    rowIndex,
    cursorColumn: unit?.column ?? row.width,
    cursorOffset,
    cursor: { before: row.text.slice(0, cursorOffset), at, after: row.text.slice(cursorOffset + (unit?.display.length ?? 0)) },
  }
}

/** Pure source-to-cell map. `cursorColumn` is visual; `cursorOffset` is UTF-16. */
export function editorFrame(state, { width = 80, prompt = '' } = {}) {
  const safeWidth = terminalWidth(width)
  const visiblePrompt = fitPrompt(prompt, safeWidth)
  const promptWidth = editorDisplayWidth(visiblePrompt)
  const contentWidth = safeWidth - promptWidth
  const rows = []
  let caret = { cursorRow: 0, cursorColumn: 0, cursorOffset: 0, cursor: { before: '', at: ' ', after: '' } }
  for (const [index, line] of state.lines.entries()) {
    const logicalRows = layoutLine(line, contentWidth)
    if (index === state.row) {
      const position = findCursor(logicalRows, graphemeOffset(line, state.col), contentWidth)
      const { rowIndex, ...details } = position
      caret = { ...details, cursorRow: rows.length + rowIndex }
    }
    rows.push(...logicalRows.map((row) => row.text))
  }
  return {
    rows, ...caret, width: safeWidth, contentWidth,
    prefixes: rows.map((_, index) => index === 0 ? visiblePrompt : ' '.repeat(promptWidth)),
  }
}

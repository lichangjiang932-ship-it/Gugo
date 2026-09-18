/**
 * Multi-line editor semantics, as a pure state machine.
 *
 * This is the "business" half of the Ink PoC: what a keystroke *means*. It holds no
 * terminal state and only uses pure Unicode/layout helpers, so it is testable without a TTY — which
 * matters here, because generated key events cannot be injected into raw mode.
 *
 * The rendering half (`inkEditor.js`) is deliberately thin: it walks the frame this module
 * produces and draws it. If Ink turns out to be the wrong host, only that file changes.
 *
 * Text model: an array of lines plus a cursor. `editorText()` is the only place `\n` is
 * reassembled, so the two halves cannot disagree about where line breaks are.
 */

import {
  editorDisplayWidth, graphemeOffset, nextGraphemeOffset, normalizeEditorText,
  offsetAtVisualColumn, previousGraphemeOffset,
} from './editorGraphemes.js'

export { editorFrame } from './editorFrame.js'

/**
 * Keys that mean "newline" rather than "submit".
 *
 * Terminals do not, as a rule, report Shift+Enter distinctly — most send a bare CR for
 * both. So the reliable binding is Ctrl+J (0x0A, a real line feed): that is what this
 * checks, and `inkEditor` also accepts an explicit shift+return for terminals that do
 * report it. Enter alone always submits.
 */
export const NEWLINE_INPUTS = Object.freeze(['\n'])

/** Create an empty editor, optionally seeded with text. */
export function createEditorState({ text = '' } = {}) {
  const lines = normalizeEditorText(text).split('\n')
  return {
    lines,
    row: lines.length - 1,
    col: lines[lines.length - 1].length,
    submitted: false,
  }
}

/** The editor's text, with line breaks restored. */
export function editorText(state) {
  return Array.isArray(state?.lines) ? state.lines.join('\n') : ''
}

/** True when the editor holds nothing but whitespace. */
export function editorIsEmpty(state) {
  return editorText(state).trim().length === 0
}

function withLines(state, lines, row, col) {
  return { ...state, lines, row, col: graphemeOffset(lines[row], col), preferredColumn: undefined }
}

/** Replace the current line with `next`, leaving the cursor to the caller. */
function setCurrentLine(state, next) {
  const lines = [...state.lines]
  lines[state.row] = next
  return lines
}

/** Insert literal text at the cursor, anywhere in the current line. */
export function insertText(state, text) {
  const value = normalizeEditorText(text)
  if (!value) return state
  // A pasted block splits across lines, so route newlines through the same path as Ctrl+J.
  if (value.includes('\n')) {
    let next = state
    for (const [index, part] of value.split('\n').entries()) {
      if (index > 0) next = insertNewline(next)
      next = insertText(next, part)
    }
    return next
  }
  const line = state.lines[state.row]
  const col = graphemeOffset(line, state.col)
  const merged = `${line.slice(0, col)}${value}${line.slice(col)}`
  const nextCol = graphemeOffset(merged, col + value.length, 'forward')
  return withLines(state, setCurrentLine(state, merged), state.row, nextCol)
}

/** Split the current line at the cursor and move to the start of the new one. */
export function insertNewline(state) {
  const line = state.lines[state.row]
  const col = graphemeOffset(line, state.col)
  const lines = [...state.lines]
  lines.splice(state.row, 1, line.slice(0, col), line.slice(col))
  return withLines(state, lines, state.row + 1, 0)
}

/** Remove the character before the cursor, or join with the previous line at column 0. */
export function deleteBackward(state) {
  if (state.col > 0) {
    const line = state.lines[state.row]
    const start = previousGraphemeOffset(line, state.col)
    const end = graphemeOffset(line, state.col, 'forward')
    const merged = `${line.slice(0, start)}${line.slice(end)}`
    return withLines(state, setCurrentLine(state, merged), state.row, start)
  }
  if (state.row === 0) return state
  const lines = [...state.lines]
  const previous = lines[state.row - 1]
  const current = lines[state.row]
  lines.splice(state.row - 1, 2, `${previous}${current}`)
  return withLines(state, lines, state.row - 1, previous.length)
}

/** Remove the character after the cursor, or join the next line up at end of line. */
export function deleteForward(state) {
  const line = state.lines[state.row]
  if (state.col < line.length) {
    const col = graphemeOffset(line, state.col)
    const merged = `${line.slice(0, col)}${line.slice(nextGraphemeOffset(line, col))}`
    return withLines(state, setCurrentLine(state, merged), state.row, col)
  }
  if (state.row >= state.lines.length - 1) return state
  const lines = [...state.lines]
  lines.splice(state.row, 2, `${line}${lines[state.row + 1]}`)
  return withLines(state, lines, state.row, state.col)
}

export function moveLeft(state) {
  if (state.col > 0) return withLines(state, state.lines, state.row, previousGraphemeOffset(state.lines[state.row], state.col))
  if (state.row === 0) return state
  return withLines(state, state.lines, state.row - 1, state.lines[state.row - 1].length)
}

export function moveRight(state) {
  const line = state.lines[state.row]
  if (state.col < line.length) return withLines(state, state.lines, state.row, nextGraphemeOffset(line, state.col))
  if (state.row >= state.lines.length - 1) return state
  return withLines(state, state.lines, state.row + 1, 0)
}

/** Vertical movement keeps the visual column where possible, like every editor. */
export function moveVertical(state, delta) {
  const row = Math.min(Math.max(state.row + delta, 0), state.lines.length - 1)
  if (row === state.row) return state
  const line = state.lines[state.row]
  const preferredColumn = state.preferredColumn ?? editorDisplayWidth(line.slice(0, graphemeOffset(line, state.col)))
  return { ...state, row, col: offsetAtVisualColumn(state.lines[row], preferredColumn), preferredColumn }
}

export const moveUp = (state) => moveVertical(state, -1)
export const moveDown = (state) => moveVertical(state, 1)

export function moveLineStart(state) {
  return withLines(state, state.lines, state.row, 0)
}

export function moveLineEnd(state) {
  return withLines(state, state.lines, state.row, state.lines[state.row].length)
}

/** Clear from the cursor back to the start of the line (Ctrl+U). */
export function clearToLineStart(state) {
  const line = state.lines[state.row]
  return withLines(state, setCurrentLine(state, line.slice(graphemeOffset(line, state.col))), state.row, 0)
}

/**
 * Apply one key event.
 *
 * Returns `{ state, action }`, where `action` is `null`, `'submit'`, or `'cancel'`.
 * Returning an action instead of performing one keeps the side effect at the call site —
 * which is what makes this testable.
 */
export function applyKey(state, key = {}) {
  const input = typeof key.input === 'string' ? key.input : ''

  if (key.ctrl && (input === 'c' || input === 'd')) return { state, action: 'cancel' }
  if (key.ctrl && input === 'u') return { state: clearToLineStart(state), action: null }

  if (NEWLINE_INPUTS.includes(input) || (key.ctrl && input === 'j') || (key.return && key.shift)) {
    return { state: insertNewline(state), action: null }
  }
  if (key.return) return { state, action: 'submit' }

  if (key.backspace || (key.delete && key.ctrl)) return { state: deleteBackward(state), action: null }
  if (key.delete) return { state: deleteForward(state), action: null }
  if (key.leftArrow) return { state: moveLeft(state), action: null }
  if (key.rightArrow) return { state: moveRight(state), action: null }
  if (key.upArrow) return { state: moveUp(state), action: null }
  if (key.downArrow) return { state: moveDown(state), action: null }
  if (key.home || (key.meta && input === 'a')) return { state: moveLineStart(state), action: null }
  if (key.end) return { state: moveLineEnd(state), action: null }
  if (key.ctrl && input === 'a') return { state: moveLineStart(state), action: null }
  if (key.ctrl && input === 'e') return { state: moveLineEnd(state), action: null }

  // Control chords and unknown escape sequences must not be inserted as text.
  if (!input || key.ctrl || key.meta) return { state, action: null }
  return { state: insertText(state, input), action: null }
}

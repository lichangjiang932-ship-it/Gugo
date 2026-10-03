import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyKey,
  clearToLineStart,
  createEditorState,
  deleteBackward,
  deleteForward,
  editorFrame,
  editorIsEmpty,
  editorText,
  insertText,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
} from '../../bin/cli/input/editorModel.js'

const K = (overrides = {}) => ({ input: '', ...overrides })
const type = (state, text) => applyKey(state, K({ input: text })).state

test('typing, newlines and EOF-safe reads compose into plain text', () => {
  let state = createEditorState()
  assert.equal(editorText(state), '')
  assert.equal(editorIsEmpty(state), true)

  state = type(state, 'hello')
  state = applyKey(state, K({ input: '\n' })).state
  state = type(state, 'world')
  assert.equal(editorText(state), 'hello\nworld')
  assert.equal(editorIsEmpty(state), false)

  assert.deepEqual(createEditorState({ text: 'a\nbb' }), {
    lines: ['a', 'bb'], row: 1, col: 2, submitted: false,
  })
})

test('Enter submits, Ctrl+J and Shift+Enter insert a newline', () => {
  const state = type(createEditorState(), 'one')
  assert.deepEqual(applyKey(state, K({ return: true })), { state, action: 'submit' })

  const viaCtrlJ = applyKey(state, K({ input: '\n' }))
  assert.equal(viaCtrlJ.action, null)
  assert.equal(editorText(viaCtrlJ.state), 'one\n')

  const viaShiftReturn = applyKey(state, K({ return: true, shift: true }))
  assert.equal(viaShiftReturn.action, null)
  assert.equal(editorText(viaShiftReturn.state), 'one\n')
})

test('Ctrl+C and Ctrl+D cancel instead of being inserted', () => {
  const state = type(createEditorState(), 'draft')
  assert.equal(applyKey(state, K({ input: 'c', ctrl: true })).action, 'cancel')
  assert.equal(applyKey(state, K({ input: 'd', ctrl: true })).action, 'cancel')
  assert.equal(editorText(applyKey(state, K({ input: 'c', ctrl: true })).state), 'draft', 'text survives')
})

test('editing at the cursor behaves like every other editor', () => {
  let state = createEditorState({ text: 'abc' })
  state = moveLineStart(state)
  state = insertText(state, 'X')
  assert.equal(editorText(state), 'Xabc', 'insert at column 0')

  state = moveLineEnd(state)
  state = insertText(state, 'Y')
  assert.equal(editorText(state), 'XabcY')

  const middle = applyKey(createEditorState({ text: 'ac' }), K({ leftArrow: true })).state
  assert.equal(editorText(insertText(middle, 'b')), 'abc')

  // Deleting across a boundary joins the lines, as a text editor does. The cursor starts at
  // the end of the text, so it has to be moved to the start of the second line first.
  const atLineStart = moveLineStart(createEditorState({ text: 'ab\ncd' }))
  const joined = deleteBackward(atLineStart)
  assert.equal(editorText(joined), 'abcd')
  assert.deepEqual([joined.row, joined.col], [0, 2])

  assert.equal(editorText(deleteBackward(createEditorState({ text: 'ab' }))), 'a')
  assert.equal(editorText(deleteBackward(createEditorState())), '', 'backspace on empty is a no-op')

  const endOfFirstLine = moveLineEnd(moveUp(createEditorState({ text: 'ab\ncd' })))
  assert.equal(editorText(deleteForward(endOfFirstLine)), 'abcd', 'forward delete at end of line joins the next one')
})

test('vertical and horizontal movement clamp at the edges', () => {
  // The cursor starts at the end of the text, i.e. on the short second line.
  const state = createEditorState({ text: 'longer\nx' })
  assert.equal(moveLineStart(state).col, 0)
  assert.equal(moveLineEnd(state).col, 1, 'the cursor sits on the one-character second line')
  assert.equal(moveLineEnd(moveUp(state)).col, 6, 'the first line is six characters')
  assert.equal(moveLeft(moveLineStart(state)).row, 0, 'left at column 0 of the first line stays put')

  const down = moveDown(state)
  assert.equal(down.row, 1)
  assert.equal(down.col, 1, 'the column clamps to the shorter line')
  assert.equal(moveUp(down).row, 0)
  assert.equal(moveDown(down).row, 1, 'down at the last line stays put')

  const endOfFirst = moveLineEnd(state)
  assert.equal(moveRight(endOfFirst).row, 1, 'right at end of line moves to the next line')
  assert.equal(moveRight(createEditorState({ text: 'x' })).col, 1, 'right at the end stays put')
})

test('Ctrl+U clears to the start of the line only', () => {
  const state = createEditorState({ text: 'keep\ndrop this' })
  const cleared = clearToLineStart(applyKey(state, K({ input: 'u', ctrl: true })).state)
  assert.equal(editorText(cleared), 'keep\n')
})

test('control chords and escape sequences never leak into the text', () => {
  let state = createEditorState()
  for (const key of [
    K({ input: 'x', ctrl: true }),
    K({ input: 'z', meta: true }),
    K({ input: 'p', ctrl: true }),
    K({}),
  ]) {
    state = applyKey(state, key).state
  }
  assert.equal(editorText(state), '')
})

test('a pasted block splits into lines instead of being inserted raw', () => {
  const state = insertText(createEditorState(), 'a\nb\nc')
  assert.equal(editorText(state), 'a\nb\nc')
  assert.deepEqual([state.row, state.col], [2, 1])
})

test('the cursor survives wrapping on a narrow terminal', () => {
  const long = createEditorState({ text: 'abcdefgh' })
  const frame = editorFrame(long, { width: 4 })
  assert.deepEqual(frame.rows, ['abcd', 'efgh', ''])
  assert.equal(frame.cursorRow, 2)
  assert.equal(frame.cursorColumn, 0, 'an end caret at the right margin has its own display row')

  const exact = editorFrame(createEditorState({ text: 'abcd' }), { width: 4 })
  assert.deepEqual(exact.rows, ['abcd', ''], 'an exactly-fitting line reserves one virtual caret row')

  const empty = editorFrame(createEditorState(), { width: 4 })
  assert.deepEqual(empty.rows, [''], 'an empty buffer still renders one row')
  assert.deepEqual([empty.cursorRow, empty.cursorColumn], [0, 0])

  const multiline = editorFrame(createEditorState({ text: 'ab\ncdefg' }), { width: 3 })
  assert.deepEqual(multiline.rows, ['ab', 'cde', 'fg'])
  assert.equal(multiline.cursorRow, 2, 'the cursor follows its logical line through the wrap')
})

test('a degenerate width cannot produce an infinite loop', () => {
  const frame = editorFrame(createEditorState({ text: 'abc' }), { width: 0 })
  assert.ok(frame.rows.length >= 1)
  assert.ok(Number.isFinite(frame.cursorRow) && Number.isFinite(frame.cursorColumn))
})

test('backspace deletes an entire emoji grapheme without leaving surrogate fragments', () => {
  for (const grapheme of ['\u{1f642}', '\u{1f44d}\u{1f3fd}', '\u{1f469}\u200d\u{1f4bb}']) {
    const state = createEditorState({ text: `a${grapheme}` })
    const next = deleteBackward(state)
    assert.equal(editorText(next), 'a')
    assert.equal(next.col, 1)
    assert.equal(editorText(state), `a${grapheme}`, 'the original state is unchanged')
  }
})

test('forward deletion and horizontal movement preserve complete graphemes', () => {
  for (const grapheme of ['🙂', '👍🏽', '👩‍💻', '🇨🇳', 'e\u0301', '✈️']) {
    const start = moveLineStart(createEditorState({ text: `a${grapheme}z` }))
    const before = moveRight(start)
    const after = moveRight(before)
    assert.equal(after.col, 1 + grapheme.length)
    assert.equal(moveLeft(after).col, 1)
    assert.equal(editorText(deleteForward(before)), 'az')
    assert.equal(editorText(deleteBackward(after)), 'az')
  }
})

test('insertion, clearing and legacy cursor positions never split a grapheme', () => {
  const invalidCursor = { ...createEditorState({ text: 'a👩‍💻z' }), col: 3 }
  assert.equal(editorText(insertText(invalidCursor, 'X')), 'aX👩‍💻z')
  assert.equal(editorText(clearToLineStart(invalidCursor)), '👩‍💻z')
  assert.equal(editorText(deleteForward(invalidCursor)), 'az')
  assert.equal(moveLeft(invalidCursor).col, 1)
  assert.equal(moveRight(invalidCursor).col, 6)
})

test('vertical movement remembers visual columns across short and wide lines', () => {
  let state = createEditorState({ text: 'ab中👩‍💻\nx\na中bc' })
  state = { ...state, row: 0, col: 5 }
  state = moveLeft({ ...state, col: 8 })
  assert.equal(state.col, 3)
  state = moveDown(state)
  assert.equal(state.col, 1)
  state = moveDown(state)
  assert.equal(state.col, 3, 'the original visual column 4 is recovered after a short line')
  state = moveUp(state)
  assert.equal(state.col, 1)
  state = moveUp(state)
  assert.equal(state.col, 3)
})

test('line movement preserves a remembered end column until a horizontal edit resets it', () => {
  let state = createEditorState({ text: 'abcdef\nx\nuvwxyz' })
  state = { ...state, row: 0, col: 6 }
  state = moveDown(state)
  state = moveDown(state)
  assert.equal(state.col, 6)
  state = moveUp(state)
  state = moveLeft(state)
  state = moveDown(state)
  assert.equal(state.col, 0)
})

test('newlines normalize on seed and paste without retaining carriage returns', () => {
  assert.equal(editorText(createEditorState({ text: 'a\r\nb\rc' })), 'a\nb\nc')
  const state = insertText(createEditorState({ text: 'x' }), 'a\r\nb\rc')
  assert.equal(editorText(state), 'xa\nb\nc')
  assert.deepEqual([state.row, state.col], [2, 1])
})

test('Ink-normalized Ctrl+J and Home/End are understood', () => {
  const state = createEditorState({ text: 'abc' })
  assert.equal(editorText(applyKey(state, K({ input: 'j', ctrl: true })).state), 'abc\n')
  assert.equal(applyKey(state, K({ home: true })).state.col, 0)
  assert.equal(applyKey(moveLineStart(state), K({ end: true })).state.col, 3)
})

test('unknown terminal control sequences cannot become editor text', () => {
  const state = createEditorState({ text: 'safe' })
  assert.equal(editorText(applyKey(state, K({ input: '\u001b[200~' })).state), 'safe')
  assert.equal(editorText(insertText(state, '\u001b[31mred\u001b[0m\u0007')), 'safered')
})

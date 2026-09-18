import assert from 'node:assert/strict'
import test from 'node:test'

import { createEditorState, editorFrame } from '../../bin/cli/input/editorModel.js'
import { editorDisplayWidth } from '../../bin/cli/input/editorGraphemes.js'

test('frames wrap CJK, emoji and combining characters by terminal cells', () => {
  const state = createEditorState({ text: 'a中👩‍💻e\u0301Z' })
  const frame = editorFrame(state, { width: 4 })
  assert.deepEqual(frame.rows, ['a中', '👩‍💻e\u0301Z', ''])
  assert.deepEqual([frame.cursorRow, frame.cursorColumn, frame.cursorOffset], [2, 0, 0])
  for (const row of frame.rows) assert.ok(editorDisplayWidth(row) <= 4)
})

test('prefix width is measured and reserved on every aligned continuation row', () => {
  const frame = editorFrame(createEditorState({ text: '中ab中' }), { width: 7, prompt: '问> ' })
  assert.deepEqual(frame.rows, ['中a', 'b中', ''])
  assert.deepEqual(frame.prefixes, ['问> ', '    ', '    '])
  assert.equal(frame.contentWidth, 3)
  for (const [index, row] of frame.rows.entries()) {
    assert.ok(editorDisplayWidth(frame.prefixes[index] + row) <= 7)
  }
})

test('cursor UTF-16 offset and terminal cell column are separate values', () => {
  const frame = editorFrame({ ...createEditorState({ text: '中👩‍💻z' }), col: 1 }, { width: 10 })
  assert.deepEqual([frame.cursorRow, frame.cursorColumn, frame.cursorOffset], [0, 2, 1])
  assert.deepEqual(frame.cursor, { before: '中', at: '👩‍💻', after: 'z' })
})

test('the right-margin caret has its own row and never forces an unmodelled wrap', () => {
  const frame = editorFrame(createEditorState({ text: 'ab中' }), { width: 4 })
  assert.deepEqual(frame.rows, ['ab中', ''])
  assert.deepEqual(frame.cursor, { before: '', at: ' ', after: '' })
  assert.equal(frame.cursorRow, 1)
})

test('a caret on a soft-wrap boundary belongs to the next visible row', () => {
  const frame = editorFrame({ ...createEditorState({ text: '中👩‍💻z' }), col: 1 }, { width: 3 })
  assert.deepEqual(frame.rows, ['中', '👩‍💻z'])
  assert.deepEqual([frame.cursorRow, frame.cursorColumn, frame.cursorOffset], [1, 0, 0])
  assert.deepEqual(frame.cursor, { before: '', at: '👩‍💻', after: 'z' })
})

test('zero-width terminals, long prompts and one-cell wide graphemes stay bounded', () => {
  const frame = editorFrame(createEditorState({ text: '中🙂' }), { width: 1, prompt: 'very long> ' })
  assert.deepEqual(frame.rows, ['�', '�', ''])
  assert.equal(frame.contentWidth, 1)
  assert.ok(frame.prefixes.every((prefix) => prefix === ''))
  assert.equal(editorFrame(createEditorState(), { width: Number.POSITIVE_INFINITY }).width, 80)
})

test('recomputing after terminal resize preserves the draft and grapheme caret', () => {
  const state = { ...createEditorState({ text: 'ab中👩‍💻c' }), col: 3 }
  const before = structuredClone(state)
  const wide = editorFrame(state, { width: 20, prompt: '> ' })
  const narrow = editorFrame(state, { width: 6, prompt: '> ' })
  assert.deepEqual(wide.cursor, { before: 'ab中', at: '👩‍💻', after: 'c' })
  assert.deepEqual(narrow.cursor, { before: '', at: '👩‍💻', after: 'c' })
  assert.deepEqual(state, before)
})

test('tabs are rendered as spaces without inserting display padding into the draft', () => {
  const state = createEditorState({ text: 'a\tb' })
  const frame = editorFrame(state, { width: 9 })
  assert.deepEqual(frame.rows, ['a   b'])
  assert.equal(frame.cursorColumn, 5)
  assert.equal(state.lines[0], 'a\tb')
})

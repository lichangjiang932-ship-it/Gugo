import assert from 'node:assert/strict'
import test from 'node:test'
import { stripVTControlCharacters } from 'node:util'

import { createEditorState, editorFrame } from '../../bin/cli/input/editorModel.js'

const supportsInk = Number(process.versions.node.split('.')[0]) >= 22

async function renderFrame(state, options) {
  const [{ createElement }, { renderToString }, { InkEditorFrame }] = await Promise.all([
    import('react'), import('ink'), import('../../bin/cli/input/inkEditor.js'),
  ])
  const frame = editorFrame(state, options)
  const output = renderToString(createElement(InkEditorFrame, { frame, hint: '' }), { columns: options.width })
  return stripVTControlCharacters(output).split('\n').map((line) => line.trimEnd())
}

test('Ink renders every non-cursor line exactly once', { skip: !supportsInk }, async () => {
  const lines = await renderFrame(createEditorState({ text: 'alpha\nbeta' }), { width: 30, prompt: '> ' })
  assert.deepEqual(lines, ['> alpha', '  beta'])
})

test('Ink preserves a complete ZWJ cursor glyph and accounts for CJK prompt width', { skip: !supportsInk }, async () => {
  const state = { ...createEditorState({ text: '中👩‍💻z' }), col: 1 }
  const lines = await renderFrame(state, { width: 12, prompt: '问> ' })
  assert.deepEqual(lines, ['问> 中👩‍💻z'])
})

test('Ink layout agrees with narrow frame rows without implicit glyph splitting', { skip: !supportsInk }, async () => {
  const lines = await renderFrame(createEditorState({ text: 'a中👩‍💻e\u0301Z' }), { width: 6, prompt: '> ' })
  assert.deepEqual(lines, ['> a中', '  👩‍💻e\u0301Z', ''])
})

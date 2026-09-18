/**
 * Ink rendering layer for the multi-line editor.
 *
 * Deliberately thin: it converts keystrokes to `applyKey` calls and draws the frame that
 * `editorFrame` produces. All editing semantics live in `editorModel.js`, so if Ink turns
 * out to be the wrong host for this CLI, only this file is thrown away.
 *
 * No JSX on purpose — the project lints `bin/` as plain JS, and a `.jsx` file under `bin/`
 * would need a build step the CLI does not have.
 */

import { createElement as h, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'

import { applyKey, createEditorState, editorFrame, editorIsEmpty, editorText, insertText } from './editorModel.js'

/** Hint line shown under the buffer; the bindings are the ones `applyKey` implements. */
export const EDITOR_HINT = 'enter submit · ctrl+j newline · ctrl+u clear line · ctrl+c cancel'

/** Rendering consumes a cell/UTF-16 map, never slicing a glyph by a display column. */
export function InkEditorFrame({ frame, hint = EDITOR_HINT }) {
  const lines = frame.rows.map((row, index) => {
    const cursor = index === frame.cursorRow ? frame.cursor : null
    return h(
      Text,
      { key: index, wrap: 'truncate-end' },
      frame.prefixes[index],
      cursor ? cursor.before : row,
      cursor ? h(Text, { inverse: true }, cursor.at) : null,
      cursor ? cursor.after : '',
    )
  })
  return h(
    Box,
    { flexDirection: 'column', width: frame.width },
    ...lines,
    hint ? h(Text, { dimColor: true, wrap: 'truncate-end' }, hint) : null,
  )
}

export function InkInputEditor({
  prompt = '> ',
  width,
  hint = EDITOR_HINT,
  initialText = '',
  initialState,
  onStateChange = null,
  onSubmit = null,
  onCancel = null,
}) {
  const { exit } = useApp()
  const terminal = useWindowSize()
  const [state, setState] = useState(() => initialState ?? createEditorState({ text: initialText }))
  const settled = useRef(false)

  usePaste((text) => {
    if (settled.current) return
    const next = insertText(state, text)
    setState(next)
    onStateChange?.(next)
  })

  useInput((input, key) => {
    if (settled.current || key.eventType === 'release') return
    const { state: next, action } = applyKey(state, { input, ...key })
    if (action === 'cancel') {
      settled.current = true
      try { onCancel?.(editorText(next)) } finally { exit() }
      return
    }
    if (action === 'submit') {
      if (editorIsEmpty(next)) return
      settled.current = true
      try { onSubmit?.(editorText(next)) } finally { exit() }
      return
    }
    setState(next)
    onStateChange?.(next)
  })

  const frame = editorFrame(state, { width: width ?? terminal.columns, prompt })
  return h(InkEditorFrame, { frame, hint })
}

export default InkInputEditor

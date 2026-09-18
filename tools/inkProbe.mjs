#!/usr/bin/env node
import process from 'node:process'
import {
  applyKey, createEditorState, deleteBackward, deleteForward, editorFrame, editorText, moveLineStart,
} from '../bin/cli/input/editorModel.js'
import { editorDisplayWidth } from '../bin/cli/input/editorGraphemes.js'
import { createInkInputEditor } from '../bin/cli/input/inkInputAdapter.js'

function checkPureModel() {
  const emoji = ['🙂', '👍🏽', '👩‍💻', '🇨🇳', 'e\u0301']
  const deletion = emoji.every((glyph) =>
    editorText(deleteBackward(createEditorState({ text: `a${glyph}` }))) === 'a'
    && editorText(deleteForward(moveLineStart(createEditorState({ text: `${glyph}a` })))) === 'a')
  const frame = editorFrame(createEditorState({ text: '中文👩‍💻abcd' }), { width: 9, prompt: '问> ' })
  const checks = {
    graphemeDeletion: deletion,
    cellWrapping: frame.rows.every((row, index) => editorDisplayWidth(frame.prefixes[index] + row) <= 9),
    ctrlJ: editorText(applyKey(createEditorState({ text: 'a' }), { input: 'j', ctrl: true }).state) === 'a\n',
    crlf: editorText(createEditorState({ text: 'a\r\nb\rc' })) === 'a\nb\nc',
  }
  process.stdout.write(`${JSON.stringify({ type: 'ink.probe', scope: 'pure-model-only', checks })}\n`)
  return Object.values(checks).every(Boolean) ? 0 : 1
}

async function interactiveProbe() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('CLI_INK_TTY_REQUIRED: run this probe in a real terminal, or use --self-check for pure-model checks.\n')
    return 2
  }
  process.stdout.write('Ink input probe: no database, files, model requests or credentials are loaded.\n')
  process.stdout.write('Try 中文、👩‍💻、👍🏽; resize; arrows; Backspace/Delete; Ctrl+J; paste; Ctrl+U. Enter submits, Ctrl+C/D cancels.\n')
  const editor = createInkInputEditor()
  try {
    for (let index = 0; index < 2; index += 1) {
      const text = await editor.question(`probe ${index + 1}/2> `)
      if (text === null) {
        process.stdout.write(`${JSON.stringify({ type: 'ink.probe', status: 'cancelled', rawMode: process.stdin.isRaw === true })}\n`)
        return 0
      }
      process.stdout.write(`${JSON.stringify({ type: 'ink.probe', status: 'submitted', text, rawMode: process.stdin.isRaw === true })}\n`)
    }
    return 0
  } finally { editor.close() }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--self-check') return checkPureModel()
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write('Usage: node tools/inkProbe.mjs [--self-check]\nInteractive probe requires Node 22+ and a real TTY. --self-check does not validate a real terminal.\n')
    return 0
  }
  if (args.length) {
    process.stderr.write('Unknown option. Usage: node tools/inkProbe.mjs [--self-check]\n')
    return 2
  }
  return interactiveProbe()
}

try { process.exitCode = await main() } catch (error) {
  process.stderr.write(`${error?.code || 'CLI_INK_PROBE_FAILED'}: ${error?.message || 'Input probe failed'}\n`)
  process.exitCode = 1
}

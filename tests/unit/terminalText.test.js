import assert from 'node:assert/strict'
import test from 'node:test'

import { stripAnsiSequences } from '../../src/lib/terminalText.js'

test('escape sequences meant for a terminal emulator are removed from command output', () => {
  // A real `node -e "console.log(1+1)"` came back as ESC[33m2 ESC[39m. The panel
  // is a command console, not a terminal emulator, so without this the reader sees
  // the escape bytes around every colourised line.
  assert.equal(stripAnsiSequences('\u001B[33m2\u001B[39m\n'), '2\n')
  assert.equal(stripAnsiSequences('\u001B[1;31merror\u001B[0m: bad'), 'error: bad')
  // Cursor moves and clears are sequences too, not text.
  assert.equal(stripAnsiSequences('\u001B[2K\u001B[1Gdone'), 'done')
  // A window title is an OSC sequence ending in BEL.
  assert.equal(stripAnsiSequences('\u001B]0;title\u0007body'), 'body')
  // Plain text, including text that merely mentions an escape, is untouched.
  assert.equal(stripAnsiSequences('plain text'), 'plain text')
  assert.equal(stripAnsiSequences(''), '')
  assert.equal(stripAnsiSequences(null), '')
  assert.equal(stripAnsiSequences('ArrowLeft \\u001B is not a sequence'), 'ArrowLeft \\u001B is not a sequence')
})

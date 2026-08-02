import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat no longer wires regenerate actions after results are reduced to copy-only', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /handleRegenerate|onRegenerate/)
  assert.doesNotMatch(source, /flushSync/)
})

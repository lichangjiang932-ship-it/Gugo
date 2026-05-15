import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('artifact preview iframes do not allow modal popups by default', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/RightPreviewPane.jsx', import.meta.url), 'utf8')

  assert.match(source, /sandbox="allow-scripts allow-forms"/)
  assert.doesNotMatch(source, /allow-modals/)
})

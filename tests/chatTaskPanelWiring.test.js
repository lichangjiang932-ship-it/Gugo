import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat split uses an inline task strip instead of the right live task panel', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')

  assert.match(source, /import ChatTaskStrip from '\.\/ChatTaskStrip'/)
  assert.match(source, /const tasks = state\.tasks/)
  assert.match(source, /hasTasks=\{tasks\.length > 0\}/)
  assert.match(source, /<ChatTaskStrip/)
  assert.doesNotMatch(source, /<ChatTaskPanel/)
})

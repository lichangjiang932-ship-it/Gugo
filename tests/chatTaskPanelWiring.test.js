import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat split keeps live task panel wiring in the chat workspace', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')

  assert.match(source, /import ChatTaskPanel from '\.\/ChatTaskPanel'/)
  assert.match(source, /const tasks = state\.tasks/)
  assert.match(source, /hasTasks=\{tasks\.length > 0\}/)
  assert.match(source, /<ChatTaskPanel/)
})

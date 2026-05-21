import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat page wires code mode to the Coding Workbench panel', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  assert.match(source, /CodingWorkbench/)
  assert.match(source, /agentMode === 'code'/)
})

test('Coding Workbench exposes diff, checks, and commit/push controls', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/CodingWorkbench.jsx', import.meta.url), 'utf8')
  assert.match(source, /Unified Diff/)
  assert.match(source, /npm run lint/)
  assert.match(source, /npm run test/)
  assert.match(source, /npm run build/)
  assert.ok(source.includes('\u63d0\u4ea4\u5e76\u63a8\u9001'))
})

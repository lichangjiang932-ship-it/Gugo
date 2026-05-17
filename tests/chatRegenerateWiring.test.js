import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('regenerate reads the latest session messages instead of stale closure state', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')

  assert.match(source, /const currentMessages = state\.sessions\.find\(\(s\) => s\.id === state\.activeSessionId\)\?\.messages \?\? EMPTY_MESSAGES/)
  assert.match(source, /currentMessages\[prevUserIdx\]\.content/)
  assert.doesNotMatch(source, /flushSync/)
})

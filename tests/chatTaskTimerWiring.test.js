import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat task cleanup timers do not accumulate in a retained ref', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /taskTimersRef/)
  assert.match(source, /setTimeout\(\(\) => dispatch\(\{ type: 'REMOVE_TASK', payload: taskId \}\), 5000\)/)
  assert.match(source, /setTimeout\(\(\) => dispatch\(\{ type: 'REMOVE_TASK', payload: taskId \}\), 3000\)/)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat task cleanup timers do not accumulate in a retained ref', () => {
  const controller = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const serverTurn = fs.readFileSync(new URL('../src/pages/ChatSplit/serverTurnFlow.js', import.meta.url), 'utf8')

  assert.doesNotMatch(`${controller}\n${serverTurn}`, /taskTimersRef/)
  const cleanupTimers = serverTurn.match(/setTimeout\(\(\) => dispatch\(\{ type: 'REMOVE_TASK', payload: taskId \}\), 5000\)/g) || []
  assert.equal(cleanupTimers.length, 3, 'paused, completed, and failed turns all schedule task cleanup')
})

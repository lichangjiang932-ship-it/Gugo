import test from 'node:test'
import assert from 'node:assert/strict'
import '../server/services/loop/index.js'
import { executeServerTool } from '../server/services/loop/heuristics/toolExecutor.js'

test('direct loop/index import initializes the default Agent batch dependency', async () => {
  const result = await executeServerTool({
    name: 'Agent',
    args: {
      tasks: [{ subagent_type: 'general', prompt: 'Inspect one bounded item.' }],
    },
    job: { id: 'agent-entry-test', userId: null },
    step: { id: 'agent-entry-step' },
  })

  assert.notEqual(result.code, 'subagent_runtime_unavailable')
  assert.match(result.error, /userId is required/)
})

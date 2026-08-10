import test from 'node:test'
import assert from 'node:assert/strict'

import {
  observeToolCalls,
  recordToolProgress,
  restoreToolProgress,
  serializeToolProgress,
  toolProgressPayload,
} from '../server/utils/toolProgress.js'

test('tool progress is executor-derived, cumulative, and idempotent by call id', () => {
  const progress = restoreToolProgress()
  const calls = [{ id: 'read-1' }, { id: 'write-1' }]
  observeToolCalls(progress, calls)
  recordToolProgress(progress, { call: calls[0], succeeded: false })
  recordToolProgress(progress, {
    call: calls[1],
    succeeded: true,
    changedPaths: ['src\\app.js'],
    changes: [{ path: 'src/app.js', additions: 4, deletions: 2 }],
  })
  recordToolProgress(progress, {
    call: calls[1],
    succeeded: true,
    changes: [{ path: 'src/app.js', additions: 4, deletions: 2 }],
  })

  assert.deepEqual(toolProgressPayload(progress, { iteration: 3, phase: 'tool_completed' }), {
    completed: 2,
    total: 2,
    iteration: 3,
    filesChanged: 1,
    additions: 4,
    deletions: 2,
    phase: 'tool_completed',
  })
})

test('tool progress checkpoint restoration preserves trusted counters', () => {
  const restored = restoreToolProgress({
    observedCallIds: ['a', 'b'],
    completedCallIds: ['a'],
    changedFiles: ['src\\a.js'],
    additions: 7,
    deletions: 1,
    hasLineStats: true,
  })

  assert.deepEqual(serializeToolProgress(restored), {
    observedCallIds: ['a', 'b'],
    completedCallIds: ['a'],
    changedFiles: ['src/a.js'],
    additions: 7,
    deletions: 1,
    hasLineStats: true,
  })
})

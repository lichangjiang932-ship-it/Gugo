import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasPendingTaskVerificationRepair,
  observeTaskVerificationMutation,
  observeTaskVerificationRepair,
  restoreTaskVerificationRepair,
} from '../server/services/loop/taskVerificationRepair.js'

function successfulTest(cwd) {
  return {
    call: { name: 'bash_exec', args: { command: 'npm test', cwd } },
    result: { ok: true, exitCode: 0 },
  }
}

test('verified-scope overflow is recoverable only through covering verification', () => {
  const state = restoreTaskVerificationRepair()
  for (let index = 0; index < 65; index += 1) {
    const { call, result } = successfulTest(`packages/p${index}`)
    observeTaskVerificationRepair(state, call, result, { workspaceRoot: 'D:/workspace' })
  }

  assert.equal(state.verified.size, 64)
  assert.equal(state.overflowScopes.size, 1)
  assert.equal(hasPendingTaskVerificationRepair(state), true)

  const { call, result } = successfulTest('.')
  observeTaskVerificationRepair(state, call, result, { workspaceRoot: 'D:/workspace' })

  assert.equal(state.verificationOverflowed, false)
  assert.equal(state.overflowScopes.size, 0)
  assert.equal(hasPendingTaskVerificationRepair(state), false)
  assert.deepEqual([...state.verified.values()].map(({ cwd }) => cwd), ['.'])
})

test('mutation-target overflow collapses to project scope without losing verification debt', () => {
  const state = restoreTaskVerificationRepair()
  observeTaskVerificationMutation(
    state,
    Array.from({ length: 65 }, (_, index) => `packages/p${index}/src/index.js`),
    { workspaceRoot: 'D:/workspace' },
  )

  assert.deepEqual([...state.mutationTargets.keys()], ['<workspace>'])
  assert.equal(state.verificationOverflowed, false)

  observeTaskVerificationRepair(state, {
    name: 'bash_exec', args: { command: 'npm test', cwd: 'packages/other' },
  }, {
    ok: false, exitCode: 1, stderr: 'packages/other/test.js failed',
  }, { workspaceRoot: 'D:/workspace', batchId: 'verification-batch' })

  assert.equal(state.pending.size, 1)
  assert.equal(hasPendingTaskVerificationRepair(state), true)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createJobRuntimeCore,
  createRuntimeCore,
  createTurnRuntimeCore,
} from '../server/services/runtimeCore.js'

test('runtime core exposes one checkpoint, lease, and approval lifecycle', () => {
  const calls = []
  const coordinator = {
    ownerId: 'runtime-owner',
    claim: (id) => {
      calls.push(['claim', id])
      return id === 'resource-1'
    },
    hold: (id, controller) => {
      calls.push(['hold', id, controller.signal.aborted])
      return () => calls.push(['release-lease', id])
    },
    isActive: (id) => id === 'resource-1',
    owns: (id) => id === 'resource-1',
    runIfOwned: (id, callback) => ({ owned: id === 'resource-1', value: callback() }),
    requestCancellation: (id) => id === 'resource-1',
  }
  const core = createRuntimeCore({
    checkpoint: {
      load: (scope) => ({ scope, state: { step: 1 } }),
      save: (input) => input,
      clear: (scope) => (scope.id === 'resource-1' ? 1 : 0),
      makeResumable: (input) => input,
    },
    executionLeases: coordinator,
    mapLeaseScope: (scope) => scope.id,
    releaseApprovals: (scope) => {
      calls.push(['release-approvals', scope.id])
      return 2
    },
  })

  const scope = { id: 'resource-1', userId: 'user-1' }
  assert.deepEqual(core.checkpoint.load(scope), { scope, state: { step: 1 } })
  assert.deepEqual(
    core.checkpoint.save(scope, { step: 2 }, { eventSequence: 7 }),
    { ...scope, state: { step: 2 }, eventSequence: 7 },
  )
  assert.deepEqual(
    core.checkpoint.makeResumable(scope, { resetBudget: true }),
    { ...scope, resetBudget: true },
  )
  assert.equal(core.checkpoint.clear(scope), 1)
  assert.equal(core.lease.ownerId, 'runtime-owner')
  assert.equal(core.lease.isActive(scope), true)
  assert.equal(core.lease.owns(scope), true)
  assert.equal(core.lease.runIfOwned(scope, () => 'committed').value, 'committed')
  assert.equal(core.lease.requestCancellation(scope), true)

  const lease = core.lease.acquire(scope)
  assert.ok(lease)
  lease.release()
  lease.release()
  assert.equal(calls.filter(([name]) => name === 'release-lease').length, 1)
  assert.equal(core.approval.release(scope), 2)
  assert.deepEqual(calls.at(-1), ['release-approvals', 'resource-1'])
})

test('job runtime core maps logical scopes to job lease ids', () => {
  const calls = []
  const core = createJobRuntimeCore({
    executionLeases: {
      claim: (jobId) => {
        calls.push(['claim', jobId])
        return true
      },
      hold: (jobId) => () => calls.push(['release', jobId]),
    },
    readCheckpoint: (scope) => scope,
    writeCheckpoint: (input) => input,
    clearCheckpoint: () => 1,
    resumeCheckpoint: (input) => input,
    releaseApprovals: (scope) => {
      calls.push(['approval', scope.jobId])
      return 1
    },
  })
  const scope = { jobId: 'job-1', stepId: 'step-1', userId: 'user-1' }

  const lease = core.lease.acquire(scope)
  assert.ok(lease)
  lease.release()
  assert.deepEqual(calls.slice(0, 2), [['claim', 'job-1'], ['release', 'job-1']])
  assert.deepEqual(core.checkpoint.load(scope), scope)
  assert.deepEqual(core.checkpoint.save(scope, { done: true }), { ...scope, state: { done: true } })
  assert.equal(core.approval.release(scope), 1)
})

test('turn runtime core preserves the full turn scope and checkpoint sequence', () => {
  let leaseScope = null
  let checkpoint = null
  const core = createTurnRuntimeCore({
    executionLeases: {
      claim: (scope) => {
        leaseScope = scope
        return true
      },
      hold: () => () => {},
    },
    readCheckpoint: () => checkpoint,
    writeCheckpoint: (input) => {
      checkpoint = input
      return input
    },
    clearCheckpoint: () => 1,
    releaseApprovals: () => 1,
  })
  const scope = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1' }

  const lease = core.lease.acquire(scope)
  assert.ok(lease)
  assert.deepEqual(leaseScope, scope)
  const saved = core.checkpoint.save(scope, { messages: [] }, { eventSequence: 3, now: 123 })
  assert.deepEqual(saved, { ...scope, state: { messages: [] }, eventSequence: 3, now: 123 })
  assert.deepEqual(core.checkpoint.load(scope), saved)
})

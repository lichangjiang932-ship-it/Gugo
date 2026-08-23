import assert from 'node:assert/strict'
import test from 'node:test'

import {
  releaseTurnEngineHostResources,
  releaseTurnEngineHostResourcesSync,
  throwTurnEngineHostFailures,
} from '../server/services/turnEngineHostCleanup.js'

test('initialization cleanup attempts every release and preserves the primary failure', () => {
  const primaryError = new Error('forced TurnEngine construction failure')
  const compactionError = new Error('forced compaction release failure')
  const calls = []
  const released = []

  const cleanup = releaseTurnEngineHostResourcesSync([
    {
      label: 'model binding',
      failureCode: 'MODEL_BINDING_RELEASE_FAILED',
      acceptAlreadyReleased: true,
      release() {
        calls.push('model')
        return false
      },
      onReleased() {
        released.push('model')
      },
    },
    {
      label: 'compaction archive',
      failureCode: 'COMPACTION_RELEASE_FAILED',
      release() {
        calls.push('compaction')
        throw compactionError
      },
      onReleased() {
        released.push('compaction')
      },
    },
    {
      label: 'persistence',
      failureCode: 'PERSISTENCE_RELEASE_FAILED',
      acceptAlreadyReleased: true,
      release() {
        calls.push('persistence')
        return true
      },
      onReleased() {
        released.push('persistence')
      },
    },
  ])

  assert.deepEqual(calls, ['model', 'compaction', 'persistence'])
  assert.deepEqual(released, ['model', 'persistence'])
  assert.equal(Object.isFrozen(cleanup), true)
  assert.equal(Object.isFrozen(cleanup.failures), true)
  assert.equal(Object.isFrozen(cleanup.pending), true)
  assert.deepEqual(cleanup.failures, [compactionError])
  assert.equal(cleanup.pending.length, 1)
  assert.equal(cleanup.pending[0].label, 'compaction archive')
  assert.throws(
    () => throwTurnEngineHostFailures(cleanup.failures, {
      primaryError,
      code: 'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
      message: 'initialization and cleanup failed',
    }),
    (error) => error instanceof AggregateError
      && error.code === 'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED'
      && error.retryable === true
      && error.cause === primaryError
      && error.errors.length === 2
      && error.errors[0] === primaryError
      && error.errors[1] === compactionError,
  )
})

test('shutdown cleanup retains only failed resources and retries them without skipping later releases', async () => {
  const thrownFailure = new Error('forced model binding release failure')
  const calls = { model: 0, compaction: 0, persistence: 0 }
  const resources = new Map([
    ['model', {
      label: 'model binding',
      failureCode: 'MODEL_BINDING_RELEASE_FAILED',
      acceptAlreadyReleased: true,
      release() {
        calls.model += 1
        if (calls.model === 1) throw thrownFailure
        return true
      },
    }],
    ['compaction', {
      label: 'compaction archive',
      failureCode: 'COMPACTION_RELEASE_FAILED',
      acceptAlreadyReleased: true,
      release() {
        calls.compaction += 1
        if (calls.compaction === 1) throw new Error('forced compaction release failure')
        return false
      },
    }],
    ['persistence', {
      label: 'persistence',
      failureCode: 'PERSISTENCE_RELEASE_FAILED',
      acceptAlreadyReleased: true,
      release() {
        calls.persistence += 1
        return true
      },
    }],
  ])

  const releaseActiveResources = async () => {
    const steps = [...resources].map(([id, resource]) => ({
      ...resource,
      onReleased() {
        resources.delete(id)
      },
    }))
    const cleanup = await releaseTurnEngineHostResources(steps)
    throwTurnEngineHostFailures(cleanup.failures, {
      code: 'TURN_ENGINE_HOST_CLEANUP_FAILED',
      message: 'host cleanup failed',
    })
  }

  await assert.rejects(
    releaseActiveResources(),
    (error) => error instanceof AggregateError
      && error.code === 'TURN_ENGINE_HOST_CLEANUP_FAILED'
      && error.retryable === true
      && error.cause === thrownFailure
      && error.errors[0] === thrownFailure
      && error.errors[1]?.message === 'forced compaction release failure',
  )
  assert.deepEqual(calls, { model: 1, compaction: 1, persistence: 1 })
  assert.deepEqual([...resources.keys()], ['model', 'compaction'])

  await releaseActiveResources()
  assert.deepEqual(calls, { model: 2, compaction: 2, persistence: 1 })
  assert.equal(resources.size, 0)
})

test('an unacknowledged release remains pending unless false is an accepted terminal state', () => {
  const step = {
    label: 'strict resource',
    failureCode: 'STRICT_RESOURCE_RELEASE_FAILED',
    release: () => false,
  }
  const cleanup = releaseTurnEngineHostResourcesSync([step])

  assert.equal(cleanup.failures.length, 1)
  assert.equal(cleanup.failures[0]?.code, 'STRICT_RESOURCE_RELEASE_FAILED')
  assert.equal(cleanup.failures[0]?.retryable, true)
  assert.deepEqual(cleanup.pending, [step])
})

test('one host cleanup failure keeps its identity and receives the stable host contract', () => {
  const failure = new Error('single release failure')
  assert.throws(
    () => throwTurnEngineHostFailures([failure], {
      code: 'TURN_ENGINE_HOST_CLEANUP_FAILED',
      message: 'host cleanup failed',
    }),
    (error) => error === failure
      && error.code === 'TURN_ENGINE_HOST_CLEANUP_FAILED'
      && error.retryable === true,
  )
})

test('a non-extensible cleanup failure is wrapped with a stable retryable host contract', () => {
  const failure = Object.freeze(new Error('frozen release failure'))
  assert.throws(
    () => throwTurnEngineHostFailures([failure], {
      code: 'TURN_ENGINE_HOST_CLEANUP_FAILED',
      message: 'host cleanup failed',
    }),
    (error) => error !== failure
      && error.code === 'TURN_ENGINE_HOST_CLEANUP_FAILED'
      && error.retryable === true
      && error.cause === failure
      && error.message === failure.message,
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHECKPOINT_FLUSH_ERROR_CODE,
  CheckpointFlushError,
  createCheckpointBarrier,
  flushCheckpoint,
} from '../server/services/loop/checkpoint.js'

test('unconfigured checkpoint barriers are compatible no-ops', async () => {
  let stateFactoryCalls = 0
  const barrier = createCheckpointBarrier({
    stateFactory: () => {
      stateFactoryCalls += 1
      return { messages: [] }
    },
  })

  assert.equal(barrier.enabled, false)
  assert.equal(await barrier.flush(), undefined)
  assert.equal(await barrier.beforeSideEffect({ meta: { boundary: 'tool' } }), undefined)
  assert.equal(stateFactoryCalls, 0)
  assert.equal(await flushCheckpoint(), undefined)
})

test('each barrier invocation takes and persists a fresh state before returning', async () => {
  const order = []
  const savedStates = []
  let revision = 0
  const barrier = createCheckpointBarrier({
    stateFactory: async (meta) => {
      order.push(`snapshot:${meta.boundary}`)
      return { revision: ++revision }
    },
    saveCheckpoint: async (state, meta) => {
      order.push(`save:${state.revision}:${meta.boundary}`)
      savedStates.push(state)
      return true
    },
  })

  await barrier.beforeSideEffect({ meta: { boundary: 'model' } })
  order.push('model')
  await barrier.beforeSideEffect({ meta: { boundary: 'tool' } })
  order.push('tool')

  assert.equal(barrier.enabled, true)
  assert.deepEqual(savedStates, [{ revision: 1 }, { revision: 2 }])
  assert.deepEqual(order, [
    'snapshot:model',
    'save:1:model',
    'model',
    'snapshot:tool',
    'save:2:tool',
    'tool',
  ])
})

test('base and per-flush metadata merge without polluting checkpoint state', async () => {
  const state = { messages: ['user'], nested: { stable: true } }
  let factoryMeta
  let receivedState
  let receivedMeta
  const barrier = createCheckpointBarrier({
    meta: { turnId: 'turn-1', boundary: 'base' },
    stateFactory: (meta) => {
      factoryMeta = meta
      return state
    },
    saveCheckpoint: async (nextState, meta) => {
      receivedState = nextState
      receivedMeta = meta
    },
  })

  await barrier.flush({ meta: { boundary: 'tool', toolCallId: 'call-1' } })

  assert.equal(receivedState, state)
  assert.deepEqual(receivedState, { messages: ['user'], nested: { stable: true } })
  assert.deepEqual(factoryMeta, {
    turnId: 'turn-1',
    boundary: 'tool',
    toolCallId: 'call-1',
  })
  assert.equal(receivedMeta, factoryMeta)
})

test('per-flush state and state factory overrides are supported', async () => {
  const states = []
  let defaultFactoryCalls = 0
  const barrier = createCheckpointBarrier({
    stateFactory: () => {
      defaultFactoryCalls += 1
      return { source: 'default' }
    },
    saveCheckpoint: async (state) => { states.push(state) },
  })

  const explicitState = { source: 'explicit' }
  await barrier.flush({ state: explicitState })
  await barrier.flush({ stateFactory: () => ({ source: 'override' }) })
  await barrier.flush()

  assert.equal(states[0], explicitState)
  assert.deepEqual(states.slice(1), [
    { source: 'override' },
    { source: 'default' },
  ])
  assert.equal(defaultFactoryCalls, 1)
})

test('a thrown persistence error is normalized, retryable, and keeps its cause', async () => {
  const cause = Object.assign(new Error('database busy'), { code: 'SQLITE_BUSY' })
  const barrier = createCheckpointBarrier({
    stateFactory: () => ({ revision: 4 }),
    saveCheckpoint: async () => { throw cause },
    meta: { turnId: 'turn-4' },
  })

  await assert.rejects(barrier.flush(), (error) => {
    assert.ok(error instanceof CheckpointFlushError)
    assert.equal(error.code, CHECKPOINT_FLUSH_ERROR_CODE)
    assert.equal(error.code, 'CHECKPOINT_FLUSH_FAILED')
    assert.equal(error.retryable, true)
    assert.equal(error.cause, cause)
    assert.deepEqual(error.meta, { turnId: 'turn-4' })
    return true
  })
})

test('false and null persistence results fail closed', async () => {
  for (const result of [false, null]) {
    let sideEffectCalls = 0
    const barrier = createCheckpointBarrier({
      stateFactory: () => ({ pending: true }),
      saveCheckpoint: async () => result,
    })

    await assert.rejects(
      barrier.beforeSideEffect().then(() => { sideEffectCalls += 1 }),
      (error) => error?.code === 'CHECKPOINT_FLUSH_FAILED' && error?.retryable === true,
    )
    assert.equal(sideEffectCalls, 0)
  }
})

test('state snapshot failures also close the barrier and preserve the cause', async () => {
  const cause = new Error('cannot serialize state')
  let saveCalls = 0
  const barrier = createCheckpointBarrier({
    stateFactory: () => { throw cause },
    saveCheckpoint: async () => { saveCalls += 1 },
  })

  await assert.rejects(barrier.flush(), (error) => (
    error?.code === 'CHECKPOINT_FLUSH_FAILED'
      && error?.retryable === true
      && error?.cause === cause
  ))
  assert.equal(saveCalls, 0)
})

test('successful undefined persistence results remain compatible', async () => {
  const state = { messages: [] }
  let received

  assert.equal(await flushCheckpoint({
    state,
    saveCheckpoint: async (checkpoint) => { received = checkpoint },
  }), undefined)
  assert.equal(received, state)
})

test('invalid checkpoint dependency configuration is rejected', async () => {
  assert.throws(
    () => createCheckpointBarrier({ saveCheckpoint: true }),
    /saveCheckpoint must be a function/,
  )
  assert.throws(
    () => createCheckpointBarrier({ stateFactory: {} }),
    /stateFactory must be a function/,
  )
  await assert.rejects(
    flushCheckpoint({ saveCheckpoint: 'configured' }),
    /saveCheckpoint must be a function/,
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopContext } from '../server/services/loop/context.js'
import {
  prepareToolsLoopRuntime,
  usePreparedToolsLoopRuntime as accessPreparedToolsLoopRuntime,
} from '../server/services/loop/runtime.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function createTrackedModelState({ runModel }) {
  const checkpoints = []
  const context = createLoopContext({
    job: {
      id: 'tracked-model-request-fence-turn',
      userId: 'tracked-model-request-fence-user',
      sessionId: 'tracked-model-request-fence-session',
      origin: 'chat',
      prompt: 'Answer once.',
      modelName: 'user-configured-model',
      modelProviderId: 'user-configured-provider',
      modelConfigRevision: 1,
    },
    step: { id: 'tracked-model-request-fence-turn', kind: 'chat' },
    messages: [{ role: 'user', content: 'Answer once.' }],
    toolSpecs: [],
    maxIters: 1,
    runModel,
    saveCheckpoint: async (state, meta = {}) => {
      checkpoints.push({
        boundary: meta.boundary || null,
        state: structuredClone(state),
      })
      return true
    },
  })
  const prepared = await prepareToolsLoopRuntime(context)
  let state
  accessPreparedToolsLoopRuntime(prepared, (preparedState) => {
    state = preparedState
  })
  return { checkpoints, state }
}

function requestFor(state, options = {}) {
  return state.callTrackedModel({
    messages: state.convo,
    tools: [],
    toolChoice: 'none',
    allowOverBudget: false,
    ...options,
  })
}

test('tracked model request forwards its scoped signal and fences a late provider response', async () => {
  const providerStarted = deferred()
  const providerResult = deferred()
  let observedSignal = null
  const { checkpoints, state } = await createTrackedModelState({
    runModel: async (request) => {
      observedSignal = request.signal
      providerStarted.resolve()
      return providerResult.promise
    },
  })
  const controller = new AbortController()
  const revoked = new Error('tracked model request ownership was revoked')
  revoked.code = 'TRACKED_MODEL_REQUEST_REVOKED'
  let active = true

  const pending = requestFor(state, {
    requestSignal: controller.signal,
    assertRequestActive() {
      if (!active) throw revoked
    },
  })
  await providerStarted.promise
  assert.equal(observedSignal, controller.signal)

  active = false
  controller.abort(revoked)
  providerResult.resolve({ content: 'late provider response', toolCalls: [] })

  await assert.rejects(pending, (error) => error === revoked)
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.boundary),
    ['model-request'],
  )
  assert.equal(state.modelInvocation.status, 'in_flight')
})

test('tracked model request fence wins over a late provider error without a failed checkpoint', async () => {
  const providerStarted = deferred()
  const providerResult = deferred()
  const { checkpoints, state } = await createTrackedModelState({
    runModel: async () => {
      providerStarted.resolve()
      return providerResult.promise
    },
  })
  const revoked = new Error('tracked model error path was revoked')
  let active = true
  const pending = requestFor(state, {
    assertRequestActive() {
      if (!active) throw revoked
    },
  })
  await providerStarted.promise

  active = false
  providerResult.reject(new Error('late private provider failure'))

  await assert.rejects(pending, (error) => error === revoked)
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.boundary),
    ['model-request'],
  )
  assert.equal(state.modelInvocation.status, 'in_flight')
})

test('tracked model request fence blocks a late provider-attempt checkpoint', async () => {
  const providerStarted = deferred()
  const releaseProviderAttempt = deferred()
  const { checkpoints, state } = await createTrackedModelState({
    runModel: async (request) => {
      providerStarted.resolve()
      await releaseProviderAttempt.promise
      await request.onProviderAttempt({
        sequence: 1,
        providerAttempt: 1,
        failoverIndex: 0,
        providerId: 'user-configured-provider',
        modelName: 'user-configured-model',
      })
      return { content: 'must not commit', toolCalls: [] }
    },
  })
  const revoked = new Error('tracked provider attempt was revoked')
  let active = true
  const pending = requestFor(state, {
    assertRequestActive() {
      if (!active) throw revoked
    },
  })
  await providerStarted.promise

  active = false
  releaseProviderAttempt.resolve()

  await assert.rejects(pending, (error) => error === revoked)
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.boundary),
    ['model-request'],
  )
  assert.equal(state.modelInvocation.status, 'in_flight')
})

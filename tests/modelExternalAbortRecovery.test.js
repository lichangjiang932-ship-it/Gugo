import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callBackgroundModelWithTools,
  callStreamingModelWithTools,
} from '../server/adapters/modelProxy.js'
import { runToolLoop } from '../server/services/loop/index.js'

const MODEL_NAME = 'abort-boundary-model'

function modelEnv() {
  return {
    MODEL_BASE_URL: 'https://provider.example/v1',
    MODEL_NAME,
  }
}

function failoverEnv() {
  return {
    MODEL_NAME,
    MODEL_PROVIDERS: 'primary,backup',
    MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
    MODEL_PROVIDER_PRIMARY_MODELS: MODEL_NAME,
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
    MODEL_PROVIDER_BACKUP_MODELS: MODEL_NAME,
    MODEL_FAILOVER_CROSS_PROVIDER: '1',
  }
}

function cancellationError(message = 'user stopped the turn') {
  return Object.assign(new Error(message), {
    name: 'AbortError',
    code: 'TURN_CANCEL_REQUESTED',
  })
}

const transports = [
  {
    name: 'streaming',
    call: (options) => callStreamingModelWithTools({
      messages: [{ role: 'user', content: 'answer once' }],
      tools: [],
      ...options,
    }),
  },
  {
    name: 'non-streaming',
    call: (options) => callBackgroundModelWithTools({
      messages: [{ role: 'user', content: 'answer once' }],
      tools: [],
      ...options,
    }),
  },
]

for (const transport of transports) {
  test(`${transport.name} preserves a pre-send cancellation and never calls fetch`, async () => {
    const controller = new AbortController()
    const cancellation = cancellationError()
    controller.abort(cancellation)
    let fetchCalls = 0

    await assert.rejects(
      transport.call({
        signal: controller.signal,
        modelRequestId: `mr_${transport.name}_pre_send_abort`,
        env: modelEnv(),
        fetchImpl: async () => {
          fetchCalls += 1
          throw new Error('fetch must not run')
        },
      }),
      (error) => error === cancellation
        && error?.name === 'AbortError'
        && error?.code === 'TURN_CANCEL_REQUESTED'
        && error?.modelRequestOutcome === 'not_sent',
    )

    assert.equal(fetchCalls, 0)
  })

  test(`${transport.name} converts an external abort after fetch starts to outcome unknown`, async () => {
    const controller = new AbortController()
    const cancellation = cancellationError('cancelled after dispatch')
    const urls = []

    await assert.rejects(
      transport.call({
        signal: controller.signal,
        modelRequestId: `mr_${transport.name}_post_send_abort`,
        env: failoverEnv(),
        fetchImpl: async (url, init) => {
          urls.push(String(url))
          controller.abort(cancellation)
          throw init.signal.reason || cancellation
        },
      }),
      (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
        && error?.unsafeToReplay === true
        && error?.requiresUserVerification === true
        && error?.modelRequestId === `mr_${transport.name}_post_send_abort`,
    )

    assert.deepEqual(urls, ['https://primary.example/v1/chat/completions'])
  })
}

function loopOptions({ runModel, saveCheckpoint }) {
  return {
    job: {
      id: 'external-abort-loop-turn',
      userId: 'external-abort-loop-user',
      origin: 'chat',
      prompt: 'answer once',
      modelName: MODEL_NAME,
      modelProviderId: 'primary',
      modelConfigRevision: 1,
    },
    step: { id: 'external-abort-loop-turn', kind: 'chat' },
    messages: [{ role: 'user', content: 'answer once' }],
    toolSpecs: [],
    maxIters: 1,
    runModel,
    saveCheckpoint,
  }
}

test('the loop checkpoints a known pre-send cancellation as not_sent', async () => {
  const checkpoints = []
  const cancellation = cancellationError()
  cancellation.modelRequestOutcome = 'not_sent'

  await assert.rejects(runToolLoop(loopOptions({
    runModel: async () => { throw cancellation },
    saveCheckpoint: async (state, meta) => {
      checkpoints.push({ boundary: meta?.boundary, state: structuredClone(state) })
      return true
    },
  })), (error) => error === cancellation)

  const notSent = checkpoints.find((entry) => entry.boundary === 'model-request-not-sent')
  assert.equal(notSent?.state?.modelInvocation?.status, 'not_sent')
  assert.equal(checkpoints.some((entry) => entry.boundary === 'model-request-failed'), false)
})

test('non-streaming keeps forwarding cancellation while the response body is being read', async () => {
  const controller = new AbortController()
  const cancellation = cancellationError('cancelled while reading response body')
  let bodyStartedResolve
  const bodyStarted = new Promise((resolve) => { bodyStartedResolve = resolve })
  let fetchCalls = 0

  const pending = callBackgroundModelWithTools({
    messages: [{ role: 'user', content: 'return a slow response body' }],
    tools: [],
    signal: controller.signal,
    modelRequestId: 'mr_non_streaming_body_abort',
    env: modelEnv(),
    fetchImpl: async (_url, init) => {
      fetchCalls += 1
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => new Promise((resolve, reject) => {
          const onAbort = () => reject(init.signal.reason || cancellation)
          if (init.signal.aborted) onAbort()
          else init.signal.addEventListener('abort', onAbort, { once: true })
          bodyStartedResolve()
        }),
      }
    },
  })

  await bodyStarted
  controller.abort(cancellation)
  await assert.rejects(pending, (error) => (
    error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      && error?.unsafeToReplay === true
      && error?.modelRequestId === 'mr_non_streaming_body_abort'
      && error?.transportPhase === 'response'
  ))
  assert.equal(fetchCalls, 1)
})

test('the loop keeps an ambiguous post-send cancellation in flight', async () => {
  const checkpoints = []
  const unknown = Object.assign(new Error('provider outcome unknown after cancellation'), {
    code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
    unsafeToReplay: true,
  })

  await assert.rejects(runToolLoop(loopOptions({
    runModel: async () => { throw unknown },
    saveCheckpoint: async (state, meta) => {
      checkpoints.push({ boundary: meta?.boundary, state: structuredClone(state) })
      return true
    },
  })), (error) => error === unknown)

  const request = checkpoints.find((entry) => entry.boundary === 'model-request')
  assert.equal(request?.state?.modelInvocation?.status, 'in_flight')
  assert.equal(checkpoints.some((entry) => (
    ['model-request-failed', 'model-request-not-sent'].includes(entry.boundary)
  )), false)
})

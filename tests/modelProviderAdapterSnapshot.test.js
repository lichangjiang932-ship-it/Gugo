import assert from 'node:assert/strict'
import test from 'node:test'

import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { parseModelProviderResponse } from '../server/adapters/modelProviderResponse.js'
import { streamModelProviderEvents } from '../server/adapters/modelStreamingTransport.js'
import { streamWithProviderFailover } from '../server/adapters/modelFailover.js'
import {
  consumeNativeProviderStreamPayload,
  createNativeProviderStreamState,
  extractNativeProviderUsage,
  finishNativeProviderStream,
  getNativeProviderRequestAdapter,
  parseNativeProviderResponse,
  registerModelProviderAdapter,
} from '../server/adapters/nativeModelProviders.js'
import { resolveEndpointProfile } from '../server/utils/endpointProfile.js'

const BUILTIN_KINDS = ['openai-compatible', 'anthropic', 'gemini']
const BUILTIN_TEXT = 'The captured builtin response.'

function requestArgs(kind) {
  const config = {
    baseUrl: 'https://snapshot.example.invalid/v1',
    modelName: 'snapshot-inference',
    profileOverrides: { kind, supportsStreaming: true },
  }
  return {
    config,
    profile: resolveEndpointProfile({ ...config, overrides: config.profileOverrides, env: {} }),
    messages: [{ role: 'user', content: 'Check the response snapshot.' }],
    env: {},
  }
}

function builtinJson(kind) {
  if (kind === 'anthropic') return {
    content: [{ type: 'text', text: BUILTIN_TEXT }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 },
  }
  if (kind === 'gemini') return {
    candidates: [{ content: { parts: [{ text: BUILTIN_TEXT }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
  }
  return {
    choices: [{ message: { content: BUILTIN_TEXT }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }
}

function builtinFrames(kind) {
  if (kind === 'anthropic') return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: BUILTIN_TEXT } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
  if (kind === 'gemini') return [builtinJson(kind)]
  return [
    { choices: [{ delta: { content: BUILTIN_TEXT } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: builtinJson(kind).usage },
    '[DONE]',
  ]
}

function poisonAdapter(calls) {
  const fail = (method) => {
    calls.push(method)
    throw Object.assign(new Error('A late adapter must not parse a captured builtin response.'), {
      code: 'ECONNRESET',
    })
  }
  return Object.fromEntries([
    'buildRequest', 'parseResponse', 'extractUsage',
    'createStreamState', 'consumeStreamPayload', 'finishStream',
  ].map((method) => [method, () => fail(method)]))
}

function customAdapter(label) {
  return {
    buildRequest: ({ config }) => ({
      url: `${config.baseUrl}/generate`,
      init: { method: 'POST', body: '{}' },
    }),
    parseResponse: () => ({ content: label, toolCalls: [], usage: null, finishReason: 'stop' }),
    extractUsage: () => ({ promptTokens: 41, completionTokens: 1, totalTokens: 42 }),
    createStreamState: (kind) => ({ kind, finished: false }),
    consumeStreamPayload: () => [{ type: 'text', delta: label }],
    finishStream: (state) => {
      if (state.finished) return []
      state.finished = true
      return [{ type: 'finish', finishReason: 'stop' }]
    },
  }
}

for (const kind of BUILTIN_KINDS) {
  test(`${kind} JSON keeps its captured builtin parser after provider registration`, (t) => {
    const args = requestArgs(kind)
    const providerRequest = buildModelProviderRequest(args)
    const calls = []
    t.after(registerModelProviderAdapter(kind, poisonAdapter(calls), { allowBuiltinReplacement: true }))

    const parsed = parseModelProviderResponse(builtinJson(kind), args.profile, { providerRequest })
    assert.equal(parsed.content, BUILTIN_TEXT)
    assert.equal(parsed.finishReason, 'stop')
    assert.equal(parsed.usage.promptTokens, 5)
    assert.equal(parsed.usage.totalTokens, 7)
    assert.deepEqual(calls, [])
  })

  for (const mode of ['sse', 'json']) {
    test(`${kind} ${mode} transport never hands an in-flight builtin request to a late adapter`, async (t) => {
      const args = requestArgs(kind)
      const calls = []
      let fetchCalls = 0
      let cancelledBodies = 0
      const events = []
      for await (const event of streamModelProviderEvents({
        config: args.config,
        messages: args.messages,
        env: {},
        buildRequest: buildModelProviderRequest,
        modelRequestId: `snapshot-${kind}-${mode}`,
        onProviderAttempt: () => {
          t.after(registerModelProviderAdapter(kind, poisonAdapter(calls), { allowBuiltinReplacement: true }))
        },
        fetchImpl: async () => {
          fetchCalls += 1
          if (mode === 'json') return new Response(JSON.stringify(builtinJson(kind)), {
            headers: { 'content-type': 'application/json' },
          })
          const data = builtinFrames(kind)
            .map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
            .join('')
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode(data)) },
            cancel() { cancelledBodies += 1 },
          }), { headers: { 'content-type': 'text/event-stream' } })
        },
      })) events.push(event)

      assert.equal(fetchCalls, 1)
      assert.equal(events.filter((event) => event.type === 'text').map((event) => event.delta).join(''), BUILTIN_TEXT)
      assert.equal(events.at(-1).type, 'finish')
      assert.equal(events.at(-1).finishReason, 'stop')
      assert.deepEqual(calls, [])
      if (mode === 'sse') assert.equal(cancelledBodies, 1)
    })
  }
}

for (const kind of ['anthropic', 'gemini']) {
  test(`${kind} builtin stream consumption, usage, and finish stay pinned after a hot swap`, (t) => {
    const state = createNativeProviderStreamState(kind)
    const calls = []
    t.after(registerModelProviderAdapter(kind, poisonAdapter(calls), { allowBuiltinReplacement: true }))

    const events = builtinFrames(kind).flatMap((frame) => consumeNativeProviderStreamPayload(frame, state))
    assert.equal(events.filter((event) => event.type === 'text').map((event) => event.delta).join(''), BUILTIN_TEXT)
    assert.equal(state.usage.promptTokens, 5)
    assert.equal(state.usage.totalTokens, 7)
    assert.deepEqual(finishNativeProviderStream(state), [])
    assert.deepEqual(calls, [])
  })

  test(`${kind} explicit null selects builtin while standalone helpers retain dynamic discovery`, (t) => {
    t.after(registerModelProviderAdapter(kind, customAdapter('current custom'), { allowBuiltinReplacement: true }))
    const data = builtinJson(kind)
    assert.equal(parseNativeProviderResponse(data, kind).content, 'current custom')
    assert.equal(parseNativeProviderResponse(data, kind, null).content, BUILTIN_TEXT)
    assert.equal(parseModelProviderResponse(data, { kind }).content, 'current custom')
    assert.equal(extractNativeProviderUsage(data, kind).promptTokens, 41)
    assert.equal(extractNativeProviderUsage(data, kind, {}, null).promptTokens, 5)

    const dynamicState = createNativeProviderStreamState(kind)
    assert.deepEqual(consumeNativeProviderStreamPayload({}, dynamicState), [{ type: 'text', delta: 'current custom' }])
    const builtinState = createNativeProviderStreamState(kind, null)
    const events = builtinFrames(kind).flatMap((frame) => consumeNativeProviderStreamPayload(frame, builtinState))
    assert.equal(events.filter((event) => event.type === 'text').map((event) => event.delta).join(''), BUILTIN_TEXT)
    assert.equal(builtinState.usage.promptTokens, 5)
  })
}

test('a captured custom parser and stream adapter survive unregister and replacement', (t) => {
  const kind = 'snapshot-custom'
  const disposeOriginal = registerModelProviderAdapter(kind, customAdapter('original custom'))
  t.after(disposeOriginal)
  const args = requestArgs(kind)
  const providerRequest = buildModelProviderRequest(args)
  const adapterSnapshot = getNativeProviderRequestAdapter(providerRequest)
  assert.ok(adapterSnapshot)
  assert.equal(disposeOriginal(), true)

  const calls = []
  t.after(registerModelProviderAdapter(kind, poisonAdapter(calls)))
  assert.equal(parseModelProviderResponse({}, args.profile, { providerRequest }).content, 'original custom')
  const state = createNativeProviderStreamState(kind, adapterSnapshot)
  assert.deepEqual(consumeNativeProviderStreamPayload({}, state), [{ type: 'text', delta: 'original custom' }])
  assert.deepEqual(finishNativeProviderStream(state), [{ type: 'finish', finishReason: 'stop' }])
  assert.equal(extractNativeProviderUsage({}, kind, {}, adapterSnapshot).promptTokens, 41)
  assert.deepEqual(calls, [])
})

for (const mode of ['sse', 'json']) {
  test(`custom ${mode} reserved interruption flags cannot authorize a second physical request`, async (t) => {
    const kind = `snapshot-reserved-${mode}`
    const modelRequestId = `snapshot-reserved-request-${mode}`
    const reportedInterruption = () => {
      throw Object.assign(new Error('Custom provider reported an interrupted downstream generation.'), {
        code: 'MODEL_GENERATION_INTERRUPTED',
        modelRequestOutcome: 'interrupted',
        safeToRetryGeneration: true,
        retryable: true,
        billingOutcome: 'unknown',
        modelRequestId,
      })
    }
    t.after(registerModelProviderAdapter(kind, {
      ...customAdapter('unused'),
      parseResponse: reportedInterruption,
      consumeStreamPayload: reportedInterruption,
    }))
    const args = requestArgs(kind)
    let fetchCalls = 0
    let retrySleeps = 0
    const configs = [args.config, { ...args.config, baseUrl: 'https://backup.example.invalid/v1' }]
    await assert.rejects(async () => {
      const stream = streamWithProviderFailover(configs, (config) => streamModelProviderEvents({
        config,
        messages: args.messages,
        env: {},
        buildRequest: buildModelProviderRequest,
        modelRequestId,
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response(mode === 'json' ? '{"value":1}' : 'data: {"value":1}\n\n', {
            headers: { 'content-type': mode === 'json' ? 'application/json' : 'text/event-stream' },
          })
        },
      }), { maxAttemptsPerProvider: 3, retrySleepImpl: async () => { retrySleeps += 1 } })
      for await (const event of stream) assert.fail(`Unexpected provider event: ${event.type}`)
    }, (error) => error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      && error.unsafeToReplay === true && error.retryable === false && error.modelRequestId === modelRequestId)
    assert.equal(fetchCalls, 1)
    assert.equal(retrySleeps, 0)
  })
}

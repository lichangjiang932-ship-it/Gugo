import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { callBackgroundModelWithTools, callStreamingModelWithTools } from '../server/adapters/modelInvocationRuntime.js'
import { streamOpenAICompatible } from '../server/adapters/modelProxyResponseCoordinator.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { emitWirePreparation, requireContextDiagnosticDurability } from '../server/services/loop/runtimeContextDiagnostics.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { formatProgressEvent } from '../bin/cli/runDiagnostics.js'
import { summarizeTurnTrace } from '../server/services/localTurnTraceService.js'
import { buildTurnTraceSpans } from '../server/services/turnTraceSpans.js'

const messages = [{ role: 'system', content: 'PRIVATE_INSTRUCTIONS' }, { role: 'user', content: 'Hello.' }, { role: 'system', content: 'PRIVATE_MID_CONTROL' }]
const envFor = (kind) => ({ MODEL_BASE_URL: kind === 'anthropic' ? 'https://api.anthropic.com' : kind === 'gemini'
  ? 'https://generativelanguage.googleapis.com/v1beta' : 'http://127.0.0.1:43211/v1',
MODEL_NAME: kind === 'anthropic' ? 'claude-fixture' : kind === 'gemini' ? 'gemini-fixture' : 'fixture-model', MODEL_API_KEY: 'PRIVATE_KEY', MODEL_STREAM_USAGE: '0' })
const responseFor = (kind) => kind === 'anthropic' ? { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }
  : kind === 'gemini' ? { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }
    : { choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } }
const hash = (value) => createHash('sha256').update(value).digest('hex')

for (const kind of ['openai-compatible', 'anthropic', 'gemini']) {
  for (const streaming of [false, true]) {
    test(`${kind} ${streaming ? 'streaming' : 'nonstream'} mock-fetch sees exactly the fingerprinted adapted body`, async () => {
      let attempt
      let fetches = 0
      const call = streaming ? callStreamingModelWithTools : callBackgroundModelWithTools
      const result = await call({ messages, tools: [], env: envFor(kind), userId: null, usageOwnerId: 'wire-owner',
        modelRequestId: 'wire-fixture-request', onProviderAttempt: async (value) => { attempt = value },
        fetchImpl: async (_url, init) => {
          fetches += 1
          assert.ok(attempt?.wireDiagnostics, 'wire facts must exist before fetch')
          const wire = attempt.wireDiagnostics
          assert.equal(wire.bodyFingerprint, hash(`gugo:wire:v1:body:${wire.ownerScopeFingerprint}\0${init.body}`))
          const body = JSON.parse(init.body)
          const prefix = kind === 'anthropic' ? body.system : kind === 'gemini' ? body.systemInstruction : body.messages.slice(0, 1)
          assert.equal(wire.prefixFingerprint, hash(`gugo:wire:v1:prefix:${wire.ownerScopeFingerprint}\0${JSON.stringify(prefix)}`))
          assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_|api\.anthropic|googleapis/u)
          assert.doesNotMatch(init.body, /wireDiagnostics|bodyFingerprint/u)
          return new Response(JSON.stringify(responseFor(kind)), { headers: { 'content-type': 'application/json' } })
        },
      })
      assert.equal(fetches, 1)
      assert.equal(result.content, 'Done.')
    })
  }
}

test('nonstream fallback preserves wire diagnostics and the original owner', async () => {
  let observed
  let fetches = 0
  for await (const _event of streamOpenAICompatible({
    config: { baseUrl: 'http://127.0.0.1:43211/v1', modelName: 'fixture', profileOverrides: { supportsStreaming: false } },
    messages, tools: [], env: {}, cacheOwnerId: 'fallback-owner',
    onProviderAttempt: async (value) => { observed = value.wireDiagnostics },
    fetchImpl: async (_url, init) => { fetches += 1; assert.equal(JSON.parse(init.body).stream, false); return new Response(JSON.stringify(responseFor('openai-compatible'))) },
  })) { assert.ok(_event) }
  assert.equal(fetches, 1)
  assert.ok(observed.ownerScopeFingerprint)
})

test('real loop publishes wire phase only after the durable physical attempt and before fetch', async () => {
  const phases = []
  const checkpoints = []
  let fetches = 0
  const result = await runToolLoop({ job: { id: 'wire-loop', userId: 'wire-loop-owner', origin: 'chat' },
    step: { id: 'wire-step', kind: 'chat' }, messages: [{ role: 'user', content: 'Hello.' }], toolSpecs: [],
    maxIters: 1, enableToolHooks: false,
    saveCheckpoint: async (state) => { checkpoints.push(structuredClone(state)); return { state } },
    onModelPhase: async (event) => {
      if (event.phase === 'wire_prepared') assert.ok(checkpoints.at(-1).modelInvocation.providerAttempts.length > 0)
      phases.push(event)
    },
    runModel: (request) => callBackgroundModelWithTools({ ...request, env: envFor('openai-compatible'), usageOwnerId: 'wire-loop-owner',
      fetchImpl: async () => { fetches += 1; assert.equal(phases.at(-1).phase, 'wire_prepared'); return new Response(JSON.stringify(responseFor('openai-compatible'))) },
    }),
  })
  assert.equal(result.text, 'Done.')
  assert.equal(fetches, 1)
  const phase = phases.find((event) => event.phase === 'wire_prepared')
  const event = createTurnEvent({ id: 'wire-event', userId: 'wire-loop-owner', sessionId: 'session', turnId: 'turn', sequence: 1, type: 'model.phase', payload: phase })
  assert.match(formatProgressEvent(event), /wire prepared.*no KV-hit measurement/u)
  const trace = buildTurnTraceSpans({ turnId: 'turn', events: [event] })
  assert.equal(trace.spans.find((span) => span.name.startsWith('model.')).attributes.modelRequestId, phase.modelRequestId)
  assert.equal(summarizeTurnTrace([event]).cacheUsageReported, false)
  assert.equal(summarizeTurnTrace([event]).wirePreparations, 1)
  assert.equal(summarizeTurnTrace([event, { type: 'model.phase', payload: { phase: 'completed', usage: { cacheHitTokens: 0 } } }]).cacheUsageReported, true)
})

test('optional observer failure cannot block or repeat a request; durable failure is not_sent with zero fetches', async () => {
  for (const durable of [false, true]) {
    const failure = Object.assign(new Error('PRIVATE_OBSERVER_MESSAGE'), { code: 'TURN_EVENT_PERSISTENCE_FAILED', status: 503 })
    const observer = async () => { throw failure }
    const state = { iter: 0, onModelPhase: durable ? requireContextDiagnosticDurability(observer) : observer }
    let fetches = 0
    let attempts = 0
    const pending = callBackgroundModelWithTools({ messages, tools: [], env: envFor('openai-compatible'), usageOwnerId: 'wire-owner', modelRequestId: 'observer-request',
      onProviderAttempt: async (attempt) => { attempts += 1; await emitWirePreparation(state, { wireDiagnostics: attempt.wireDiagnostics, modelRequestId: 'observer-request', physicalAttempt: attempt.sequence }) },
      fetchImpl: async () => { fetches += 1; return new Response(JSON.stringify(responseFor('openai-compatible'))) },
    })
    if (durable) await assert.rejects(pending, (error) => error.code === failure.code && error.modelRequestOutcome === 'not_sent' && error.retryable === false)
    else assert.equal((await pending).content, 'Done.')
    assert.equal(attempts, 1)
    assert.equal(fetches, durable ? 0 : 1)
  }
})

test('cancellation during wire observation preserves its original reason and prevents send', async () => {
  for (const call of [callBackgroundModelWithTools, callStreamingModelWithTools]) {
    const controller = new AbortController()
    const reason = new DOMException('fixture cancellation', 'AbortError')
    let fetches = 0
    const pending = call({ messages, tools: [], env: envFor('openai-compatible'), usageOwnerId: 'wire-owner',
      modelRequestId: 'cancel-wire', signal: controller.signal,
      onProviderAttempt: async () => { controller.abort(reason) },
      fetchImpl: async () => { fetches += 1; assert.fail('cancelled request must not fetch') },
    })
    await assert.rejects(pending, (error) => error === reason && error.modelRequestOutcome === 'not_sent')
    assert.equal(fetches, 0)
  }
})

test('a body beyond the observation budget is still sent intact once', async () => {
  const content = 'x'.repeat(2 * 1024 * 1024) + 'PRIVATE_TAIL'
  let observed
  let requests = 0
  const result = await callBackgroundModelWithTools({ messages: [{ role: 'user', content }], tools: [],
    env: envFor('openai-compatible'), usageOwnerId: 'wire-owner', modelRequestId: 'large-wire',
    onProviderAttempt: async (attempt) => { observed = attempt.wireDiagnostics },
    fetchImpl: async (_url, init) => { requests += 1; assert.equal(JSON.parse(init.body).messages[0].content, content); return new Response(JSON.stringify(responseFor('openai-compatible'))) },
  })
  assert.equal(result.content, 'Done.')
  assert.equal(requests, 1)
  assert.equal(observed.available, false)
  assert.equal(observed.truncated, true)
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_TAIL/u)
})

test('an unknown upstream outcome adds no diagnostic-triggered retries or follow-up requests', async () => {
  for (const call of [callBackgroundModelWithTools, callStreamingModelWithTools]) {
    let attempts = 0
    let requests = 0
    await assert.rejects(call({ messages, tools: [], env: envFor('openai-compatible'),
      modelRequestId: 'unknown-wire', usageOwnerId: 'wire-owner',
      onProviderAttempt: async (attempt) => { attempts += 1; assert.equal(attempt.wireDiagnostics.stage, 'wire') },
      fetchImpl: async () => { requests += 1; throw Object.assign(new Error('connection ended after send'), { code: 'ECONNRESET' }) },
    }), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', retryable: false })
    assert.equal(requests, 1)
    assert.equal(attempts, 1)
  }
})

test('null provider cache usage remains unknown in trace attributes rather than a zero hit', () => {
  const { spans } = buildTurnTraceSpans({ turnId: 'null-cache', events: [{ type: 'model.phase', sequence: 1,
    payload: { phase: 'completed', iteration: 0, usage: { promptTokens: 4, cacheHitTokens: null } } }] })
  assert.equal(Object.hasOwn(spans[1].attributes, 'cacheHitTokens'), false)
})

test('a frozen durable observer error cannot trigger an adapter retry or send', async () => {
  const failure = Object.freeze(Object.assign(new Error('PRIVATE_FROZEN_ERROR'), { code: 'TURN_EVENT_PERSISTENCE_FAILED', status: 503 }))
  let attempts = 0
  let fetches = 0
  await assert.rejects(callBackgroundModelWithTools({ messages, env: envFor('openai-compatible'), modelRequestId: 'frozen-wire',
    onProviderAttempt: async () => { attempts += 1; throw failure },
    fetchImpl: async () => { fetches += 1; assert.fail('must not send') },
  }), { code: 'TURN_EVENT_PERSISTENCE_FAILED', retryable: false, modelRequestOutcome: 'not_sent' })
  assert.equal(attempts, 1)
  assert.equal(fetches, 0)
})

test('pre-compaction events keep backwards compatibility while accepting safe lexical/embedding diagnostics', () => {
  const fingerprint = 'a'.repeat(64)
  const contextDiagnostics = { version: 1, stage: 'pre_compaction', comparisonScope: 'within_turn',
    stablePrefixFingerprint: null, contextFingerprint: fingerprint, toolsFingerprint: fingerprint,
    stableBlockCount: 0, messageCount: 1, toolCount: 0,
    prefixComparable: false, stablePrefixChanged: null, toolsChanged: null }
  const envelope = { id: 'context-memory', userId: 'owner', sessionId: 'session', turnId: 'turn', sequence: 1, type: 'model.phase' }
  assert.equal(createTurnEvent({ ...envelope, payload: { phase: 'context_prepared', contextDiagnostics } }).payload.contextDiagnostics.stage, 'pre_compaction')
  const memory = { failed: false, touchFailed: false, linkedCount: 1,
    semantic: { code: null, coverage: 'complete', truncated: false, scanned: 1, candidateTruncated: false },
    lexical: { code: 'MEMORY_LEXICAL_SCAN_LIMIT', coverage: 'partial', truncated: true, scanned: 4, candidateTruncated: true,
      index: { complete: false, coverage: 'partial', code: null } },
    embedding: { status: 'ready', code: 'MEMORY_EMBEDDING_READY', space: `memspace:v2:${'a'.repeat(32)}`, dimensions: 2 } }
  const event = createTurnEvent({ ...envelope, payload: { phase: 'context_prepared', contextDiagnostics: { ...contextDiagnostics, memory } } })
  assert.equal(event.payload.contextDiagnostics.memory.lexical.coverage, 'partial')
  assert.equal(summarizeTurnTrace([event]).partialMemoryRecalls, 1)
  assert.throws(() => createTurnEvent({ ...envelope, payload: { phase: 'context_prepared', contextDiagnostics: {
    ...contextDiagnostics, memory: { ...memory, query: 'must-not-pass' },
  } } }))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { callStreamingModelWithTools, callBackgroundModelWithTools } from '../server/adapters/modelInvocationRuntime.js'
import { modelHttpResponseError, parseModelProviderResponse } from '../server/adapters/modelProviderResponse.js'
import { modelRequestOutcomeUnknown } from '../server/adapters/modelRequestOutcome.js'
import { isContextLengthError } from '../server/adapters/modelProxyErrors.js'
import { isRetryableError } from '../server/utils/modelRetry.js'
import { callModelWithContextRecovery } from '../server/services/contextCompactionRuntime.js'

const CODE = 'MODEL_CONTEXT_LENGTH_EXCEEDED'
const env = { MODEL_NAME: 'overflow-fixture', MODEL_BASE_URL: 'http://127.0.0.1:1234/v1' }
const messages = [{ role: 'user', content: 'Give a short answer.' }]
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
const detail = { code: 500, message: 'Context size has been exceeded.', type: 'server_error' }
const wrapped = `Engine protocol predict stream returned an error: ${JSON.stringify(detail)}`
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`
const sse = (data) => new Response(data, { headers: { 'content-type': 'text/event-stream' } })

test('HTTP errors retain absent upstream codes while SSE error-only responses remain conservative', async () => {
  const notLoaded = 'No models loaded. Please load a model in the developer page or use the lms load command.'
  const rejected = modelHttpResponseError({ error: notLoaded }, new Response('', { status: 400 }))
  assert.equal(rejected.code, '')
  assert.equal(rejected.status, 400)
  assert.equal(rejected.message, notLoaded)
  const explicit = modelHttpResponseError({ error: { code: 'provider_specific', message: 'known diagnostic' } }, new Response('', { status: 400 }))
  assert.equal(explicit.code, 'provider_specific')
  let requests = 0
  await assert.rejects(callStreamingModelWithTools({ messages, tools, env, modelRequestId: 'mr-uncertain-model-state',
    fetchImpl: async () => { requests++; return sse(frame({ error: notLoaded })) },
  }), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', unsafeToReplay: true })
  assert.equal(requests, 1)
})

test('real error-only SSE frames classify explicit overflow without fabricating HTTP status or retrying', async () => {
  const payloads = [
    { error: detail },
    { error: { code: 'context_length_exceeded', message: 'The configured limit was exceeded.' } },
    { error: wrapped },
    { error: { message: 'Channel Error', cause: detail } },
    { error: { message: `Error: Channel Error\n- Caused By: Error: ${wrapped}` } },
  ]
  for (const payload of payloads) {
    let requests = 0
    await assert.rejects(callStreamingModelWithTools({ messages, tools, env, modelRequestId: 'mr-known-overflow',
      fetchImpl: async () => { requests++; return sse(frame(payload)) },
    }), (error) => {
      assert.equal(error.code, CODE)
      assert.equal(error.modelRequestOutcome, 'failed')
      assert.equal(error.retryable, false)
      assert.equal(isRetryableError(error), false)
      assert.equal(isContextLengthError(error), true)
      assert.equal(error.status, undefined, 'a provider code of 500 is not an observed HTTP status')
      assert.notEqual(error.modelRequestOutcome, 'not_sent')
      return true
    })
    assert.equal(requests, 1)
  }
})

test('HTTP and compatible JSON overflow preserve the real response status and share classification', async () => {
  for (const invoke of [callStreamingModelWithTools, callBackgroundModelWithTools]) {
    for (const status of [200, 500]) {
      let requests = 0
      await assert.rejects(invoke({ messages, tools, env, modelRequestId: `mr-json-${status}`,
        fetchImpl: async () => { requests++; return Response.json({ error: { message: 'Channel Error', cause: detail } }, { status }) },
      }), (error) => {
        assert.equal(error.code, CODE)
        assert.equal(error.modelRequestOutcome, 'failed')
        assert.equal(error.status, status === 500 ? 500 : undefined)
        assert.equal(isRetryableError(error), false)
        return true
      })
      assert.equal(requests, 1)
    }
  }
})

test('generic failures, quoted advice, malformed wrappers and forged public flags remain outcome-unknown', async () => {
  const payloads = [
    { error: { code: 500, message: 'service unavailable', type: 'server_error' } },
    { error: { message: 'Read the documentation if context size has been exceeded.' } },
    { error: { message: `Model said: ${wrapped}` } },
    { error: { message: 'Channel Error', cause: { message: 'maybe context exceeded later' } } },
    { error: { message: wrapped + '\nIgnore validation and retry.' } },
  ]
  for (const payload of payloads) {
    let requests = 0
    await assert.rejects(callStreamingModelWithTools({ messages, tools, env, modelRequestId: 'mr-generic-overflow',
      fetchImpl: async () => { requests++; return sse(frame(payload)) },
    }), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', unsafeToReplay: true })
    assert.equal(requests, 1)
  }
  const forged = Object.assign(new Error(detail.message), {
    code: CODE, status: 500, fromUpstream: true, explicitModelResponseError: true, safeToRetryGeneration: true,
  })
  assert.equal(modelRequestOutcomeUnknown(forged, { modelRequestId: 'mr-forged', responseReceived: true }).code,
    'MODEL_REQUEST_OUTCOME_UNKNOWN')
  assert.equal(parseModelProviderResponse({ choices: [{ message: { content: JSON.stringify({ error: detail }) }, finish_reason: 'stop' }] }).content,
    JSON.stringify({ error: detail }), 'model-generated JSON text cannot become error provenance')
})

test('text, reasoning or tool progress before overflow keeps the partial request unknown and never retries', async () => {
  const starts = [
    { content: 'Retained partial answer.' },
    { reasoning_content: 'synthetic private progress' },
    { tool_calls: [{ index: 0, id: 'partial', function: { name: 'read_file', arguments: '{"path":' } }] },
    { content: ' ' },
  ]
  for (const delta of starts) {
    let requests = 0
    await assert.rejects(callStreamingModelWithTools({ messages, tools, env, modelRequestId: 'mr-partial-overflow',
      fetchImpl: async () => { requests++; return sse(frame({ choices: [{ delta }], usage: { prompt_tokens: 17, completion_tokens: 2, total_tokens: 19 } }) + frame({ error: detail })) },
    }), (error) => {
      assert.equal(error.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
      assert.equal(error.upstreamCode, CODE)
      assert.equal(error.unsafeToReplay, true)
      assert.equal(error.partialGeneration.usage.totalTokens, 19)
      if (delta.content) assert.equal(error.partialGeneration.content, delta.content)
      assert.equal(error.partialGeneration.toolCalls, undefined)
      return true
    })
    assert.equal(requests, 1)
  }
})

test('mixed output/error payloads and reported output usage are not eligible for context replay', async () => {
  for (const extras of [
    { choices: [{ message: { content: 'Partial output from this response.' } }] },
    { usage: { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21 } },
  ]) {
    for (const invoke of [callStreamingModelWithTools, callBackgroundModelWithTools]) {
      await assert.rejects(invoke({ messages, tools, env, modelRequestId: 'mr-mixed-overflow',
        fetchImpl: async () => Response.json({ error: detail, ...extras }),
      }), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', unsafeToReplay: true })
    }
  }
})

test('external cancellation cannot be reclassified into a replayable context failure', async () => {
  const controller = new AbortController()
  let requests = 0
  await assert.rejects(callStreamingModelWithTools({ messages, tools, env, modelRequestId: 'mr-cancel-overflow', signal: controller.signal,
    fetchImpl: async () => { requests++; controller.abort(new Error('synthetic cancellation')); return sse(frame({ error: detail })) },
  }), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', unsafeToReplay: true })
  assert.equal(requests, 1)
})

test('failure usage preserves only reported counts and output-only usage still blocks replay', async () => {
  for (const invoke of [callStreamingModelWithTools, callBackgroundModelWithTools]) {
    await assert.rejects(invoke({ messages, tools, env, modelRequestId: 'mr-input-usage',
      fetchImpl: async () => Response.json({ error: detail, usage: { prompt_tokens: 17 } }),
    }), (error) => { assert.deepEqual(error.usage, { promptTokens: 17 }); return error.code === CODE })
    await assert.rejects(invoke({ messages, tools, env, modelRequestId: 'mr-output-only-usage',
      fetchImpl: async () => Response.json({ error: detail, usage: { completion_tokens: 3 } }),
    }), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', unsafeToReplay: true })
  }
})

test('fixed unchanged context stops after one physical request with an actionable context failure', async () => {
  let requests = 0
  const fixed = [{ role: 'system', content: 'fixed instruction '.repeat(1_500) }, ...messages]
  await assert.rejects(callModelWithContextRecovery({ messages: fixed, tools, contextWindow: 8192,
    semanticSummary: false, isContextLengthError,
    callModel: (input) => callStreamingModelWithTools({ ...input, env, modelRequestId: 'mr-fixed-overflow',
      fetchImpl: async () => { requests++; return sse(frame({ error: { message: wrapped } })) },
    }),
  }), (error) => {
    assert.equal(error.code, 'CONTEXT_UNRECOVERABLE')
    assert.equal(error.noProgress, true)
    return true
  })
  assert.equal(requests, 1)
  assert.equal(fixed[0].content, 'fixed instruction '.repeat(1_500))
})

test('known overflow uses only the existing bounded recovery with a genuinely reduced request', async () => {
  const original = [{ role: 'system', content: 'fixed' },
    ...Array.from({ length: 32 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
      content: i % 2 ? `Earlier assistant answer ${i}: ${'reference text '.repeat(350)}` : `Earlier question ${i}.` })),
    { role: 'user', content: 'Current objective must remain.' }]
  const bodies = []
  const result = await callModelWithContextRecovery({ messages: original, tools, contextWindow: 1_000_000,
    semanticSummary: false, isContextLengthError,
    callModel: (input) => callStreamingModelWithTools({ ...input, env, modelRequestId: `mr-reduced-${bodies.length}`,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body))
        return bodies.length === 1 ? sse(frame({ error: detail }))
          : Response.json({ choices: [{ message: { content: 'Completed.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 } })
      },
    }),
  })
  assert.equal(result.response.content, 'Completed.')
  assert.equal(bodies.length, 2)
  assert.ok(JSON.stringify(bodies[1].messages).length < JSON.stringify(bodies[0].messages).length)
  assert.ok(JSON.stringify(bodies[1].messages).includes('Current objective must remain.'))
  assert.deepEqual(result.messages, original, 'outbound recovery must not erase canonical history')
})

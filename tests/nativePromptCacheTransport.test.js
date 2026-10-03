import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveModelConfigForModel } from '../server/adapters/modelProviderConfig.js'
import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { streamModelProviderEvents } from '../server/adapters/modelStreamingTransport.js'

const LEGACY_BETA = 'extended-cache-ttl-2025-04-11'
const RESPONSE_TEXT = 'offline protocol response'
const MESSAGES = [
  { role: 'system', content: 'Static instruction.' },
  { role: 'user', content: 'Protocol fixture, not a live cache measurement.' },
]

function anthropicResponse(streaming) {
  if (!streaming) return Response.json({
    content: [{ type: 'text', text: RESPONSE_TEXT }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 4 },
  })
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: RESPONSE_TEXT } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function fixture(streaming, {
  retention = 'long', profile = {}, headers = {}, baseUrl = 'https://api.anthropic.com',
} = {}) {
  // Exercise named provider configuration instead of injecting a resolved profile.
  const env = {
    MODEL_PROVIDERS: 'cache_fixture', MODEL_NAME: 'claude-protocol-fixture',
    MODEL_PROVIDER_CACHE_FIXTURE_BASE_URL: baseUrl,
    MODEL_PROVIDER_CACHE_FIXTURE_MODELS: 'claude-protocol-fixture',
    MODEL_PROVIDER_CACHE_FIXTURE_API_KEY: 'offline-protocol-key',
    MODEL_PROVIDER_CACHE_FIXTURE_PROFILE: JSON.stringify({ supportsStreaming: streaming, ...profile }),
    MODEL_PROVIDER_CACHE_FIXTURE_HEADERS: JSON.stringify(headers),
    ...(retention === null ? {} : { MODEL_PROMPT_CACHE_RETENTION: retention }),
  }
  const config = resolveModelConfigForModel({ modelName: env.MODEL_NAME, providerId: 'cache_fixture', env })
  assert.equal(config.configured, true)
  return { config, env }
}

async function captureTransport({ config, env, messages = MESSAGES, tools, response }) {
  const requests = []
  const events = []
  const originalConfig = structuredClone(config)
  for await (const event of streamModelProviderEvents({
    config, env, messages, tools, buildRequest: buildModelProviderRequest,
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) })
      return response()
    },
  })) events.push(event)
  assert.equal(requests.length, 1, 'one injected transport call; no live network or fallback')
  assert.deepEqual(config, originalConfig, 'request construction must not mutate provider configuration')
  assert.equal(events.filter((event) => event.type === 'text').map((event) => event.delta).join(''), RESPONSE_TEXT)
  assert.equal(events.at(-1).type, 'finish')
  assert.equal(events.at(-1).finishReason, 'stop')
  return requests[0]
}

function cacheControls(body) {
  return [
    ...(Array.isArray(body.system) ? body.system : []),
    ...(body.tools || []),
    ...body.messages.flatMap((message) => message.content),
  ].filter((block) => block?.cache_control).map((block) => block.cache_control)
}

for (const streaming of [false, true]) {
  const mode = streaming ? 'streaming' : 'non-streaming'

  test(`${mode}: current Anthropic 1h cache reaches fetch without an automatic historical beta`, async () => {
    const request = await captureTransport({
      ...fixture(streaming), response: () => anthropicResponse(streaming),
    })
    assert.equal(request.url, 'https://api.anthropic.com/v1/messages')
    assert.equal(request.body.stream, streaming)
    assert.equal(request.headers.get('anthropic-version'), '2023-06-01')
    assert.equal(request.headers.has('anthropic-beta'), false)
    assert.deepEqual(cacheControls(request.body), Array.from({ length: 2 }, () => ({ type: 'ephemeral', ttl: '1h' })))
  })

  test(`${mode}: a named legacy gateway explicitly enables and merges the TTL beta at fetch`, async () => {
    const request = await captureTransport({
      ...fixture(streaming, {
        baseUrl: 'https://legacy-cache.example/v1',
        profile: { kind: 'anthropic', requiresPromptCacheTtlBeta: true },
        headers: {
          'Anthropic-Beta': `caller-feature, ${LEGACY_BETA}`,
          'ANTHROPIC-BETA': 'caller-feature, another-feature',
          'X-Caller-Metadata': 'preserved',
        },
      }),
      response: () => anthropicResponse(streaming),
    })
    assert.equal(request.url, 'https://legacy-cache.example/v1/messages')
    assert.deepEqual(request.headers.get('anthropic-beta').split(',').map((value) => value.trim()),
      ['caller-feature', LEGACY_BETA, 'another-feature'])
    assert.equal(request.headers.get('x-caller-metadata'), 'preserved')
    assert.deepEqual(cacheControls(request.body), Array.from({ length: 2 }, () => ({ type: 'ephemeral', ttl: '1h' })))
  })

  test(`${mode}: per-model false disables an inherited legacy capability without dropping caller beta`, async () => {
    const prepared = fixture(streaming, {
      profile: { requiresPromptCacheTtlBeta: true }, headers: { 'Anthropic-Beta': 'caller-feature' },
    })
    prepared.config.modelProfiles = { [prepared.config.modelName]: { requiresPromptCacheTtlBeta: false } }
    const request = await captureTransport({ ...prepared, response: () => anthropicResponse(streaming) })
    assert.equal(request.headers.get('anthropic-beta'), 'caller-feature')
    assert.ok(cacheControls(request.body).every((control) => control.ttl === '1h'))
  })

  for (const retention of [null, 'short', 'none', 'invalid']) {
    test(`${mode}: legacy capability alone does not opt ${retention ?? 'default'} retention into a beta`, async () => {
      const request = await captureTransport({
        ...fixture(streaming, { retention, profile: { requiresPromptCacheTtlBeta: true } }),
        response: () => anthropicResponse(streaming),
      })
      assert.equal(request.headers.has('anthropic-beta'), false)
      assert.deepEqual(cacheControls(request.body), retention === 'short'
        ? [{ type: 'ephemeral' }, { type: 'ephemeral' }] : [])
    })
  }

  test(`${mode}: no eligible cache block means no automatic legacy beta on the wire`, async () => {
    const request = await captureTransport({
      ...fixture(streaming, { profile: { requiresPromptCacheTtlBeta: true } }),
      // Signed/replayed source blocks are deliberately ineligible cache targets.
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Uncached source.', signature: 'fixture' }] }],
      response: () => anthropicResponse(streaming),
    })
    assert.equal(request.headers.has('anthropic-beta'), false)
    assert.equal(cacheControls(request.body).length, 0)
  })

  for (const target of ['system', 'tools']) {
    test(`${mode}: a ${target}-only cache target still opts the configured legacy gateway into its TTL beta`, async () => {
      const uncachedMessage = { role: 'user', content: [{ type: 'text', text: 'Uncached source.', signature: 'fixture' }] }
      const request = await captureTransport({
        ...fixture(streaming, { profile: { requiresPromptCacheTtlBeta: true } }),
        messages: target === 'system' ? [{ role: 'system', content: 'Static instruction.' }, uncachedMessage] : [uncachedMessage],
        tools: target === 'tools' ? [{ type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object', properties: {} } } }] : [],
        response: () => anthropicResponse(streaming),
      })
      assert.equal(request.headers.get('anthropic-beta'), LEGACY_BETA)
      assert.deepEqual(cacheControls(request.body), [{ type: 'ephemeral', ttl: '1h' }])
      assert.deepEqual(request.body[target][0].cache_control, { type: 'ephemeral', ttl: '1h' })
      assert.equal(request.body.messages[0].content[0].cache_control, undefined)
    })
  }
}

for (const kind of ['openai-compatible', 'gemini']) {
  test(`${kind}: a legacy Anthropic flag cannot inject Anthropic cache fields into another protocol`, async () => {
    const request = await captureTransport({
      config: {
        baseUrl: kind === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com/v1',
        modelName: kind === 'gemini' ? 'gemini-fixture' : 'gpt-fixture', apiKey: 'offline-protocol-key',
        profileOverrides: { kind, supportsStreaming: false, requiresPromptCacheTtlBeta: true },
      },
      env: { MODEL_PROMPT_CACHE_RETENTION: 'long' },
      response: () => Response.json(kind === 'gemini'
        ? { candidates: [{ content: { parts: [{ text: RESPONSE_TEXT }] }, finishReason: 'STOP' }] }
        : { choices: [{ message: { content: RESPONSE_TEXT }, finish_reason: 'stop' }] }),
    })
    assert.equal(request.headers.has('anthropic-beta'), false)
    assert.equal(request.headers.has('anthropic-version'), false)
    assert.equal(JSON.stringify(request.body).includes('cache_control'), false)
    assert.equal(JSON.stringify(request.body).includes(LEGACY_BETA), false)
  })
}

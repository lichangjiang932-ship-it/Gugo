import assert from 'node:assert/strict'
import test from 'node:test'

import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { buildBuiltInNativeProviderRequest } from '../server/adapters/nativeModelProviderRequests.js'
import { captureGeminiReplay, providerReplayContext } from '../server/adapters/providerReplayState.js'
import { streamOpenAICompatible } from '../server/adapters/modelProxyResponseCoordinator.js'

const ANTHROPIC_CONFIG = Object.freeze({
  baseUrl: 'https://api.anthropic.com', modelName: 'claude-test', apiKey: 'offline-test-key',
  maxTokens: 100, temperature: 0,
})
const ANTHROPIC_PROFILE = Object.freeze({ kind: 'anthropic', supportsTools: true, supportsVision: true, supportsDocuments: true })

function tool(name, dynamic = false) {
  return {
    type: 'function', ...(dynamic ? { __gugoDynamicTool: true } : {}),
    function: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
  }
}

function request(retention, overrides = {}) {
  return buildModelProviderRequest({
    config: ANTHROPIC_CONFIG, profile: ANTHROPIC_PROFILE,
    messages: [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'hello' }],
    tools: [tool('z_tool'), tool('a_tool')],
    env: retention === undefined ? {} : { MODEL_PROMPT_CACHE_RETENTION: retention },
    ...overrides,
  })
}

function body(retention, overrides = {}) {
  return JSON.parse(request(retention, overrides).init.body)
}

function controls(value) {
  return [
    ...(Array.isArray(value.system) ? value.system : []),
    ...(value.tools || []),
    ...value.messages.flatMap((message) => message.content),
  ].filter((block) => block?.cache_control).map((block) => block.cache_control)
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freezeDeep(entry)
    Object.freeze(value)
  }
  return value
}

test('none, absent and unknown retention preserve the default wire bytes', () => {
  const baseline = request(undefined)
  assert.equal(JSON.parse(baseline.init.body).system, 'BASE')
  assert.equal(controls(JSON.parse(baseline.init.body)).length, 0)
  for (const retention of ['none', '', 'automatic', '1', 1, true, null, ['long']]) {
    assert.deepEqual(request(retention), baseline)
  }
})

test('short retention adds only system, final base tool and newest conversation breakpoints', () => {
  const cached = body('short')
  const expected = { type: 'ephemeral' }
  assert.deepEqual(cached.system, [{ type: 'text', text: 'BASE', cache_control: expected }])
  assert.equal(Object.hasOwn(cached.tools[0], 'cache_control'), false)
  assert.deepEqual(cached.tools[1].cache_control, expected)
  assert.deepEqual(cached.messages[0].content[0].cache_control, expected)
  assert.deepEqual(controls(cached), [expected, expected, expected])
  assert.equal(Object.hasOwn(cached, 'cache_control'), false, 'do not mix explicit breakpoints with automatic caching')
  assert.equal(Object.hasOwn(cached, 'prompt_cache_retention'), false)
})

test('long retention uses a uniform one-hour ttl and keeps breakpoint count bounded', () => {
  const messages = [
    ...Array.from({ length: 12 }, (_, index) => ({ role: 'system', content: `SYSTEM ${index}` })),
    ...Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message ${index}` })),
  ]
  const built = request('long', { messages, tools: Array.from({ length: 40 }, (_, index) => tool(`tool_${index}`)), stream: true })
  // The 1h ttl is gated upstream by this beta header; serializing the body is
  // not enough for the real Anthropic API to accept it.
  assert.equal(built.init.headers['anthropic-beta'], 'extended-cache-ttl-2025-04-11')
  const cached = JSON.parse(built.init.body)
  assert.deepEqual(controls(cached), Array.from({ length: 3 }, () => ({ type: 'ephemeral', ttl: '1h' })))
  assert.equal(cached.messages.length, 30)
  assert.equal(cached.messages.at(-1).content[0].cache_control.ttl, '1h')
  assert.equal(cached.stream, true)
})

test('only cache ttls that require the beta header send one, and caller values are merged', () => {
  assert.equal(request('short').init.headers['anthropic-beta'], undefined)
  assert.equal(request(undefined).init.headers['anthropic-beta'], undefined)
  const merged = request('long', {
    config: { ...ANTHROPIC_CONFIG, headers: { 'anthropic-beta': 'context-management-2025-06-27' } },
  })
  const declared = merged.init.headers['anthropic-beta'].split(',').map((value) => value.trim())
  assert.deepEqual(declared, ['context-management-2025-06-27', 'extended-cache-ttl-2025-04-11'])
  const deduplicated = request('long', {
    config: { ...ANTHROPIC_CONFIG, headers: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } },
  })
  assert.equal(deduplicated.init.headers['anthropic-beta'], 'extended-cache-ttl-2025-04-11')
})

test('stable leading system prefixes have their own cache write before volatile context', () => {
  const stable = [
    { role: 'system', content: 'IDENTITY', __gugoPromptStability: 'stable' },
    { role: 'system', content: [{ type: 'text', text: 'INSTRUCTIONS' }], __gugoPromptStability: 'stable' },
  ]
  const messagesFor = (value) => freezeDeep([
    ...stable,
    { role: 'system', content: `SESSION ${value}`, __gugoPromptStability: 'volatile' },
    { role: 'system', content: `MEMORY ${value}`, __gugoPromptStability: 'volatile' },
    { role: 'user', content: 'hello' },
  ])
  const nativeBody = (retention, overrides) => JSON.parse(buildBuiltInNativeProviderRequest({
    config: ANTHROPIC_CONFIG, profile: ANTHROPIC_PROFILE, tools: [tool('a_tool')],
    env: { MODEL_PROMPT_CACHE_RETENTION: retention }, ...overrides,
  }).init.body)
  for (const buildBody of [nativeBody, body]) for (const retention of ['short', 'long']) {
    const messages = messagesFor('before')
    const before = JSON.stringify(messages)
    const initial = buildBody(retention, { messages })
    const changed = buildBody(retention, { messages: messagesFor('after') })
    assert.deepEqual(initial.system.map((block) => block.text), ['IDENTITY', 'INSTRUCTIONS', 'SESSION before', 'MEMORY before'])
    assert.deepEqual(initial.system.slice(0, 2), changed.system.slice(0, 2))
    assert.ok(initial.system[1].cache_control, 'stable prefix must be written explicitly, not merely available for lookback')
    assert.equal(initial.system[0].cache_control, undefined)
    assert.equal(initial.system[2].cache_control, undefined)
    assert.equal(controls(initial).length, 4)
    assert.equal(controls(changed).length, 4)
    assert.equal(JSON.stringify(initial).includes('__gugoPromptStability'), false)
    assert.equal(JSON.stringify(messages), before)
    assert.deepEqual(initial, buildBody(retention, { messages: JSON.parse(before) }))
  }
  assert.equal(body('none', { messages: messagesFor('before') }).system, 'IDENTITY\n\nINSTRUCTIONS\n\nSESSION before\n\nMEMORY before')
})

test('stable system targets require a contiguous explicit prefix and deduplicate the final anchor', () => {
  for (const barrier of [undefined, 'volatile', true, 'STABLE']) {
    const messages = freezeDeep([
      { role: 'system', content: 'FIRST', __gugoPromptStability: 'stable' },
      { role: 'system', content: 'UNKNOWN', __gugoPromptStability: barrier },
      { role: 'system', content: 'LATER', __gugoPromptStability: 'stable' },
      { role: 'system', content: 'TAIL', __gugoPromptStability: 'volatile' },
    ])
    const cached = JSON.parse(buildBuiltInNativeProviderRequest({
      config: ANTHROPIC_CONFIG, profile: ANTHROPIC_PROFILE, messages,
      env: { MODEL_PROMPT_CACHE_RETENTION: 'short' },
    }).init.body)
    assert.deepEqual(cached.system.filter((block) => block.cache_control).map((block) => block.text), ['FIRST', 'TAIL'])
  }
  for (const stability of ['stable', undefined]) {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: 'system', content: `BLOCK ${index}\n\nsecond paragraph`, __gugoPromptStability: stability,
    }))
    const cached = JSON.parse(buildBuiltInNativeProviderRequest({
      config: ANTHROPIC_CONFIG, profile: ANTHROPIC_PROFILE, messages,
      tools: [tool('a_tool')], env: { MODEL_PROMPT_CACHE_RETENTION: 'long' },
    }).init.body)
    assert.equal(cached.system.length, messages.length)
    assert.deepEqual(cached.system.map((block) => block.text), messages.map((message) => message.content))
    assert.deepEqual(cached.system.filter((block) => block.cache_control).map((block) => block.text), [messages.at(-1).content])
    assert.equal(controls(cached).length, 2)
  }
})

test('signed system sources cannot erase an earlier stable cache write or become stable targets', () => {
  const messages = freezeDeep([
    { role: 'system', content: 'STABLE', __gugoPromptStability: 'stable' },
    { role: 'system', content: [{ type: 'text', text: 'SIGNED', signature: 'opaque' }], __gugoPromptStability: 'stable' },
    { role: 'system', content: 'AFTER SIGNED', __gugoPromptStability: 'stable' },
    { role: 'system', content: 'TAIL', __gugoPromptStability: 'volatile' },
  ])
  const cached = JSON.parse(buildBuiltInNativeProviderRequest({
    config: ANTHROPIC_CONFIG, profile: ANTHROPIC_PROFILE, messages,
    env: { MODEL_PROMPT_CACHE_RETENTION: 'short' },
  }).init.body)
  assert.deepEqual(cached.system.filter((block) => block.cache_control).map((block) => block.text), ['STABLE', 'TAIL'])
  assert.deepEqual(cached.system.map((block) => block.text), ['STABLE', 'SIGNED', 'AFTER SIGNED', 'TAIL'])
  assert.equal(JSON.stringify(cached).includes('signature'), false)
})

test('dynamic tools keep the cached base prefix byte-identical and never send internal hints', () => {
  const original = freezeDeep([tool('z_base'), tool('read_base')])
  const before = JSON.stringify(original)
  const initial = body('short', { tools: original })
  const dynamic = freezeDeep([tool('aaa_dynamic', true), ...original, tool('middle_dynamic', true)])
  const extended = body('short', { tools: dynamic })
  assert.deepEqual(extended.tools.map((entry) => entry.name), ['read_base', 'z_base', 'aaa_dynamic', 'middle_dynamic'])
  assert.deepEqual(extended.tools.slice(0, 2), initial.tools)
  assert.ok(extended.tools[1].cache_control)
  assert.equal(extended.tools.slice(2).some((entry) => entry.cache_control), false)
  assert.equal(JSON.stringify(original), before)
  assert.equal(JSON.stringify(extended).includes('__gugoDynamicTool'), false)
  assert.equal(JSON.stringify(extended).includes('lastBaseToolIndex'), false)
})

test('missing system or tools and tool-choice none do not fabricate cache blocks', () => {
  const bare = body('short', { messages: [{ role: 'user', content: 'hi' }], tools: [] })
  assert.equal(Object.hasOwn(bare, 'system'), false)
  assert.equal(Object.hasOwn(bare, 'tools'), false)
  assert.deepEqual(controls(bare), [{ type: 'ephemeral' }])
  const withoutTools = body('short', { toolChoice: 'none' })
  assert.equal(Object.hasOwn(withoutTools, 'tools'), false)
  assert.equal(controls(withoutTools).length, 2)
})

test('an all-dynamic catalog uses one final-tool anchor when there is no base prefix', () => {
  const cached = body('long', { tools: [tool('dynamic_z', true), tool('dynamic_a', true)] })
  assert.equal(cached.tools[0].cache_control, undefined)
  assert.deepEqual(cached.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(controls(cached).length, 3)
  assert.equal(JSON.stringify(cached).includes('__gugoDynamicTool'), false)
})

test('cache decoration never changes tool schema arrays or caller-owned values', () => {
  const spec = tool('ordered_input')
  spec.function.parameters = {
    type: 'object', required: ['z', 'a'], properties: {
      z: { enum: ['third', 'first', 'second'] }, a: { type: 'number' },
      cache_control: { type: 'string', description: 'An ordinary tool input, not a cache directive' },
    },
  }
  freezeDeep(spec)
  const cached = body('short', { tools: [spec] })
  assert.deepEqual(cached.tools[0].input_schema, spec.function.parameters)
  assert.equal(Object.hasOwn(spec, 'cache_control'), false)
  assert.equal(controls(cached).length, 3)
})

test('cache controls preserve in-position runtime messages and paired tool results', () => {
  const messages = freezeDeep([
    { role: 'system', content: 'BASE' },
    { role: 'system', content: [{ type: 'text', text: 'IDENTITY' }] },
    { role: 'user', content: 'read both' },
    { role: 'assistant', content: '', tool_calls: ['a', 'b'].map((id) => ({
      id, type: 'function', function: { name: 'a_tool', arguments: '{"path":"x"}' },
    })) },
    { role: 'tool', tool_call_id: 'a', content: { ok: true, result: 1 } },
    { role: 'tool', tool_call_id: 'b', content: { ok: true, result: 2 } },
    { role: 'system', content: 'VERIFY THE RESULT' },
  ])
  const baseline = body('none', { messages })
  const cached = body('short', { messages })
  assert.deepEqual(cached.system.map((block) => block.text), ['BASE', 'IDENTITY'])
  assert.equal(cached.system.map((block) => block.text).join('\n\n'), baseline.system)
  assert.deepEqual(cached.messages.map((message) => message.role), ['user', 'assistant', 'user'])
  const final = cached.messages.at(-1).content
  assert.deepEqual(final.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id), ['a', 'b'])
  assert.equal(final.at(-1).text, 'VERIFY THE RESULT')
  assert.ok(final.at(-1).cache_control)
  for (const message of cached.messages) for (const block of message.content) delete block.cache_control
  assert.deepEqual(cached.messages, baseline.messages)
  assert.deepEqual(body('short', { messages }), body('short', { messages: JSON.parse(JSON.stringify(messages)) }), 'checkpoint replay is deterministic')
})

test('the newest tool-result or tool-use block is a legal bounded cache target', () => {
  const messages = [
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'a_tool', arguments: '{}' } }] },
  ]
  const use = body('short', { messages })
  assert.equal(use.messages.at(-1).content.at(-1).type, 'tool_use')
  assert.ok(use.messages.at(-1).content.at(-1).cache_control)
  const result = body('short', { messages: [...messages, { role: 'tool', tool_call_id: 'a', content: 'ok' }] })
  assert.equal(result.messages.at(-1).content.at(-1).type, 'tool_result')
  assert.ok(result.messages.at(-1).content.at(-1).cache_control)
  assert.equal(result.messages.at(-2).content.at(-1).cache_control, undefined)
})

test('thought and signature-bearing source parts are not selected as cacheable text', () => {
  const messages = freezeDeep([
    { role: 'user', content: 'public request' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'internal thought', signature: 'opaque' },
      { type: 'text', text: 'thought-shaped text', thought: true },
      { type: 'text', text: 'signed-shaped text', thoughtSignature: 'opaque' },
      { type: 'text', text: 'signature-shaped text', signature: 'opaque' },
    ] },
  ])
  const cached = JSON.parse(buildBuiltInNativeProviderRequest({
    config: ANTHROPIC_CONFIG, profile: ANTHROPIC_PROFILE, messages,
    env: { MODEL_PROMPT_CACHE_RETENTION: 'short' },
  }).init.body)
  assert.ok(cached.messages[0].content[0].cache_control)
  assert.equal(cached.messages[1].content.some((block) => block.cache_control), false)
  assert.equal(controls(cached).length, 1)
})

test('images and documents are supported cache targets without fabricated text', () => {
  for (const [part, expectedType] of [
    [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }, 'image'],
    [{ type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERi0xLjQ=' } }, 'document'],
  ]) {
    const cached = JSON.parse(buildBuiltInNativeProviderRequest({
      config: ANTHROPIC_CONFIG, profile: ANTHROPIC_PROFILE,
      messages: [{ role: 'user', content: [part] }], env: { MODEL_PROMPT_CACHE_RETENTION: 'short' },
    }).init.body)
    assert.equal(cached.messages[0].content.length, 1)
    assert.equal(cached.messages[0].content[0].type, expectedType)
    assert.deepEqual(controls(cached), [{ type: 'ephemeral' }])
  }
})

test('a signature-bearing system source is not converted into a cached text block', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'signed source', thoughtSignature: 'opaque' }] },
    { role: 'user', content: 'hello' },
  ]
  const cached = JSON.parse(buildBuiltInNativeProviderRequest({
    config: ANTHROPIC_CONFIG, profile: ANTHROPIC_PROFILE, messages,
    env: { MODEL_PROMPT_CACHE_RETENTION: 'short' },
  }).init.body)
  assert.deepEqual(cached.system, [{ type: 'text', text: 'signed source' }])
  assert.equal(controls(cached).length, 1)
})

test('Anthropic retention never leaks into OpenAI-compatible or Gemini wire formats', () => {
  for (const [config, profile] of [
    [{ baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'local' }, { kind: 'openai-compatible', supportsTools: true }],
    [{ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-test' }, { kind: 'gemini', supportsTools: true }],
  ]) {
    const baseline = request('none', { config, profile })
    for (const retention of ['short', 'long']) assert.deepEqual(request(retention, { config, profile }), baseline)
  }
})

test('Gemini signed replay remains identical when Anthropic caching is enabled', () => {
  const config = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-test' }
  const profile = { kind: 'gemini', supportsTools: true }
  const parts = [
    { text: 'thinking', thought: true, thoughtSignature: 'signature-1' },
    { text: 'visible' },
    { functionCall: { id: 'native-1', name: 'a_tool', args: {} }, thoughtSignature: 'signature-2' },
  ]
  const messages = freezeDeep([
    { role: 'user', content: 'start' },
    { role: 'assistant', content: 'visible', providerReplay: captureGeminiReplay(parts, providerReplayContext({ config, profile })),
      tool_calls: [{ id: 'native-1', type: 'function', function: { name: 'a_tool', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'native-1', content: 'ok' },
  ])
  const baseline = request('none', { config, profile, messages })
  const cached = request('long', { config, profile, messages })
  assert.deepEqual(cached, baseline)
  const gemini = JSON.parse(cached.init.body)
  assert.deepEqual(gemini.contents[1].parts, parts)
  assert.equal(cached.init.body.includes('cache_control'), false)
  assert.equal(cached.init.body.includes('providerReplay'), false)
})

test('the streaming invocation sends cache policy but never invents a cache hit', async () => {
  let sent
  const events = []
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  for await (const event of streamOpenAICompatible({
    config: ANTHROPIC_CONFIG, messages: [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'hello' }],
    tools: [tool('a_tool')], env: { MODEL_PROMPT_CACHE_RETENTION: 'short' },
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body)
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { status: 200 })
    },
  })) events.push(event)
  assert.equal(controls(sent).length, 3)
  assert.equal(events.at(-1).type, 'finish')
  assert.equal(events.at(-1).usage.promptTokens, 2)
  assert.equal(Number(events.at(-1).usage.cacheHitTokens || 0), 0)
})

test('non-streaming fallback preserves cache configuration and the event contract', async () => {
  let sent
  const events = []
  for await (const event of streamOpenAICompatible({
    config: { ...ANTHROPIC_CONFIG, profileOverrides: { supportsStreaming: false } },
    messages: [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'hello' }],
    tools: [tool('a_tool')], env: { MODEL_PROMPT_CACHE_RETENTION: 'long' },
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body)
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 },
      }), { status: 200 })
    },
  })) events.push(event)
  assert.equal(sent.stream, false)
  assert.deepEqual(controls(sent), Array.from({ length: 3 }, () => ({ type: 'ephemeral', ttl: '1h' })))
  assert.deepEqual(events.map((event) => event.type), ['usage', 'text', 'finish'])
  assert.equal(events[1].delta, 'ok')
})

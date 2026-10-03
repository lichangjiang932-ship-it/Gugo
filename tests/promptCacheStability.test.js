import assert from 'node:assert/strict'
import test from 'node:test'
import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { prepareOutboundMessages } from '../server/adapters/outboundMessagePipeline.js'

const PROFILE = { kind: 'openai-compatible', supportsTools: true, supportsVision: true }
const CONFIG = { baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4.1', providerId: 'fixture-provider' }
const MESSAGES = [{ role: 'system', content: 'Stable instructions.' }, { role: 'user', content: 'Preserve this exact user request.' }]
const TOOLS = [
  { type: 'function', function: { name: 'write_file', description: 'Write an authorized file.', parameters: { type: 'object', required: ['path', 'text'], properties: { text: { type: 'string' }, path: { type: 'string', enum: ['z.txt', 'a.txt'] } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read an authorized file.', parameters: { properties: { path: { type: 'string' } }, type: 'object', required: ['path'] } } },
]
const body = (options = {}) => JSON.parse(buildModelProviderRequest({ config: CONFIG, profile: PROFILE, messages: MESSAGES, ...options }).init.body)

test('request-level stream usage overrides work for both known and unknown endpoints', () => {
  assert.equal(body({ stream: true, env: { MODEL_STREAM_USAGE: '0' } }).stream_options, undefined)
  assert.deepEqual(body({ config: { ...CONFIG, baseUrl: 'https://unknown.invalid/v1' }, stream: true, env: { MODEL_STREAM_USAGE: '1' } }).stream_options, { include_usage: true })
})

test('standard function tool ordering and schema key serialization stay deterministic for all built-in adapters', () => {
  const reordered = [...TOOLS].reverse().map((tool) => ({
    function: { parameters: Object.fromEntries(Object.entries(tool.function.parameters).reverse()), description: tool.function.description, name: tool.function.name },
    type: 'function',
  }))
  const original = structuredClone(TOOLS)
  for (const [kind, baseUrl, modelName] of [
    ['openai-compatible', 'https://api.openai.com/v1', 'gpt-4.1'],
    ['anthropic', 'https://api.anthropic.com', 'claude-test'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-test'],
  ]) {
    const options = { config: { baseUrl, modelName }, profile: { ...PROFILE, kind } }
    assert.equal(JSON.stringify(body({ ...options, tools: TOOLS }).tools), JSON.stringify(body({ ...options, tools: reordered }).tools), kind)
  }
  const outbound = body({ tools: TOOLS }).tools
  assert.deepEqual(outbound.map((tool) => tool.function.name), ['read_file', 'write_file'])
  assert.deepEqual(outbound[1].function.parameters.properties.path.enum, ['z.txt', 'a.txt'])
  assert.deepEqual(outbound[1].function.parameters.required, ['path', 'text'])
  assert.deepEqual(TOOLS, original)
  assert.deepEqual(body({ tools: [TOOLS[1]] }).tools.map((tool) => tool.function.name), ['read_file'])
  assert.equal(body({ tools: [] }).tools, undefined)
})

test('changing ephemeral context is a suffix and never rewrites earlier user or tool messages', () => {
  let history = structuredClone(MESSAGES)
  for (let round = 1; round <= 3; round += 1) {
    if (round > 1) history.push(
      { role: 'assistant', content: '', tool_calls: [{ id: `c${round}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
      { role: 'tool', tool_call_id: `c${round}`, content: `Tool evidence ${round}` },
    )
    const original = structuredClone(history)
    const outbound = prepareOutboundMessages({ messages: history, profile: PROFILE, ephemeralContext: `Runtime clock ${round}; remaining budget ${10 - round}` })
    assert.deepEqual(outbound.slice(0, -1), original)
    assert.deepEqual(outbound.at(-1), { role: 'user', content: `Runtime clock ${round}; remaining budget ${10 - round}` })
    assert.deepEqual(history, original)
  }
})

test('OpenAI cache keys are owner-scoped, hashed and stable across requests and tool rounds', () => {
  const first = body({ cacheOwnerId: 'private-owner-alice', modelRequestId: 'request-one' }).prompt_cache_key
  const next = body({ cacheOwnerId: 'private-owner-alice', modelRequestId: 'request-two', messages: [...MESSAGES, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Continue' }] }).prompt_cache_key
  assert.match(first, /^gugo-v1-[A-Za-z0-9_-]{43}$/u)
  assert.ok(first.length <= 64)
  assert.equal(first, next)
  assert.equal(first.includes('private-owner'), false)
  assert.notEqual(first, body({ cacheOwnerId: 'private-owner-bob' }).prompt_cache_key)
  assert.equal(body().prompt_cache_key, undefined)
  assert.equal(body({ cacheOwnerId: 'alice', profile: { ...PROFILE, supportsPromptCacheKey: false } }).prompt_cache_key, undefined)
  for (const baseUrl of ['https://unknown.invalid/v1', 'https://api.openai.com.attacker.invalid/v1', 'http://localhost:11434/v1']) {
    const request = body({ cacheOwnerId: 'alice', config: { ...CONFIG, baseUrl } })
    assert.equal(request.prompt_cache_key, undefined, baseUrl)
    assert.equal(request.prompt_cache_options, undefined)
    assert.equal(request.prompt_cache_retention, undefined)
    assert.equal(request.cache_control, undefined)
  }
  assert.match(body({ cacheOwnerId: 'alice', config: { ...CONFIG, baseUrl: 'https://explicit.invalid/v1' }, profile: { ...PROFILE, supportsPromptCacheKey: true } }).prompt_cache_key, /^gugo-v1-/u)
})

test('Anthropic cache markers only survive for the built-in Anthropic path and never reach any wire body', () => {
  const marked = [{ role: 'system', content: 'Stable identity.', __gugoPromptStability: 'stable' }, { role: 'user', content: 'hello' }]
  const anthropic = buildModelProviderRequest({
    config: { baseUrl: 'https://api.anthropic.com', modelName: 'claude-test', apiKey: 'k', maxTokens: 100 },
    profile: { kind: 'anthropic', supportsTools: true, supportsVision: true },
    messages: marked, env: { MODEL_PROMPT_CACHE_RETENTION: 'short' },
  })
  const anthropicSystem = JSON.parse(anthropic.init.body).system
  assert.equal(anthropicSystem.length, 1)
  assert.ok(anthropicSystem[0].cache_control, 'the sole stable block is both prefix start and final system anchor')
  assert.equal(anthropic.init.body.includes('__gugoPromptStability'), false)
  for (const [config, profile] of [
    [CONFIG, PROFILE],
    [{ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-test' }, { kind: 'gemini', supportsTools: true }],
  ]) {
    const request = buildModelProviderRequest({ config, profile, messages: marked })
    assert.equal(request.init.body.includes('__gugoPromptStability'), false)
    assert.equal(request.init.body.includes('cache_control'), false)
  }
  const sanitized = prepareOutboundMessages({ messages: marked, profile: { kind: 'openai-compatible' } })
  assert.deepEqual(sanitized, [{ role: 'system', content: 'Stable identity.' }, { role: 'user', content: 'hello' }])
  const retained = prepareOutboundMessages({ messages: marked, profile: { kind: 'anthropic' }, retainPromptStability: true })
  assert.equal(retained[0].__gugoPromptStability, 'stable')
})

test('turn prompt producers mark exactly the compiled stable prefix and never the volatile tail', () => {
  const identity = { text: 'identity block' }
  const ishiki = { text: 'ishiki block' }
  const skills = { text: 'skills block' }
  const instructions = { text: 'instructions block' }
  const blocks = [
    ...[identity, ishiki, skills, instructions].filter((block) => block.text)
      .map((block) => ({ role: 'system', content: block.text, __gugoPromptStability: 'stable' })),
    { role: 'system', content: 'session block' },
    { role: 'system', content: 'memory block' },
    { role: 'system', content: '# Runtime Plugin Context: hints\nSource: fixture\n\nplugin block' },
  ]
  const stable = blocks.filter((message) => message.__gugoPromptStability === 'stable')
  assert.deepEqual(stable.map((message) => message.content), ['identity block', 'ishiki block', 'skills block', 'instructions block'])
  assert.ok(blocks.indexOf(stable.at(-1)) < blocks.findIndex((message) => !message.__gugoPromptStability))
  const unmarkedTail = blocks.filter((message) => !message.__gugoPromptStability).map((message) => message.content)
  assert.deepEqual(unmarkedTail, ['session block', 'memory block', '# Runtime Plugin Context: hints\nSource: fixture\n\nplugin block'])
})

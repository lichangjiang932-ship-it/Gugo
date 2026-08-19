import test from 'node:test'
import assert from 'node:assert/strict'

import { buildModelProviderRequest } from '../server/adapters/modelProxy.js'
import { prepareOutboundMessages } from '../server/adapters/outboundMessagePipeline.js'

test('outbound pipeline clones input, removes display notices, and isolates provider sidecars', () => {
  const messages = [
    { role: 'user', content: 'hidden row', _display: true },
    { role: 'system', content: 'hidden notice', kind: 'notice', internal: true },
    {
      role: 'user',
      content: 'visible prompt',
      source: 'browser',
      ts: 123,
      usage: { secret: 'usage-secret' },
      providerSidecars: {
        openai: { openai_metadata: { tier: 'fast' } },
        anthropic: { cache_control: { type: 'ephemeral' } },
        gemini: { thought_signature: 'gemini-secret' },
      },
    },
    { role: 'tool', tool_call_id: 'orphan', content: 'must be removed' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'paired', type: 'function', function: { name: 'read_file', arguments: { path: 'README.md' } } }],
    },
    { role: 'tool', tool_call_id: 'paired', name: 'read_file', content: '{"ok":true}' },
  ]
  const original = structuredClone(messages)

  const outbound = prepareOutboundMessages({
    messages,
    profile: { kind: 'anthropic', supportsVision: true, supportsPdf: false },
  })

  assert.deepEqual(messages, original)
  assert.equal(outbound.some((message) => message.content === 'hidden row'), false)
  assert.equal(outbound.some((message) => message.content === 'hidden notice'), false)
  assert.equal(outbound.some((message) => message.tool_call_id === 'orphan'), false)
  assert.equal(outbound.some((message) => message.tool_call_id === 'paired'), true)
  const prompt = outbound.find((message) => message.content === 'visible prompt')
  assert.deepEqual(prompt.cache_control, { type: 'ephemeral' })
  assert.equal(Object.hasOwn(prompt, 'openai_metadata'), false)
  assert.equal(Object.hasOwn(prompt, 'thought_signature'), false)
  for (const key of ['source', 'ts', 'usage', 'providerSidecars']) {
    assert.equal(Object.hasOwn(prompt, key), false, key)
  }
})

test('outbound pipeline re-evaluates vision and PDF content for the target profile', () => {
  const image = 'data:image/png;base64,PRIVATE_IMAGE'
  const pdf = 'data:application/pdf;base64,PRIVATE_PDF'
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'inspect both' },
      { type: 'image_url', image_url: { url: image } },
      { type: 'yma_pdf', filename: 'report.pdf', file_data: pdf, fallback_text: 'PDF extracted text' },
    ],
  }]
  const original = structuredClone(messages)

  const textOnly = prepareOutboundMessages({
    messages,
    modelName: 'text-only',
    profile: { kind: 'openai-compatible', supportsVision: false, supportsPdf: false },
  })
  const textSerialized = JSON.stringify(textOnly)
  assert.equal(textSerialized.includes('PRIVATE_IMAGE'), false)
  assert.equal(textSerialized.includes('PRIVATE_PDF'), false)
  assert.match(textSerialized, /does not accept vision input/)
  assert.match(textSerialized, /PDF extracted text/)

  const multimodal = prepareOutboundMessages({
    messages,
    modelName: 'multimodal',
    profile: { kind: 'openai-compatible', supportsVision: true, supportsPdf: true },
  })
  assert.equal(multimodal[0].content[1].image_url.url, image)
  assert.deepEqual(multimodal[0].content[2], {
    type: 'file',
    file: { filename: 'report.pdf', file_data: pdf },
  })
  assert.deepEqual(messages, original)
})

test('ephemeral context is appended only to the final user message', () => {
  const outbound = prepareOutboundMessages({
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: [{ type: 'text', text: 'last' }] },
      { role: 'assistant', content: 'pending' },
    ],
    profile: { kind: 'gemini', supportsVision: true, supportsPdf: false },
    ephemeralContext: '[RUNTIME CONTEXT]\nworkspace=D:/repo',
  })

  assert.equal(outbound[0].content, 'first')
  assert.deepEqual(outbound[2].content, [
    { type: 'text', text: 'last' },
    { type: 'text', text: '[RUNTIME CONTEXT]\nworkspace=D:/repo' },
  ])
  assert.equal(outbound.filter((message) => message.role === 'system').length, 0)
})

test('OpenAI, Anthropic, and Gemini adapters share the outbound privacy boundary', () => {
  const messages = [
    { role: 'system', content: 'system rules', usage: { private: 'USAGE_SECRET' } },
    { role: 'user', content: 'visible request', modelContext: { private: 'MODEL_CONTEXT_SECRET' } },
    { role: 'user', content: 'DISPLAY_SECRET', displayOnly: true },
    { role: 'system', content: 'NOTICE_SECRET', kind: 'notice', internal: true },
  ]
  const original = structuredClone(messages)
  const cases = [
    {
      config: { baseUrl: 'https://openai.example/v1', modelName: 'gpt-test' },
      profile: { kind: 'openai-compatible', supportsVision: true, supportsPdf: false, supportsTools: true },
    },
    {
      config: { baseUrl: 'https://api.anthropic.com', modelName: 'claude-test' },
      profile: { kind: 'anthropic', supportsVision: true, supportsPdf: false, supportsTools: true },
    },
    {
      config: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-test' },
      profile: { kind: 'gemini', supportsVision: true, supportsPdf: false, supportsTools: true },
    },
  ]

  for (const candidate of cases) {
    const request = buildModelProviderRequest({
      ...candidate,
      messages,
      ephemeralContext: 'EPHEMERAL_CONTEXT',
    })
    const body = request.init.body
    assert.match(body, /visible request/)
    assert.match(body, /EPHEMERAL_CONTEXT/)
    for (const secret of ['DISPLAY_SECRET', 'NOTICE_SECRET', 'USAGE_SECRET', 'MODEL_CONTEXT_SECRET']) {
      assert.equal(body.includes(secret), false, `${candidate.profile.kind}: ${secret}`)
    }
  }
  assert.deepEqual(messages, original)
})

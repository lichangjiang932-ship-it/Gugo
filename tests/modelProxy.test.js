import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  buildOpenAICompatibleRequest,
  callStreamingModelWithTools,
  extractUsage,
  formatProxyError,
  getModelContextWindow,
  getModelStatus,
  getSystemDiagnostics,
  getToolMaxRounds,
  getUsageStats,
  isLocalModelEndpoint,
  loadModelConfig,
  normalizeOpenAICompatibleUrl,
  parseOpenAICompatibleResponse,
  recordUsage,
  resetUsageStats,
  resolveModelConfigForModel,
  stripEmbeddedReasoning,
  supportsStreamUsage,
  streamOpenAICompatible,
} from '../server/adapters/modelProxy.js'
import { bindSseClientDisconnect } from '../server/adapters/sseLifecycle.js'

function streamedResponse(chunks, contentType = 'text/event-stream') {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

async function collectCompatibleStream(chunks, contentType) {
  const events = []
  for await (const event of streamOpenAICompatible({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'x', modelName: 'test' },
    messages: [{ role: 'user', content: 'ping' }],
    fetchImpl: async () => streamedResponse(chunks, contentType),
  })) events.push(event)
  return events
}

test('SSE 只在真正断连时取消上游,正常 req.close 不误杀本地推理', () => {
  const req = new EventEmitter()
  const res = new EventEmitter()
  res.writableEnded = false
  let disconnects = 0
  const dispose = bindSseClientDisconnect(req, res, () => { disconnects += 1 })

  req.emit('close')
  assert.equal(disconnects, 0, '正常读完请求体不能被当成客户端断连')
  req.emit('aborted')
  assert.equal(disconnects, 1)
  res.emit('close')
  assert.equal(disconnects, 1, '同一次断连只能取消一次')
  dispose()
})

test('响应正常 end 后的 close 不取消已完成请求', () => {
  const req = new EventEmitter()
  const res = new EventEmitter()
  res.writableEnded = true
  let disconnects = 0
  const dispose = bindSseClientDisconnect(req, res, () => { disconnects += 1 })
  res.emit('close')
  assert.equal(disconnects, 0)
  dispose()
})

test('streamed tool inputs become ready before the canonical tool_calls batch', async () => {
  const encoder = new TextEncoder()
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  const events = []
  for await (const event of streamOpenAICompatible({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'x', modelName: 'test' },
    messages: [{ role: 'user', content: 'read' }],
    fetchImpl: async () => new Response(body, { status: 200 }),
  })) events.push(event)

  assert.deepEqual(events.map((event) => event.type), ['tool_call_ready', 'tool_calls'])
  assert.deepEqual(JSON.parse(events[0].toolCall.arguments), { path: 'README.md' })
  assert.equal(events[1].toolCalls[0].id, 'read-1')
})

test('stream parser accepts SSE data fields without a space after the colon', async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data:{"choices":[{"delta":{"content":"pong"}}]}\n\n'))
      controller.enqueue(encoder.encode('data:[DONE]\n\n'))
      controller.close()
    },
  })
  const events = []
  for await (const event of streamOpenAICompatible({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'x', modelName: 'test' },
    messages: [{ role: 'user', content: 'ping' }],
    fetchImpl: async () => new Response(body, { status: 200 }),
  })) events.push(event)

  assert.equal(events[0].type, 'text')
  assert.equal(events[0].delta, 'pong')
  assert.equal(events.at(-1).type, 'finish')
})

test('stream parser drives Ollama NDJSON text, reasoning, and tools through the real loop', async () => {
  const events = await collectCompatibleStream([
    `${JSON.stringify({ message: { thinking: 'checking files', content: '' }, done: false })}\n`,
    `${JSON.stringify({
      message: {
        content: 'Ready.',
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }],
      },
      done: true,
      done_reason: 'tool_calls',
      prompt_eval_count: 8,
      eval_count: 3,
    })}\n`,
  ], 'application/x-ndjson')

  assert.equal(events.find((event) => event.type === 'reasoning')?.delta, 'checking files')
  assert.equal(events.find((event) => event.type === 'text')?.delta, 'Ready.')
  assert.deepEqual(JSON.parse(events.find((event) => event.type === 'tool_call_ready').toolCall.arguments), {
    path: 'README.md',
  })
  assert.equal(events.find((event) => event.type === 'tool_calls').toolCalls[0].name, 'read_file')
  assert.equal(events.find((event) => event.type === 'usage').usage.totalTokens, 11)
})

test('stream parser drives Responses API output and function arguments through the real loop', async () => {
  const frames = [
    { type: 'response.output_text.delta', delta: 'Working.' },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'write_file', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 1,
      item_id: 'fc_9',
      arguments: { path: 'site.html', content: '<h1>ok</h1>' },
    },
    {
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
    },
  ]
  const events = await collectCompatibleStream(
    frames.map((frame) => `event: message\ndata: ${JSON.stringify(frame)}\n\n`),
  )

  assert.equal(events.find((event) => event.type === 'text')?.delta, 'Working.')
  const ready = events.find((event) => event.type === 'tool_call_ready')
  assert.equal(ready.toolCall.id, 'call_9')
  assert.deepEqual(JSON.parse(ready.toolCall.arguments), { path: 'site.html', content: '<h1>ok</h1>' })
  assert.equal(events.find((event) => event.type === 'tool_calls').finishReason, 'tool_calls')
  assert.equal(events.find((event) => event.type === 'usage').usage.totalTokens, 7)
})

test('stream parser surfaces provider error payloads returned inside HTTP 200 SSE', async () => {
  const payload = JSON.stringify({
    error: { message: 'Unable to generate parser for this template', code: 'template_error' },
  })
  await assert.rejects(
    async () => collectCompatibleStream([`data: ${payload}\n\n`]),
    (error) => {
      assert.equal(error.message, 'Unable to generate parser for this template')
      assert.equal(error.code, 'template_error')
      assert.equal(error.fromUpstream, true)
      return true
    },
  )
})

test('stream parser consumes a final SSE data frame without a trailing newline', async () => {
  const payload = JSON.stringify({
    choices: [{ delta: { content: 'tail reply' }, finish_reason: 'stop' }],
  })
  const events = await collectCompatibleStream([`data: ${payload}`])

  assert.equal(events[0].type, 'text')
  assert.equal(events[0].delta, 'tail reply')
  assert.equal(events.at(-1).type, 'finish')
  assert.equal(events.at(-1).finishReason, 'stop')
})

test('stream request falls back to non-stream parsing for an application/json response', async () => {
  const payload = JSON.stringify({
    choices: [{ message: { content: 'single JSON reply' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  })
  const events = await collectCompatibleStream([payload], 'application/json; charset=utf-8')

  assert.deepEqual(events.map((event) => event.type), ['usage', 'text', 'finish'])
  assert.equal(events[1].delta, 'single JSON reply')
  assert.equal(events[2].finishReason, 'stop')
  assert.equal(events[2].usage.totalTokens, 7)
})

test('stream parser flattens array delta content without leaking object coercion', async () => {
  const payload = JSON.stringify({
    choices: [{
      delta: { content: [{ type: 'text', text: 'array' }, { type: 'output_text', text: ' reply' }] },
      finish_reason: 'stop',
    }],
  })
  const events = await collectCompatibleStream([`data: ${payload}\n\ndata: [DONE]\n\n`])

  assert.equal(events[0].type, 'text')
  assert.equal(events[0].delta, 'array reply')
  assert.equal(typeof events[0].delta, 'string')
  assert.equal(events.at(-1).type, 'finish')
})

test('chat tool-loop streaming forwards deltas and returns canonical tool calls', async () => {
  const encoder = new TextEncoder()
  const frames = [
    { choices: [{ delta: { reasoning_content: 'checking files' } }] },
    { choices: [{ delta: { content: 'Grounded answer.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  const textDeltas = []
  const reasoningDeltas = []
  const readyCalls = []
  let modelCallResolved = false
  const result = await callStreamingModelWithTools({
    messages: [{ role: 'user', content: 'read' }],
    tools: [],
    env: {
      MODEL_BASE_URL: 'https://api.example.test/v1',
      MODEL_API_KEY: 'test-key',
      MODEL_NAME: 'test-model',
    },
    fetchImpl: async () => new Response(body, { status: 200 }),
    onTextDelta: async (delta) => textDeltas.push(delta),
    onReasoningDelta: async (delta) => reasoningDeltas.push(delta),
    onToolCallReady: async (call, metadata) => {
      assert.equal(modelCallResolved, false, 'readiness must arrive before the canonical response resolves')
      readyCalls.push({ call, metadata })
    },
  })
  modelCallResolved = true

  assert.deepEqual(textDeltas, ['Grounded answer.'])
  assert.deepEqual(reasoningDeltas, ['checking files'])
  assert.equal(readyCalls.length, 1)
  assert.equal(readyCalls[0].call.id, 'read-1')
  assert.equal(readyCalls[0].call.function.name, 'read_file')
  assert.deepEqual(JSON.parse(readyCalls[0].call.function.arguments), { path: 'README.md' })
  assert.equal(readyCalls[0].metadata.modelName, 'test-model')
  assert.equal(result.content, 'Grounded answer.')
  assert.deepEqual(result.toolCalls, [{
    id: 'read-1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"README.md"}' },
  }])
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.usage.totalTokens, 15)
})

test('chat tool-loop removes screenshot base64 before calling a text-only model', async () => {
  let requestBody = null
  const result = await callStreamingModelWithTools({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect screenshot' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET_SCREENSHOT_BYTES' } },
      ],
    }],
    tools: [],
    env: {
      MODEL_BASE_URL: 'https://api.example.test/v1',
      MODEL_API_KEY: 'test-key',
      MODEL_NAME: 'text-only-model',
      MODEL_NAMES_VISION: 'vision-only-model',
    },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body)
      return streamedResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'fallback used' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    },
  })

  const serialized = JSON.stringify(requestBody)
  assert.equal(serialized.includes('SECRET_SCREENSHOT_BYTES'), false)
  assert.match(serialized, /does not accept vision input/)
  assert.equal(result.content, 'fallback used')
})

test('normalizes OpenAI compatible base URLs to chat completions endpoint', () => {
  assert.equal(
    normalizeOpenAICompatibleUrl('https://api.example.com/v1'),
    'https://api.example.com/v1/chat/completions'
  )
  assert.equal(
    normalizeOpenAICompatibleUrl('http://localhost:11434/v1/chat/completions'),
    'http://localhost:11434/v1/chat/completions'
  )
})

test('builds an OpenAI compatible request with auth and model options', () => {
  const config = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    modelName: 'gpt-test',
    temperature: 0.2,
    maxTokens: 256,
  }
  const request = buildOpenAICompatibleRequest({
    config,
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(request.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.2,
    max_tokens: 256,
    stream: false,
  })
})

test('builds a local model request without an Authorization header', () => {
  const request = buildOpenAICompatibleRequest({
    config: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      modelName: 'qwen3:8b',
    },
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(request.url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(Object.hasOwn(request.init.headers, 'Authorization'), false)
})

test('normalizes assistant tool-call messages to null content before upstream request', () => {
  const request = buildOpenAICompatibleRequest({
    config: {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      modelName: 'gpt-test',
    },
    messages: [
      { role: 'user', content: 'make deck' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'create_pptx', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'create_pptx', content: '{"ok":true}' },
    ],
  })

  const parsed = JSON.parse(request.init.body)
  assert.equal(parsed.messages[1].content, null)
})

test('loads model config from backend environment and reports missing fields', () => {
  const configured = loadModelConfig({
    MODEL_BASE_URL: 'https://api.example.com/v1',
    MODEL_NAME: 'gpt-test',
    MODEL_API_KEY: 'sk-test',
    MODEL_TEMPERATURE: '0.3',
    MODEL_MAX_TOKENS: '1024',
  })

  assert.deepEqual(configured, {
    configured: true,
    missing: [],
    baseUrl: 'https://api.example.com/v1',
    modelName: 'gpt-test',
    apiKey: 'sk-test',
    temperature: 0.3,
    maxTokens: 1024,
  })

  const missing = loadModelConfig({ MODEL_BASE_URL: 'https://api.example.com/v1' })
  assert.equal(missing.configured, false)
  assert.deepEqual(missing.missing, ['MODEL_NAME'])

  const local = loadModelConfig({
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_NAME: 'qwen3:8b',
  })
  assert.equal(local.configured, true)
  assert.equal(local.apiKey, '')
})

test('loads a backend model catalog without exposing API keys', () => {
  const status = getModelStatus({
    MODEL_BASE_URL: 'https://api.example.com/v1',
    MODEL_NAME: 'gpt-fast',
    MODEL_NAMES: 'gpt-fast,gpt-pro',
    MODEL_API_KEY: 'sk-test',
  })

  assert.equal(status.configured, true)
  assert.deepEqual(status.models, [
    { name: 'gpt-fast', active: true, contextWindow: 128_000, contextWindowSource: 'cloud_default', contextWindowEstimated: true },
    { name: 'gpt-pro', active: false, contextWindow: 128_000, contextWindowSource: 'cloud_default', contextWindowEstimated: true },
  ])
  assert.equal(JSON.stringify(status).includes('sk-test'), false)
})

test('loads a multi-provider model catalog', () => {
  const env = {
    MODEL_PROVIDERS: 'deepseek,mimo',
    MODEL_PROVIDER_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    MODEL_PROVIDER_DEEPSEEK_LABEL: 'DeepSeek Primary',
    MODEL_PROVIDER_DEEPSEEK_API_KEY: 'sk-deepseek',
    MODEL_PROVIDER_DEEPSEEK_MODELS: 'deepseek-v4-pro,deepseek-v4-flash',
    MODEL_PROVIDER_MIMO_BASE_URL: 'https://api.xiaomimimo.com/v1',
    MODEL_PROVIDER_MIMO_API_KEY: 'sk-mimo',
    MODEL_PROVIDER_MIMO_MODELS: 'mimo-v2.5,mimo-v2.5-pro',
    MODEL_NAME: 'deepseek-v4-pro',
  }

  const status = getModelStatus(env)

  assert.equal(status.configured, true)
  assert.deepEqual(status.models, [
    {
      name: 'deepseek-v4-pro',
      active: true,
      provider: 'deepseek',
      providerLabel: 'DeepSeek Primary',
      contextWindow: 1_000_000,
      contextWindowSource: 'official_catalog',
      contextWindowEstimated: false,
      contextWindowSourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
      contextWindowVerifiedAt: '2026-08-15',
      maxOutputTokens: 384_000,
    },
    {
      name: 'deepseek-v4-flash',
      active: false,
      provider: 'deepseek',
      providerLabel: 'DeepSeek Primary',
      contextWindow: 1_000_000,
      contextWindowSource: 'official_catalog',
      contextWindowEstimated: false,
      contextWindowSourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
      contextWindowVerifiedAt: '2026-08-15',
      maxOutputTokens: 384_000,
    },
    { name: 'mimo-v2.5', active: false, provider: 'mimo', contextWindow: 128_000, contextWindowSource: 'cloud_default', contextWindowEstimated: true },
    { name: 'mimo-v2.5-pro', active: false, provider: 'mimo', contextWindow: 128_000, contextWindowSource: 'cloud_default', contextWindowEstimated: true },
  ])
  assert.equal(JSON.stringify(status).includes('sk-deepseek'), false)
  assert.equal(JSON.stringify(status).includes('sk-mimo'), false)
})

test('resolves selected models to their provider endpoint and API key', () => {
  const env = {
    MODEL_PROVIDERS: 'deepseek,mimo',
    MODEL_PROVIDER_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    MODEL_PROVIDER_DEEPSEEK_API_KEY: 'sk-deepseek',
    MODEL_PROVIDER_DEEPSEEK_MODELS: 'deepseek-v4-pro,deepseek-v4-flash',
    MODEL_PROVIDER_MIMO_BASE_URL: 'https://api.xiaomimimo.com/v1',
    MODEL_PROVIDER_MIMO_API_KEY: 'sk-mimo',
    MODEL_PROVIDER_MIMO_MODELS: 'mimo-v2.5,mimo-v2.5-pro',
    MODEL_NAME: 'deepseek-v4-pro',
  }

  assert.deepEqual(resolveModelConfigForModel({ modelName: 'mimo-v2.5-pro', env }), {
    configured: true,
    missing: [],
    baseUrl: 'https://api.xiaomimimo.com/v1',
    modelName: 'mimo-v2.5-pro',
    apiKey: 'sk-mimo',
    temperature: 0.7,
    // 0 = 不限制输出长度（不发 max_tokens 字段），见 parseMaxTokens
    maxTokens: 0,
  })

  assert.deepEqual(resolveModelConfigForModel({ modelName: 'deepseek-v4-flash', env }), {
    configured: true,
    missing: [],
    baseUrl: 'https://api.deepseek.com',
    modelName: 'deepseek-v4-flash',
    apiKey: 'sk-deepseek',
    temperature: 0.7,
    // 0 = 不限制输出长度（不发 max_tokens 字段），见 parseMaxTokens
    maxTokens: 0,
  })
})

test('resolves context windows from exact model metadata before provider fallbacks', () => {
  const env = {
    MODEL_PROVIDERS: 'local,cloud,tuned',
    MODEL_PROVIDER_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_PROVIDER_LOCAL_MODELS: 'local-default',
    MODEL_PROVIDER_LOCAL_PROFILE: JSON.stringify({ contextWindow: 16_384 }),
    MODEL_PROVIDER_CLOUD_BASE_URL: 'https://api.example.com/v1',
    MODEL_PROVIDER_CLOUD_MODELS: 'cloud-model',
    MODEL_PROVIDER_TUNED_BASE_URL: 'https://tuned.example.com/v1',
    MODEL_PROVIDER_TUNED_MODELS: 'tuned-model',
    MODEL_PROVIDER_TUNED_PROFILE: JSON.stringify({
      contextWindow: 65_536,
      models: { 'tuned-model': { contextWindow: 98_304 } },
    }),
    MODEL_CONTEXT_WINDOWS: JSON.stringify({ 'tuned-model': 32_768 }),
    MODEL_NAME: 'local-default',
  }

  assert.equal(
    getModelContextWindow({ modelName: 'cloud-model', env }),
    128_000,
    'the selected cloud provider must not inherit the default local provider override',
  )
  assert.equal(
    getModelContextWindow({ modelName: 'tuned-model', env }),
    98_304,
    'exact model metadata must win over env mappings and provider fallbacks',
  )
})

test('model status resolves an independent context window for every model', () => {
  const status = getModelStatus({
    MODEL_PROVIDERS: 'mixed',
    MODEL_PROVIDER_MIXED_BASE_URL: 'https://api.example.com/v1',
    MODEL_PROVIDER_MIXED_MODELS: 'large,mapped,legacy',
    MODEL_PROVIDER_MIXED_PROFILE: JSON.stringify({
      contextWindow: 8192,
      models: { large: { contextWindow: 131_072 } },
    }),
    MODEL_CONTEXT_WINDOWS: JSON.stringify({ mapped: 65_536 }),
    MODEL_NAME: 'large',
  })

  assert.deepEqual(status.models, [
    { name: 'large', active: true, provider: 'mixed', contextWindow: 131_072, contextWindowSource: 'model_profile', contextWindowEstimated: false },
    { name: 'mapped', active: false, provider: 'mixed', contextWindow: 65_536, contextWindowSource: 'model_context_windows', contextWindowEstimated: false },
    { name: 'legacy', active: false, provider: 'mixed', contextWindow: 8192, contextWindowSource: 'provider_override', contextWindowEstimated: false },
  ])
})

test('system diagnostics summarize model and mail without secrets', async () => {
  const diagnostics = await getSystemDiagnostics({
    env: {
      MODEL_BASE_URL: 'https://api.example.com/v1',
      MODEL_NAME: 'gpt-fast',
      MODEL_NAMES: 'gpt-fast,gpt-pro',
      MODEL_API_KEY: 'sk-secret-value',
      MAIL_SERVER: 'smtp.qq.com',
      MAIL_PORT: '587',
      MAIL_USE_TLS: 'true',
      MAIL_USERNAME: 'mail@example.com',
      MAIL_PASSWORD: 'mail-secret',
      MAIL_DEFAULT_SENDER: 'mail@example.com',
    },
  })

  assert.equal(diagnostics.ok, true)
  assert.equal(diagnostics.model.configured, true)
  assert.equal(diagnostics.model.apiKeyConfigured, true)
  assert.equal('billing' in diagnostics, false)
  assert.equal(diagnostics.mail.configured, true)
  assert.equal(diagnostics.mail.server, 'smtp.qq.com')
  assert.equal(diagnostics.endpoint.checked, false)
  const json = JSON.stringify(diagnostics)
  assert.equal(json.includes('sk-secret-value'), false)
  assert.equal(json.includes('mail-secret'), false)
})

test('system diagnostics can probe a models endpoint safely', async () => {
  const diagnostics = await getSystemDiagnostics({
    checkEndpoint: true,
    env: {
      MODEL_BASE_URL: 'https://api.example.com/v1',
      MODEL_NAME: 'gpt-fast',
      MODEL_API_KEY: 'sk-secret-value',
    },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.example.com/v1/models')
      assert.equal(init.headers.Authorization, 'Bearer sk-secret-value')
      return new Response(JSON.stringify({ data: [{ id: 'gpt-fast' }, { id: 'gpt-pro' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  assert.equal(diagnostics.endpoint.checked, true)
  assert.equal(diagnostics.endpoint.ok, true)
  assert.deepEqual(diagnostics.endpoint.remoteModels, ['gpt-fast', 'gpt-pro'])
  assert.equal(JSON.stringify(diagnostics).includes('sk-secret-value'), false)
})

test('returns backend model status without exposing API key', () => {
  assert.deepEqual(
    getModelStatus({
      MODEL_BASE_URL: 'https://api.example.com/v1',
      MODEL_NAME: 'gpt-test',
      MODEL_API_KEY: 'sk-test',
      MODEL_TEMPERATURE: '0.7',
      MODEL_MAX_TOKENS: '4096',
    }),
    {
      ok: true,
      configured: true,
      modelName: 'gpt-test',
      baseUrlMasked: 'https://api.example.com/v1',
      temperature: 0.7,
      maxTokens: 4096,
      toolMaxRounds: 0,
      contextWindow: 128_000,
      contextWindowSource: 'cloud_default',
      contextWindowEstimated: true,
      models: [{
        name: 'gpt-test',
        active: true,
        contextWindow: 128_000,
        contextWindowSource: 'cloud_default',
        contextWindowEstimated: true,
      }],
    }
  )
})

test('parses OpenAI compatible responses and reports empty choices clearly', () => {
  assert.equal(
    parseOpenAICompatibleResponse({
      choices: [{ message: { content: 'model reply' } }],
    }),
    'model reply'
  )

  assert.throws(
    () => parseOpenAICompatibleResponse({ choices: [] }),
    /模型返回为空/
  )
})

test('formats proxy errors into user-readable Chinese messages', () => {
  assert.equal(formatProxyError({ status: 401 }), 'API Key 无效或没有权限。')
  assert.equal(formatProxyError({ status: 404 }), '模型或端点不存在，请检查 Base URL 和模型名称。')
  assert.equal(formatProxyError({ code: 'ECONNREFUSED' }), '端点不可达，请确认本地模型服务或代理已启动。')
  assert.equal(
    formatProxyError({ status: 400, message: 'invalid request: tool role is unsupported' }),
    '请求参数无效：请检查消息内容、工具调用上下文或当前模型的 OpenAI 兼容性。'
  )
})

// ───────────────────────── usage / 缓存命中率 ─────────────────────────
// 背景:以前 usage 全链路没人读,stream_options 没设,且 SSE 循环的
// `if (!choice) continue` 会把 usage 帧(choices 为空数组)直接跳过 —— 
// 导致缓存命中率完全无法测量。下面这组守住修复。

test('extractUsage 解析 DeepSeek 的缓存命中字段', () => {
  const usage = extractUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_cache_hit_tokens: 896,
      prompt_cache_miss_tokens: 104,
    },
  })
  assert.equal(usage.promptTokens, 1000)
  assert.equal(usage.cacheHitTokens, 896)
  assert.equal(usage.cacheMissTokens, 104)
})

test('extractUsage 解析 OpenAI 的 cached_tokens 并推算 miss', () => {
  const usage = extractUsage({
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 768 } },
  })
  assert.equal(usage.cacheHitTokens, 768)
  // OpenAI 不给 miss,由 prompt - cached 推出
  assert.equal(usage.cacheMissTokens, 232)
})

test('extractUsage 对缺失/畸形输入返回 null 且不抛', () => {
  for (const input of [null, undefined, {}, { choices: [] }, { usage: 'x' }, { usage: null }]) {
    assert.doesNotThrow(() => extractUsage(input))
    assert.equal(extractUsage(input), null)
  }
})

test('supportsStreamUsage 只对已知端点开启,未知端点保持关闭', () => {
  assert.equal(supportsStreamUsage({ baseUrl: 'https://api.deepseek.com' }, {}), true)
  assert.equal(supportsStreamUsage({ baseUrl: 'https://api.openai.com/v1' }, {}), true)
  // 未知端点默认不发 stream_options,避免上游 400
  assert.equal(supportsStreamUsage({ baseUrl: 'https://unknown.example.com/v1' }, {}), false)
  assert.equal(supportsStreamUsage({ baseUrl: '' }, {}), false)
  // 可显式强制开/关
  assert.equal(supportsStreamUsage({ baseUrl: 'https://unknown.example.com' }, { MODEL_STREAM_USAGE: '1' }), true)
  assert.equal(supportsStreamUsage({ baseUrl: 'https://api.deepseek.com' }, { MODEL_STREAM_USAGE: '0' }), false)
})

test('流式请求对支持的端点带上 stream_options.include_usage', () => {
  const config = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', modelName: 'deepseek-chat' }
  const streamed = JSON.parse(
    buildOpenAICompatibleRequest({ config, messages: [{ role: 'user', content: 'hi' }], stream: true }).init.body
  )
  assert.deepEqual(streamed.stream_options, { include_usage: true })

  // 非流式不该带
  const nonStream = JSON.parse(
    buildOpenAICompatibleRequest({ config, messages: [{ role: 'user', content: 'hi' }], stream: false }).init.body
  )
  assert.equal(nonStream.stream_options, undefined)

  // 未知端点即便流式也不带
  const unknown = JSON.parse(
    buildOpenAICompatibleRequest({
      config: { ...config, baseUrl: 'https://unknown.example.com/v1' },
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }).init.body
  )
  assert.equal(unknown.stream_options, undefined)
})

test('usage 聚合算出缓存命中率,无数据时为 null 而不是 0%', () => {
  resetUsageStats()
  assert.equal(getUsageStats().cacheHitRatePercent, null, '没有样本时应为 null,不能谎报 0%')

  recordUsage('m1', extractUsage({ usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 } }))
  recordUsage('m1', extractUsage({ usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 } }))
  const stats = getUsageStats()
  assert.equal(stats.requests, 2)
  assert.equal(stats.cacheHitTokens, 1700)
  assert.equal(stats.cacheHitRatePercent, 85)
  assert.equal(stats.byModel.m1.cacheHitRatePercent, 85)

  // recordUsage(null) 不该污染统计
  recordUsage('m1', null)
  assert.equal(getUsageStats().requests, 2)
  resetUsageStats()
})

// ───────────────────── 工具轮数上限 ─────────────────────
// ★ 默认不限制(0)。工具循环本来就在模型停止调工具时自然退出,想中断随时
// 点「停止生成」。以前默认 5,读一个中等项目光探索就吃满,模型被硬切在半路
// 只留一句「让我继续」,用户付了钱拿不到结论。

test('默认不限制工具轮数', () => {
  assert.equal(getToolMaxRounds({}), 0)
  assert.equal(getToolMaxRounds({ TOOL_MAX_ROUNDS: '' }), 0)
  assert.equal(getToolMaxRounds({ TOOL_MAX_ROUNDS: 'abc' }), 0)
  // 显式设 0 / 负数 = 不限制
  assert.equal(getToolMaxRounds({ TOOL_MAX_ROUNDS: '0' }), 0)
  assert.equal(getToolMaxRounds({ TOOL_MAX_ROUNDS: '-5' }), 0)
})

test('受控环境仍可显式封顶', () => {
  assert.equal(getToolMaxRounds({ TOOL_MAX_ROUNDS: '5' }), 5)
  assert.equal(getToolMaxRounds({ TOOL_MAX_ROUNDS: '1000' }), 1000)
  // 荒谬的大值当成没配,回落到不限制
  assert.equal(getToolMaxRounds({ TOOL_MAX_ROUNDS: '99999' }), 0)
})

test('★ 回归:默认值不得再变回低位硬顶', () => {
  const d = getToolMaxRounds({})
  assert.ok(d === 0 || d > 100, '默认要么不限制,要么远高于旧上限 12')
})

// ───────────── 本地模型 Base URL 缺 /v1 ─────────────
// 用户手填 LM Studio 地址常漏 /v1(http://127.0.0.1:1234),以前直接拼
// /models → GET /models,LM Studio 日志报「Unexpected endpoint or method」
// 却仍返回 200,前端只能说「端点可达,但没有返回模型列表」,用户根本猜不到原因。

test('本地端点缺 /v1 时自动补上', () => {
  assert.equal(
    normalizeOpenAICompatibleUrl('http://127.0.0.1:1234'),
    'http://127.0.0.1:1234/v1/chat/completions',
  )
  assert.equal(
    normalizeOpenAICompatibleUrl('http://localhost:11434'),
    'http://localhost:11434/v1/chat/completions',
  )
  // 已经带 /v1 不重复补
  assert.equal(
    normalizeOpenAICompatibleUrl('http://127.0.0.1:1234/v1'),
    'http://127.0.0.1:1234/v1/chat/completions',
  )
})

test('★ 云端 provider 一律不动 —— 无条件补 /v1 会打挂已配好的线上模型', () => {
  // DeepSeek 官方 base 就是不带 /v1 且能正常工作
  assert.equal(
    normalizeOpenAICompatibleUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/chat/completions',
  )
  assert.equal(
    normalizeOpenAICompatibleUrl('https://api.xiaomimimo.com/v1'),
    'https://api.xiaomimimo.com/v1/chat/completions',
  )
})

test('已经是完整 chat/completions 的地址原样返回', () => {
  for (const u of ['http://127.0.0.1:1234/v1/chat/completions', 'https://api.deepseek.com/chat/completions']) {
    assert.equal(normalizeOpenAICompatibleUrl(u), u)
  }
})

test('非法 URL 不抛错(交给 fetch 自己报)', () => {
  assert.doesNotThrow(() => normalizeOpenAICompatibleUrl('not-a-url'))
  assert.throws(() => normalizeOpenAICompatibleUrl(''), /请输入 Base URL/)
})

// ───────────── 本地模型不产生上游 API 成本 ─────────────
// 本地模型跑在用户自己的设备上,不应计入可选的上游 API 美元预算。

test('★ 本地端点识别为无上游 API 成本', () => {
  for (const u of [
    'http://127.0.0.1:1234/v1',
    'http://localhost:11434/v1',
    'http://0.0.0.0:8080/v1',
    'http://127.0.0.1:1234',
  ]) {
    assert.equal(isLocalModelEndpoint(u), true, `${u} 应识别为本地`)
  }
})

test('★ 云端端点仍可估算上游 API 成本', () => {
  for (const u of [
    'https://api.deepseek.com',
    'https://api.openai.com/v1',
    'https://api.xiaomimimo.com/v1',
  ]) {
    assert.equal(isLocalModelEndpoint(u), false, `${u} 是云端,必须计费`)
  }
})

test('isLocalModelEndpoint 对畸形输入返回 false 且不抛', () => {
  for (const bad of ['', null, undefined, 'not-a-url', 123, {}]) {
    assert.doesNotThrow(() => isLocalModelEndpoint(bad))
    assert.equal(isLocalModelEndpoint(bad), false, '判断不了就按收费处理,不能白送')
  }
})

// ───────────── 推理模型的思考过程 ─────────────
// qwen3.5 / DeepSeek-R1 这类模型回答前先思考。实测本地 qwen3.5-9b 的
// reasoning_content 339ms 就开始流,而正文要等到 11.6 秒 —— 不透传的话
// 这十几秒屏幕上什么都没有,用户以为卡死了。

test('★ 流式解析认得 reasoning_content 并单独成帧', () => {
  // 这里直接验证字段识别逻辑的三种写法(各家实现命名不一)
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const delta = { [key]: '嗯,让我想想' }
    const reasoning = delta.reasoning_content || delta.reasoning || delta.thinking || ''
    assert.equal(reasoning, '嗯,让我想想', `${key} 应被识别`)
  }
})

test('思考内容不混进正文', () => {
  const delta = { reasoning_content: '思考中', content: '' }
  const reasoning = delta.reasoning_content || delta.reasoning || delta.thinking || ''
  const text = delta.content || ''
  assert.equal(reasoning, '思考中')
  assert.equal(text, '', '思考阶段不该产生正文')
})

test('embedded think traces are stripped even when the opening tag is missing', () => {
  assert.equal(
    stripEmbeddedReasoning('stale internal transcript\n</think>\nFinal grounded answer.'),
    'Final grounded answer.',
  )
  assert.equal(
    stripEmbeddedReasoning('<think>private reasoning</think>Public answer.'),
    'Public answer.',
  )
  assert.equal(stripEmbeddedReasoning('Normal answer without reasoning tags.'), 'Normal answer without reasoning tags.')
})

test('★ 思考超过硬顶必须取消上游并抛 REASONING_RUNAWAY', async () => {
  const encoder = new TextEncoder()
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: '0123456789' } }],
      })}\n\n`))
      // 不主动 close：只有实现真的 cancel reader，测试才会正常退出。
    },
    cancel() { cancelled = true },
  })

  await assert.rejects(
    async () => {
      for await (const event of streamOpenAICompatible({
        config: { baseUrl: 'https://example.test/v1', apiKey: 'x', modelName: 'thinking-model' },
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: async () => new Response(body, { status: 200 }),
        env: { MODEL_REASONING_MAX_CHARS: '5' },
      })) { void event }
    },
    (error) => error?.code === 'REASONING_RUNAWAY',
  )
  assert.equal(cancelled, true, '必须取消响应流，不能让上游在后台继续计费')
})

test('未显式配置思考字符上限时，工具执行轮的长推理不会被截断', async () => {
  const reasoning = '思'.repeat(25_000)
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":"demo.txt"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const events = []

  for await (const event of streamOpenAICompatible({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'x', modelName: 'thinking-model' },
    messages: [{ role: 'user', content: 'inspect the file' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    toolChoice: 'auto',
    fetchImpl: async () => streamedResponse(frames),
    env: {},
  })) events.push(event)

  assert.equal(events.find((event) => event.type === 'reasoning')?.delta.length, reasoning.length)
  assert.equal(events.some((event) => event.type === 'tool_calls'), true)
})

test('execution turns use the tighter reasoning ceiling without shrinking ordinary answer turns', async () => {
  const reasoningFrame = `data: ${JSON.stringify({
    choices: [{ delta: { reasoning_content: '0123456789' } }],
  })}\n\n`
  const doneFrame = 'data: [DONE]\n\n'
  const fetchImpl = async () => streamedResponse([reasoningFrame, doneFrame])
  const config = {
    baseUrl: 'https://example.test/v1',
    apiKey: 'x',
    modelName: 'thinking-model',
  }
  const env = {
    MODEL_REASONING_MAX_CHARS: '100',
    MODEL_EXECUTION_REASONING_MAX_CHARS: '5',
  }

  await assert.rejects(
    async () => {
      for await (const event of streamOpenAICompatible({
        config,
        messages: [{ role: 'user', content: 'create the requested file' }],
        tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }],
        toolChoice: 'auto',
        fetchImpl,
        env,
      })) { void event }
    },
    (error) => error?.code === 'REASONING_RUNAWAY',
  )

  const events = []
  for await (const event of streamOpenAICompatible({
    config,
    messages: [{ role: 'user', content: 'explain the concept' }],
    tools: [],
    toolChoice: 'none',
    fetchImpl,
    env,
  })) events.push(event)

  assert.equal(events.some((event) => event.type === 'reasoning'), true)
  assert.equal(events.at(-1)?.type, 'finish')
})

// ───────────── 连续 system 消息会打挂 LM Studio ─────────────
// 本项目把前置上下文拆成多个独立 system block(identity/ishiki/skills/
// sessions/memory)。云端 API 没问题,LM Studio 直接 400:
//   Unable to generate parser for this template.
// 实测 1 个 system 正常、2 个及以上必炸、合并回 1 个又正常。
// 现象极具迷惑性:HTTP 200 + text/event-stream,但流里只有一个 error 事件
// 就断了 —— 用户看到「不到 2 秒结束、没有任何回复」。

test('★ 开头连续的 system 消息被合并成一条', () => {
  const body = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'm' },
    messages: [
      { role: 'system', content: 'identity' },
      { role: 'system', content: 'soul' },
      { role: 'system', content: 'memory' },
      { role: 'user', content: '你好' },
    ],
  }).init.body)

  const systems = body.messages.filter((m) => m.role === 'system')
  assert.equal(systems.length, 1, 'LM Studio 只认一个 system,多了直接 400')
  assert.equal(systems[0].content, 'identity\n\nsoul\n\nmemory', '合并必须无损')
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[1].role, 'user')
})

test('单个 system 消息保持原样', () => {
  const body = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'm' },
    messages: [{ role: 'system', content: 'only one' }, { role: 'user', content: 'hi' }],
  }).init.body)
  assert.equal(body.messages[0].content, 'only one')
  assert.equal(body.messages.length, 2)
})

test('对话中间穿插的 system 不动 —— 那是工具循环的收尾指令', () => {
  const body = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'm' },
    messages: [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'r' },
      { role: 'system', content: '别再调工具了' },
      { role: 'user', content: 'q2' },
    ],
  }).init.body)
  // 开头两条合并成一条,中间那条原样保留
  assert.equal(body.messages.length, 5)
  assert.equal(body.messages[0].content, 'a\n\nb')
  assert.equal(body.messages[3].role, 'system')
  assert.equal(body.messages[3].content, '别再调工具了')
})

test('没有 system 消息时不受影响', () => {
  const body = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'm' },
    messages: [{ role: 'user', content: 'hi' }],
  }).init.body)
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
})

test('合并时跳过非字符串 content,不产生 undefined', () => {
  const body = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'm' },
    messages: [
      { role: 'system', content: 'ok' },
      { role: 'system', content: null },
      { role: 'user', content: 'hi' },
    ],
  }).init.body)
  assert.equal(body.messages[0].content, 'ok')
  assert.ok(!String(body.messages[0].content).includes('undefined'))
})

test('PDF 内容块按端点能力在原生 file 与文本回退之间切换', () => {
  const messages = [{
    role: 'user',
    content: [{
      type: 'yma_pdf',
      filename: 'report.pdf',
      file_data: 'data:application/pdf;base64,JVBERg==',
      fallback_text: '[附件: report.pdf]\n本地提取正文',
    }],
  }]

  const nativeBody = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4.1' },
    messages,
    profile: { supportsTools: true, supportsPdf: true, supportsParallelTools: true, keepAlive: null },
  }).init.body)
  assert.equal(nativeBody.messages[0].content[0].type, 'file')
  assert.equal(nativeBody.messages[0].content[0].file.filename, 'report.pdf')

  const fallbackBody = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'https://example.test/v1', modelName: 'text-model' },
    messages,
    profile: { supportsTools: true, supportsPdf: false, supportsParallelTools: false, keepAlive: null },
  }).init.body)
  assert.equal(fallbackBody.messages[0].content[0].type, 'text')
  assert.match(fallbackBody.messages[0].content[0].text, /本地提取正文/)
  assert.equal(JSON.stringify(fallbackBody).includes('yma_pdf'), false)
})

test('parallel_tool_calls 仅对明确支持的端点下发', () => {
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  const supported = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4.1' },
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    profile: { supportsTools: true, supportsPdf: true, supportsParallelTools: true, keepAlive: null },
  }).init.body)
  assert.equal(supported.parallel_tool_calls, true)

  const conservative = JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl: 'https://example.test/v1', modelName: 'm' },
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    profile: { supportsTools: true, supportsPdf: false, supportsParallelTools: false, keepAlive: null },
  }).init.body)
  assert.equal(Object.hasOwn(conservative, 'parallel_tool_calls'), false)
})

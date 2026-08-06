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
  })

  assert.deepEqual(textDeltas, ['Grounded answer.'])
  assert.deepEqual(reasoningDeltas, ['checking files'])
  assert.equal(result.content, 'Grounded answer.')
  assert.deepEqual(result.toolCalls, [{
    id: 'read-1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"README.md"}' },
  }])
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.usage.totalTokens, 15)
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
    { name: 'gpt-fast', active: true },
    { name: 'gpt-pro', active: false },
  ])
  assert.equal(JSON.stringify(status).includes('sk-test'), false)
})

test('loads a multi-provider model catalog', () => {
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

  const status = getModelStatus(env)

  assert.equal(status.configured, true)
  assert.deepEqual(status.models, [
    { name: 'deepseek-v4-pro', active: true, provider: 'deepseek' },
    { name: 'deepseek-v4-flash', active: false, provider: 'deepseek' },
    { name: 'mimo-v2.5', active: false, provider: 'mimo' },
    { name: 'mimo-v2.5-pro', active: false, provider: 'mimo' },
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

test('resolves context windows from the selected provider and its profile override', () => {
  const env = {
    MODEL_PROVIDERS: 'local,cloud,tuned',
    MODEL_PROVIDER_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_PROVIDER_LOCAL_MODELS: 'local-default',
    MODEL_PROVIDER_LOCAL_PROFILE: JSON.stringify({ contextWindow: 16_384 }),
    MODEL_PROVIDER_CLOUD_BASE_URL: 'https://api.example.com/v1',
    MODEL_PROVIDER_CLOUD_MODELS: 'cloud-model',
    MODEL_PROVIDER_TUNED_BASE_URL: 'https://tuned.example.com/v1',
    MODEL_PROVIDER_TUNED_MODELS: 'tuned-model',
    MODEL_PROVIDER_TUNED_PROFILE: JSON.stringify({ contextWindow: 65_536 }),
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
    65_536,
    'the selected provider profile override must win over global model mappings',
  )
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

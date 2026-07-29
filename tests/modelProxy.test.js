import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOpenAICompatibleRequest,
  extractUsage,
  formatProxyError,
  getModelStatus,
  getSystemDiagnostics,
  getToolMaxRounds,
  getUsageStats,
  loadModelConfig,
  normalizeOpenAICompatibleUrl,
  parseOpenAICompatibleResponse,
  recordUsage,
  resetUsageStats,
  resolveModelConfigForModel,
  supportsStreamUsage,
} from '../server/adapters/modelProxy.js'

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
    MODEL_PRICE_MULTIPLIERS: 'gpt-fast:1,gpt-pro:3',
  })

  assert.equal(status.configured, true)
  assert.deepEqual(status.models, [
    { name: 'gpt-fast', multiplier: 1, active: true },
    { name: 'gpt-pro', multiplier: 3, active: false },
  ])
  assert.equal(JSON.stringify(status).includes('sk-test'), false)
})

test('loads a multi-provider model catalog with per-model multipliers', () => {
  const env = {
    MODEL_PROVIDERS: 'deepseek,mimo',
    MODEL_PROVIDER_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    MODEL_PROVIDER_DEEPSEEK_API_KEY: 'sk-deepseek',
    MODEL_PROVIDER_DEEPSEEK_MODELS: 'deepseek-v4-pro,deepseek-v4-flash',
    MODEL_PROVIDER_MIMO_BASE_URL: 'https://api.xiaomimimo.com/v1',
    MODEL_PROVIDER_MIMO_API_KEY: 'sk-mimo',
    MODEL_PROVIDER_MIMO_MODELS: 'mimo-v2.5,mimo-v2.5-pro',
    MODEL_NAME: 'deepseek-v4-pro',
    MODEL_PRICE_MULTIPLIERS: 'deepseek-v4-pro:3,deepseek-v4-flash:0.6,mimo-v2.5:1,mimo-v2.5-pro:3',
  }

  const status = getModelStatus(env)

  assert.equal(status.configured, true)
  assert.deepEqual(status.models, [
    { name: 'deepseek-v4-pro', multiplier: 3, active: true, provider: 'deepseek' },
    { name: 'deepseek-v4-flash', multiplier: 0.6, active: false, provider: 'deepseek' },
    { name: 'mimo-v2.5', multiplier: 1, active: false, provider: 'mimo' },
    { name: 'mimo-v2.5-pro', multiplier: 3, active: false, provider: 'mimo' },
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
    maxTokens: 4096,
  })

  assert.deepEqual(resolveModelConfigForModel({ modelName: 'deepseek-v4-flash', env }), {
    configured: true,
    missing: [],
    baseUrl: 'https://api.deepseek.com',
    modelName: 'deepseek-v4-flash',
    apiKey: 'sk-deepseek',
    temperature: 0.7,
    maxTokens: 4096,
  })
})

test('system diagnostics summarize model, billing, and mail without secrets', async () => {
  const diagnostics = await getSystemDiagnostics({
    env: {
      MODEL_BASE_URL: 'https://api.example.com/v1',
      MODEL_NAME: 'gpt-fast',
      MODEL_NAMES: 'gpt-fast,gpt-pro',
      MODEL_API_KEY: 'sk-secret-value',
      MODEL_PRICE_MULTIPLIERS: 'gpt-fast:1,gpt-pro:3',
      CREDIT_BASE_PER_1K_TOKENS: '12',
      MODEL_MAX_TOKENS: '2048',
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
  assert.equal(diagnostics.billing.basePer1k, 12)
  assert.equal(diagnostics.billing.multipliers['gpt-pro'], 3)
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

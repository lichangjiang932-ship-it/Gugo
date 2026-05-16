import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOpenAICompatibleRequest,
  formatProxyError,
  getModelStatus,
  getSystemDiagnostics,
  loadModelConfig,
  normalizeOpenAICompatibleUrl,
  parseOpenAICompatibleResponse,
} from '../server/modelProxy.js'

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
  assert.deepEqual(missing.missing, ['MODEL_NAME', 'MODEL_API_KEY'])
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
      toolMaxRounds: 5,
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
})

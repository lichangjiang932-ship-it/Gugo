import test from 'node:test'
import assert from 'node:assert/strict'

import {
  discoverOllamaEndpoint,
  extractContextLength,
  extractSupportsTools,
  extractSupportsVision,
  listOllamaModels,
  looksLikeOllama,
  ollamaOrigin,
  probeOllamaModel,
} from '../server/adapters/ollamaNative.js'

test('各种形态的 Base URL 都能剥成 origin', () => {
  const cases = [
    'http://localhost:11434',
    'http://localhost:11434/',
    'http://localhost:11434/v1',
    'http://localhost:11434/v1/',
    'http://localhost:11434/v1/chat/completions',
  ]
  for (const url of cases) {
    assert.equal(ollamaOrigin(url), 'http://localhost:11434', url)
  }
  assert.equal(ollamaOrigin('不是URL'), '')
  assert.equal(ollamaOrigin(''), '')
})

test('只对本地端点认 Ollama —— 不把探测请求打到公网', () => {
  assert.equal(looksLikeOllama('http://localhost:11434'), true)
  assert.equal(looksLikeOllama('http://192.168.1.5:11434/v1'), true)
  assert.equal(looksLikeOllama('http://ollama.local:8080'), true)
  // 公网地址即便端口对也不认
  assert.equal(looksLikeOllama('http://8.8.8.8:11434'), false)
  assert.equal(looksLikeOllama('https://api.deepseek.com'), false)
  // 本地但端口不对、名字也不带 ollama
  assert.equal(looksLikeOllama('http://localhost:1234/v1'), false)
})

test('context_length 按后缀匹配 —— 键名带家族前缀,不能写死', () => {
  assert.equal(extractContextLength({ model_info: { 'llama.context_length': 8192 } }), 8192)
  assert.equal(extractContextLength({ model_info: { 'qwen2.context_length': 32768 } }), 32768)
  assert.equal(extractContextLength({ model_info: { 'gemma2.context_length': 4096 } }), 4096)
  // 混着一堆无关键
  assert.equal(extractContextLength({
    model_info: {
      'general.architecture': 'llama',
      'llama.embedding_length': 4096,
      'llama.context_length': 131072,
    },
  }), 131072)
  assert.equal(extractContextLength({ model_info: {} }), null)
  assert.equal(extractContextLength({}), null)
  assert.equal(extractContextLength(null), null)
})

test('工具支持:优先看 capabilities,回落看 template 里有没有 .Tools', () => {
  assert.equal(extractSupportsTools({ capabilities: ['completion', 'tools'] }), true)
  assert.equal(extractSupportsTools({ capabilities: ['completion'] }), false)
  assert.equal(extractSupportsTools({ template: '{{ if .Tools }}...{{ end }}' }), true)
  assert.equal(extractSupportsTools({ template: '{{ .Prompt }}' }), false)
  // 什么都没有 = 不知道,交给 endpointProfile 按 kind 推断
  assert.equal(extractSupportsTools({}), null)
})

test('视觉支持', () => {
  assert.equal(extractSupportsVision({ capabilities: ['completion', 'vision'] }), true)
  assert.equal(extractSupportsVision({ capabilities: ['completion'] }), false)
  assert.equal(extractSupportsVision({ details: { families: ['llama', 'clip'] } }), true)
  assert.equal(extractSupportsVision({ details: { families: ['llama'] } }), false)
  assert.equal(extractSupportsVision({}), null)
})

function fakeFetch(routes) {
  return async (url, init) => {
    const path = new URL(url).pathname
    const handler = routes[path]
    if (!handler) {
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' }
    }
    const body = init?.body ? JSON.parse(init.body) : null
    const data = typeof handler === 'function' ? handler(body) : handler
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  }
}

test('/api/tags 列出本地模型,带上量化和参数量', async () => {
  const models = await listOllamaModels({
    baseUrl: 'http://localhost:11434/v1',
    fetchImpl: fakeFetch({
      '/api/tags': {
        models: [
          {
            name: 'qwen2.5:7b',
            size: 4683087332,
            details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
          },
          { name: 'llama3.1:8b', size: 4920753328, details: { family: 'llama' } },
        ],
      },
    }),
  })
  assert.equal(models.length, 2)
  assert.equal(models[0].name, 'qwen2.5:7b')
  assert.equal(models[0].parameterSize, '7.6B')
  assert.equal(models[0].quantization, 'Q4_K_M')
  assert.equal(models[1].family, 'llama')
})

test('/api/show 自动探出真实上下文窗口 —— 用户不用再猜', async () => {
  const profile = await probeOllamaModel({
    baseUrl: 'http://localhost:11434',
    modelName: 'qwen2.5:7b',
    fetchImpl: fakeFetch({
      '/api/show': {
        capabilities: ['completion', 'tools'],
        model_info: { 'qwen2.context_length': 32768 },
      },
    }),
  })
  assert.equal(profile.contextWindow, 32768)
  assert.equal(profile.supportsTools, true)
})

test('discoverOllamaEndpoint 一次拿到模型列表 + 目标模型能力', async () => {
  const result = await discoverOllamaEndpoint({
    baseUrl: 'http://localhost:11434/v1',
    modelName: 'qwen2.5:7b',
    fetchImpl: fakeFetch({
      '/api/tags': { models: [{ name: 'qwen2.5:7b' }] },
      '/api/show': { capabilities: ['tools'], model_info: { 'qwen2.context_length': 32768 } },
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.models.length, 1)
  assert.equal(result.profile.contextWindow, 32768)
})

test('端点没起时不抛异常,回报错误让上层显示', async () => {
  const result = await discoverOllamaEndpoint({
    baseUrl: 'http://localhost:11434',
    fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /fetch failed/)
})

test('/api/show 失败不影响已经拿到的模型列表', async () => {
  const result = await discoverOllamaEndpoint({
    baseUrl: 'http://localhost:11434',
    modelName: 'qwen2.5:7b',
    fetchImpl: fakeFetch({ '/api/tags': { models: [{ name: 'qwen2.5:7b' }] } }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.models.length, 1)
  assert.equal(result.profile, null)
})

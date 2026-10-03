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
import { DEFAULT_LOCAL_CONTEXT_WINDOW, resolveEndpointProfile } from '../server/utils/endpointProfile.js'

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

test('/api/show 的 num_ctx 配置优先于模型训练上下文上限', async () => {
  const profile = await probeOllamaModel({
    baseUrl: 'http://localhost:11434',
    modelName: 'qwen2.5:7b',
    fetchImpl: fakeFetch({
      '/api/show': {
        capabilities: ['completion', 'tools'],
        model_info: { 'qwen2.context_length': 131072 },
        parameters: { num_ctx: 4096 },
      },
    }),
  })
  assert.equal(profile.contextWindow, 4096)
  assert.equal(profile.supportsTools, true)
})

test('/api/show 的文本 parameters 只读取独立 num_ctx 参数行', async () => {
  const profile = await probeOllamaModel({
    baseUrl: 'http://localhost:11434',
    modelName: 'qwen2.5:7b',
    fetchImpl: fakeFetch({
      '/api/show': {
        parameters: 'stop "num_ctx 65536"\nnum_predict 8192\nnum_ctx                        2048\ntemperature 0.8',
        model_info: { 'qwen2.context_length': 131072 },
      },
    }),
  })
  assert.equal(profile.contextWindow, 2048)
})

test('/api/ps 当前模型的运行窗口优先于 num_ctx 和训练元数据', async () => {
  const requests = []
  const fetchImpl = fakeFetch({
    '/api/show': {
      capabilities: ['tools', 'vision'],
      parameters: { num_ctx: 2048 },
      model_info: { 'qwen2.context_length': 32768 },
    },
    '/api/ps': {
      models: [
        { name: 'other:latest', context_length: 131072 },
        { name: 'qwen2.5:7b', context_length: 65536 },
      ],
    },
  })
  const profile = await probeOllamaModel({
    baseUrl: 'http://localhost:11434', modelName: 'qwen2.5:7b',
    fetchImpl: async (url, init) => {
      requests.push({ path: new URL(url).pathname, method: init.method, body: init.body })
      return fetchImpl(url, init)
    },
  })
  assert.equal(profile.contextWindow, 65536, '真实运行值不是训练上限，也不能被训练上限隐式截断')
  assert.equal(profile.source, 'ollama-api-ps')
  assert.equal(profile.supportsTools, true)
  assert.equal(profile.supportsVision, true)
  assert.deepEqual(requests.map(({ path }) => path).sort(), ['/api/ps', '/api/show'])
  assert.equal(requests.find(({ path }) => path === '/api/ps').method, 'GET')
  assert.deepEqual(JSON.parse(requests.find(({ path }) => path === '/api/show').body), { model: 'qwen2.5:7b' })
})

test('/api/ps 只接受精确模型和默认 latest 等价名，不跨 tag 或命名空间', async () => {
  const cases = [
    { modelName: 'qwen', models: [{ name: 'qwen:latest', context_length: 4096 }], expected: 4096 },
    { modelName: 'qwen:latest', models: [{ model: 'qwen', context_length: '4096' }], expected: 4096 },
    { modelName: 'team/qwen', models: [{ name: 'qwen:latest', context_length: 65536 }], expected: 2048 },
    { modelName: 'qwen:7b', models: [{ name: 'qwen:latest', context_length: 65536 }], expected: 2048 },
    { modelName: 'qwen', models: [{ name: 'qwen:7b', context_length: 65536 }], expected: 2048 },
    { modelName: 'qwen', models: [{ name: 'alias:latest', digest: 'qwen', context_length: 65536 }], expected: 2048 },
    {
      modelName: 'qwen',
      models: [{ name: 'qwen:latest', context_length: 65536 }, { name: 'qwen', context_length: 4096 }],
      expected: 4096,
    },
    {
      modelName: 'qwen:7b',
      models: [{ name: 'qwen:7b', context_length: 65536 }, { name: 'qwen:7b', context_length: 4096 }],
      expected: 4096,
    },
    {
      modelName: 'registry.local:5000/team/qwen',
      models: [{ name: 'registry.local:5000/team/qwen:latest', context_length: 4096 }],
      expected: 4096,
    },
  ]
  for (const { modelName, models, expected } of cases) {
    const profile = await probeOllamaModel({
      baseUrl: 'http://localhost:11434', modelName,
      fetchImpl: fakeFetch({
        '/api/show': { parameters: { num_ctx: 2048 } },
        '/api/ps': { models },
      }),
    })
    assert.equal(profile.contextWindow, expected, JSON.stringify({ modelName, models }))
  }
})

test('只有训练元数据时保持窗口未知，endpointProfile 使用保守或显式配置 fallback', async () => {
  const baseUrl = 'http://localhost:11434'
  const modelName = 'local-test:latest'
  const detected = await probeOllamaModel({
    baseUrl, modelName,
    fetchImpl: fakeFetch({
      '/api/show': { capabilities: ['tools'], model_info: { 'llama.context_length': 1048576 } },
      '/api/ps': { models: [{ name: 'other:latest', context_length: 262144 }] },
    }),
  })
  assert.equal(detected.contextWindow, null)
  assert.equal(detected.supportsTools, true)
  const modelProfiles = { [modelName]: detected }
  const inferred = resolveEndpointProfile({ baseUrl, modelName, modelProfiles, env: {} })
  assert.equal(inferred.contextWindow, DEFAULT_LOCAL_CONTEXT_WINDOW)
  assert.equal(inferred.contextWindowEstimated, true)
  assert.equal(inferred.contextWindowSource, 'local_default')
  const configured = resolveEndpointProfile({
    baseUrl, modelName, modelProfiles, env: {}, overrides: { contextWindow: 2048 },
  })
  assert.equal(configured.contextWindow, 2048)
  assert.equal(configured.contextWindowSource, 'provider_override')
})

test('无效 num_ctx 和运行 context_length 不会被强制转换成已知窗口', async () => {
  for (const value of [null, '', ' ', 0, -1, 0.5, true, [], {}, '8192tokens']) {
    const profile = await probeOllamaModel({
      baseUrl: 'http://localhost:11434', modelName: 'local-test',
      fetchImpl: fakeFetch({
        '/api/show': { parameters: { num_ctx: value }, model_info: { 'test.context_length': 131072 } },
        '/api/ps': { models: [{ name: 'local-test', context_length: value }] },
      }),
    })
    assert.equal(profile.contextWindow, null, `invalid window: ${JSON.stringify(value)}`)
  }
})

test('/api/ps 不可用时保留 num_ctx 和能力信息', async () => {
  for (const status of [401, 404, 500]) {
    const profile = await probeOllamaModel({
      baseUrl: 'http://localhost:11434', modelName: 'local-test',
      fetchImpl: async (url) => new URL(url).pathname === '/api/ps'
        ? { ok: false, status, text: async () => '{"error":"runtime metadata unavailable"}' }
        : { ok: true, status: 200, text: async () => JSON.stringify({
          parameters: { num_ctx: 4096 }, capabilities: ['tools', 'vision'],
        }) },
    })
    assert.equal(profile.contextWindow, 4096, `runtime HTTP ${status}`)
    assert.equal(profile.source, 'ollama-api-show')
    assert.equal(profile.supportsTools, true)
    assert.equal(profile.supportsVision, true)
  }
})

test('/api/ps 的重定向仍被出站策略拦截，不向其他 origin 发送凭据', async () => {
  const requests = []
  const profile = await probeOllamaModel({
    baseUrl: 'http://localhost:11434', modelName: 'local-test', apiKey: 'offline-fixture-key',
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, 'http://localhost:11434')
      assert.equal(init.redirect, 'manual')
      assert.equal(init.headers.Authorization, 'Bearer offline-fixture-key')
      requests.push(new URL(url).pathname)
      if (new URL(url).pathname === '/api/ps') {
        return new Response(null, { status: 307, headers: { location: 'https://other.example/api/ps' } })
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ parameters: { num_ctx: 4096 } }) }
    },
  })
  assert.deepEqual(requests.sort(), ['/api/ps', '/api/show'])
  assert.equal(profile.contextWindow, 4096)
})

test('Ollama 原生发现携带 Provider 凭据且自定义 Authorization 优先', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ path: new URL(url).pathname, headers: { ...init.headers } })
    const data = new URL(url).pathname === '/api/tags'
      ? { models: [{ name: 'secured-model' }] }
      : { capabilities: ['tools'], model_info: { 'secure.context_length': 8192 } }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  }

  const bearer = await discoverOllamaEndpoint({
    baseUrl: 'http://localhost:11434',
    modelName: 'secured-model',
    apiKey: 'saved-api-key',
    headers: { 'X-Org': 'local-user' },
    fetchImpl,
  })
  assert.equal(bearer.ok, true)
  assert.deepEqual(requests.map(({ path }) => path).sort(), ['/api/ps', '/api/show', '/api/tags'])
  for (const request of requests) {
    assert.equal(request.headers.Authorization, 'Bearer saved-api-key')
    assert.equal(request.headers['X-Org'], 'local-user')
  }

  requests.length = 0
  await discoverOllamaEndpoint({
    baseUrl: 'http://localhost:11434',
    apiKey: 'ignored-api-key',
    headers: { authorization: 'Basic custom-secret' },
    fetchImpl,
  })
  assert.deepEqual(requests.map(({ path }) => path).sort(), ['/api/ps', '/api/show', '/api/tags'])
  for (const request of requests) {
    assert.equal(request.headers.authorization, 'Basic custom-secret')
    assert.equal(Object.hasOwn(request.headers, 'Authorization'), false)
  }
})

test('Ollama 原生请求禁止自动跟随到 metadata 地址', async () => {
  let fetchCalls = 0
  await assert.rejects(
    listOllamaModels({
      baseUrl: 'http://localhost:11434',
      fetchImpl: async (_url, init) => {
        fetchCalls += 1
        assert.equal(init.redirect, 'manual')
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        })
      },
    }),
    (error) => error?.code === 'OUTBOUND_REDIRECT_CROSS_ORIGIN',
  )
  assert.equal(fetchCalls, 1)
})

test('Ollama 原生请求拒绝跨域重定向且不向新域发送凭据', async () => {
  const requests = []
  await assert.rejects(
    listOllamaModels({
      baseUrl: 'http://localhost:11434',
      apiKey: 'local-ollama-secret',
      fetchImpl: async (url, init) => {
        requests.push({ url, authorization: init.headers.Authorization })
        return new Response(null, {
          status: 307,
          headers: { location: 'https://other.example/api/tags' },
        })
      },
    }),
    (error) => error?.code === 'OUTBOUND_REDIRECT_CROSS_ORIGIN',
  )
  assert.deepEqual(requests, [{
    url: 'http://localhost:11434/api/tags',
    authorization: 'Bearer local-ollama-secret',
  }])
})

test('discoverOllamaEndpoint 一次拿到模型列表 + 目标模型能力', async () => {
  const result = await discoverOllamaEndpoint({
    baseUrl: 'http://localhost:11434/v1',
    modelName: 'qwen2.5:7b',
    fetchImpl: fakeFetch({
      '/api/tags': { models: [{ name: 'qwen2.5:7b' }] },
      '/api/show': {
        capabilities: ['tools'], parameters: 'num_ctx 32768',
        model_info: { 'qwen2.context_length': 131072 },
      },
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

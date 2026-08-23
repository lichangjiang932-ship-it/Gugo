import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOpenAICompatibleRequest,
  isProviderFailoverError,
  modelTimeoutError,
  resolveModelFailoverConfigs,
  streamOpenAICompatible,
  supportsVisionModel,
} from '../server/adapters/modelProxy.js'

/**
 * 造一个可控节奏的假流式响应。
 *
 * chunks 里每一项是 [延迟毫秒, 文本]。用它来模拟:
 *   - 首 token 很慢但之后正常(本地模型加载权重)
 *   - 吐字很慢但持续(CPU 推理)
 *   - 中途彻底卡死(连接失效)
 */
function makeFakeStreamFetch(chunks, { status = 200 } = {}) {
  return async (url, init) => {
    if (status !== 200) {
      return {
        ok: false,
        status,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: { message: 'upstream said no' } }),
      }
    }
    let index = 0
    const encoder = new TextEncoder()
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined }
            const [delayMs, text] = chunks[index]
            index += 1
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, delayMs)
              // 尊重 abort,否则超时测试会一直挂着
              const signal = init?.signal
              if (signal) {
                if (signal.aborted) {
                  clearTimeout(timer)
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                  return
                }
                signal.addEventListener('abort', () => {
                  clearTimeout(timer)
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                }, { once: true })
              }
            })
            return { done: false, value: encoder.encode(text) }
          },
        }),
      },
    }
  }
}

const LOCAL_CONFIG = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  modelName: 'qwen2.5',
  temperature: 0.7,
  maxTokens: 512,
}

function sseChunk(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

test('吐字慢但持续 —— 绝不能被超时砍断(原 120s 整请求超时的核心缺陷)', async () => {
  // 6 个 chunk,每个间隔 120ms,总耗时 ~720ms。
  // 把 idle 设成 400ms:每个间隔都在 idle 窗口内,所以全程不该超时。
  // 如果实现用的是「整请求超时」,把整体上限设成 500ms 就会砍断 —— 这里用
  // firstTokenMs 400ms 同时验证首 token 计时器在收到数据后确实被清掉了。
  const chunks = Array.from({ length: 6 }, () => [120, sseChunk('字')])
  const events = []
  for await (const event of streamOpenAICompatible({
    config: LOCAL_CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: makeFakeStreamFetch(chunks),
    env: { MODEL_FIRST_TOKEN_TIMEOUT_MS: '400', MODEL_IDLE_TIMEOUT_MS: '400' },
  })) {
    if (event.type === 'text') events.push(event.delta)
  }
  assert.equal(events.length, 6, '慢速但持续的流必须完整收完')
  assert.equal(events.join(''), '字字字字字字')
})

test('首 token 慢但在窗口内 —— 不该超时', async () => {
  const chunks = [[300, sseChunk('终于')], [10, sseChunk('来了')]]
  const events = []
  for await (const event of streamOpenAICompatible({
    config: LOCAL_CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: makeFakeStreamFetch(chunks),
    env: { MODEL_FIRST_TOKEN_TIMEOUT_MS: '2000', MODEL_IDLE_TIMEOUT_MS: '2000' },
  })) {
    if (event.type === 'text') events.push(event.delta)
  }
  assert.equal(events.join(''), '终于来了')
})

test('首 token 超出窗口 → 抛 MODEL_TIMEOUT,且**不带 status**', async () => {
  const chunks = [[5000, sseChunk('太慢了')]]
  await assert.rejects(
    async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _event of streamOpenAICompatible({
        config: LOCAL_CONFIG,
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: makeFakeStreamFetch(chunks),
        env: { MODEL_FIRST_TOKEN_TIMEOUT_MS: '150', MODEL_IDLE_TIMEOUT_MS: '150' },
      })) { /* 不该有任何事件 */ }
    },
    (error) => {
      assert.equal(error.code, 'MODEL_TIMEOUT')
      assert.equal(error.timeoutPhase, 'first_token')
      // ★ 关键断言:超时绝不能伪装成 504,否则会触发 failover(静默切云端 + 扣钱)
      assert.equal(error.status, undefined, '超时错误不得带 status')
      return true
    },
  )
})

test('流中途卡死超过 idle 窗口 → 判定连接失效', async () => {
  const chunks = [[10, sseChunk('开头')], [5000, sseChunk('永远不来')]]
  const received = []
  await assert.rejects(
    async () => {
      for await (const event of streamOpenAICompatible({
        config: LOCAL_CONFIG,
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: makeFakeStreamFetch(chunks),
        env: { MODEL_FIRST_TOKEN_TIMEOUT_MS: '3000', MODEL_IDLE_TIMEOUT_MS: '150' },
      })) {
        if (event.type === 'text') received.push(event.delta)
      }
    },
    (error) => {
      assert.equal(error.code, 'MODEL_TIMEOUT')
      assert.equal(error.timeoutPhase, 'idle')
      return true
    },
  )
  // 卡死之前已经吐出来的内容仍然应该被消费到
  assert.deepEqual(received, ['开头'])
})

test('onFirstByte 在收到首个 chunk 时触发一次 —— 前端据此结束「模型加载中」', async () => {
  let fired = 0
  const chunks = [[10, sseChunk('a')], [10, sseChunk('b')], [10, sseChunk('c')]]
  const stream = streamOpenAICompatible({
    config: LOCAL_CONFIG,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: makeFakeStreamFetch(chunks),
    env: {},
    onFirstByte: () => { fired += 1 },
  })
  for await (const event of stream) {
    assert.ok(event.type)
  }
  assert.equal(fired, 1, 'onFirstByte 只该触发一次')
})

test('上游 4xx 带 fromUpstream 标记,便于区分「上游拒绝」和「我们超时」', async () => {
  await assert.rejects(
    async () => {
      const stream = streamOpenAICompatible({
        config: LOCAL_CONFIG,
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: makeFakeStreamFetch([], { status: 400 }),
        env: {},
      })
      for await (const event of stream) {
        assert.ok(event)
      }
    },
    (error) => {
      assert.equal(error.status, 400)
      assert.equal(error.fromUpstream, true)
      return true
    },
  )
})

test('MODEL_TIMEOUT 不触发 provider failover', () => {
  assert.equal(isProviderFailoverError(modelTimeoutError('慢')), false)
  // 上游真的 5xx 仍然可以转移
  assert.equal(isProviderFailoverError({ status: 502 }), true)
  assert.equal(isProviderFailoverError({ status: 429 }), true)
  // 用户取消不转移
  assert.equal(isProviderFailoverError({ name: 'AbortError' }), false)
})

test('本地端点不返回云端备选 —— 不许「本地慢就偷偷切云端并扣钱」', () => {
  // 注意:一旦设了 MODEL_PROVIDERS,MODEL_BASE_URL 就完全不参与解析了
  // (loadModelConfig 的既有行为),所以本地端点也要作为一个 provider 配置。
  const env = {
    MODEL_NAME: 'qwen2.5',
    MODEL_PROVIDERS: 'local,cloud',
    MODEL_PROVIDER_LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_PROVIDER_LOCAL_MODELS: 'qwen2.5',
    MODEL_PROVIDER_CLOUD_BASE_URL: 'https://api.deepseek.com',
    MODEL_PROVIDER_CLOUD_MODELS: 'deepseek-chat',
    MODEL_PROVIDER_CLOUD_API_KEY: 'sk-test',
  }
  const configs = resolveModelFailoverConfigs({ modelName: 'qwen2.5', env })
  assert.equal(configs.length, 1, '本地主 provider 时不该有任何备选')
  assert.ok(configs[0].baseUrl.includes('127.0.0.1'))
})

test('云端主 provider 只有显式授权才保留同名模型备选', () => {
  const env = {
    MODEL_NAME: 'deepseek-chat',
    // 两个 provider 都提供同名模型(镜像 / 中转站场景)
    MODEL_PROVIDERS: 'main,backup',
    MODEL_PROVIDER_MAIN_BASE_URL: 'https://api.deepseek.com',
    MODEL_PROVIDER_MAIN_MODELS: 'deepseek-chat',
    MODEL_PROVIDER_MAIN_API_KEY: 'sk-main',
    // ★ 备用 provider 必须提供**同名**模型才算合格备选。
    // 以前这里写的是 moonshot-v1-8k(不同模型),照样被当成备选 ——
    // 那正是「选了 deepseek-v4-flash 却按 mimo-v2.5 计费」的成因。
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://api.moonshot.cn/v1',
    MODEL_PROVIDER_BACKUP_MODELS: 'deepseek-chat',
    MODEL_PROVIDER_BACKUP_API_KEY: 'sk-backup',
  }
  assert.equal(resolveModelFailoverConfigs({ modelName: 'deepseek-chat', env }).length, 1)
  const configs = resolveModelFailoverConfigs({
    modelName: 'deepseek-chat',
    env: { ...env, MODEL_FAILOVER_CROSS_PROVIDER: '1' },
  })
  assert.ok(configs.length >= 2, '云端应保留同名模型的备选 provider')
  for (const config of configs) {
    assert.equal(config.modelName, 'deepseek-chat', '转移后模型名必须一致')
  }
})

test('★ 备用 provider 没有同名模型时不作为备选 —— 不能偷偷换模型计费', () => {
  const env = {
    MODEL_BASE_URL: 'https://api.deepseek.com',
    MODEL_NAME: 'deepseek-chat',
    MODEL_PROVIDERS: 'backup',
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://api.moonshot.cn/v1',
    MODEL_PROVIDER_BACKUP_MODELS: 'moonshot-v1-8k',
    MODEL_PROVIDER_BACKUP_API_KEY: 'sk-test',
  }
  const configs = resolveModelFailoverConfigs({ modelName: 'deepseek-chat', env })
  assert.deepEqual(
    configs.map((c) => c.modelName),
    ['deepseek-chat'],
    '不该把 moonshot-v1-8k 当成 deepseek-chat 的备选',
  )
})

test('不支持工具的端点对工具轮返回结构化配置错误，不再静默退化成无工具回答', () => {
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }]
  const messages = [{ role: 'user', content: 'hi' }]

  // llama.cpp 默认不声明支持 tools
  assert.throws(
    () => buildOpenAICompatibleRequest({
      config: { baseUrl: 'http://127.0.0.1:8080/v1', modelName: 'local' },
      messages,
      tools,
      env: {},
    }),
    (error) => {
      assert.equal(error?.code, 'MODEL_TOOLS_UNSUPPORTED')
      assert.equal(error?.type, 'configuration_error')
      assert.equal(error?.retryable, false)
      return true
    },
  )

  // Ollama 支持
  const ollama = buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:11434/v1', modelName: 'qwen2.5' },
    messages,
    tools,
    env: {},
  })
  assert.equal(JSON.parse(ollama.init.body).tools.length, 1)
})

test('Ollama 请求带 keep_alive —— 避免每次都重新加载权重', () => {
  const ollama = buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:11434/v1', modelName: 'qwen2.5' },
    messages: [{ role: 'user', content: 'hi' }],
    env: {},
  })
  assert.equal(JSON.parse(ollama.init.body).keep_alive, '30m')

  // 非 Ollama 端点不该带这个字段(有些实现见到未知字段直接 400)
  const cloud = buildOpenAICompatibleRequest({
    config: { baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-chat' },
    messages: [{ role: 'user', content: 'hi' }],
    env: {},
  })
  assert.equal(JSON.parse(cloud.init.body).keep_alive, undefined)
})

test('多个前置 system 合并成一个 —— LM Studio 见到 2 个 system 直接 400', () => {
  const req = buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'local' },
    messages: [
      { role: 'system', content: '身份块' },
      { role: 'system', content: '技能块' },
      { role: 'system', content: '记忆块' },
      { role: 'user', content: '你好' },
    ],
    env: {},
  })
  const sent = JSON.parse(req.init.body).messages
  assert.equal(sent.filter((m) => m.role === 'system').length, 1)
  assert.equal(sent[0].content, '身份块\n\n技能块\n\n记忆块')
})

test('数组形式的 system content 不再被静默丢掉', () => {
  const req = buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'local' },
    messages: [
      { role: 'system', content: '第一段' },
      { role: 'system', content: [{ type: 'text', text: '数组里的指令' }] },
      { role: 'user', content: '你好' },
    ],
    env: {},
  })
  const sent = JSON.parse(req.init.body).messages
  // ★ 原实现会把数组那条变成 '' 然后 filter 掉 —— 指令凭空消失且无任何报错
  assert.match(sent[0].content, /数组里的指令/)
  assert.match(sent[0].content, /第一段/)
})

test('中间穿插的 system 不动 —— 只合并开头连续那一段', () => {
  const req = buildOpenAICompatibleRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'local' },
    messages: [
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: '问' },
      { role: 'system', content: '收尾指令' },
    ],
    env: {},
  })
  const sent = JSON.parse(req.init.body).messages
  assert.equal(sent.length, 3)
  assert.equal(sent[0].content, 'A\n\nB')
  assert.equal(sent[2].content, '收尾指令')
})

test('本地端点默认不认为支持视觉 —— 别把图喂给纯文本本地模型', () => {
  assert.equal(supportsVisionModel('qwen2.5', {}, 'http://127.0.0.1:11434/v1'), false)
  // 云端保持原来的 allow-all 行为,不改变已有部署
  assert.equal(supportsVisionModel('gpt-4o', {}, 'https://api.openai.com/v1'), true)
  // 显式列进白名单就认
  assert.equal(
    supportsVisionModel('llava', { MODEL_NAMES_VISION: 'llava' }, 'http://127.0.0.1:11434/v1'),
    true,
  )
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CLOUD_CONTEXT_WINDOW,
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  inferEndpointKind,
  isLocalEndpoint,
  resolveEndpointProfile,
} from '../server/utils/endpointProfile.js'

test('kind 按端口推断', () => {
  assert.equal(inferEndpointKind('http://localhost:11434'), 'ollama')
  assert.equal(inferEndpointKind('http://127.0.0.1:1234/v1'), 'lmstudio')
  assert.equal(inferEndpointKind('http://localhost:8080/v1'), 'llamacpp')
  assert.equal(inferEndpointKind('http://localhost:8000/v1'), 'vllm')
  assert.equal(inferEndpointKind('https://api.deepseek.com'), 'openai-compatible')
})

test('kind 按主机名推断,端口不标准也能认出来', () => {
  assert.equal(inferEndpointKind('http://ollama.internal:9999'), 'ollama')
  assert.equal(inferEndpointKind('http://lmstudio.lan:7777/v1'), 'lmstudio')
  assert.equal(inferEndpointKind('http://vllm-prod:3000/v1'), 'vllm')
  assert.equal(inferEndpointKind('https://api.anthropic.com/v1'), 'anthropic')
  assert.equal(inferEndpointKind('https://generativelanguage.googleapis.com/v1beta'), 'gemini')
})

test('Anthropic 与 Gemini 原生端点声明完整多模态和工具能力', () => {
  for (const [baseUrl, kind] of [
    ['https://api.anthropic.com/v1', 'anthropic'],
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
  ]) {
    const profile = resolveEndpointProfile({ baseUrl, modelName: 'model', env: {} })
    assert.equal(profile.kind, kind)
    assert.equal(profile.supportsTools, true)
    assert.equal(profile.supportsStreaming, true)
    assert.equal(profile.supportsVision, true)
    assert.equal(profile.supportsPdf, true)
    assert.equal(profile.supportsParallelTools, true)
  }
})

test('非法 URL 不抛,回落 openai-compatible', () => {
  assert.equal(inferEndpointKind('not a url'), 'openai-compatible')
  assert.equal(inferEndpointKind(''), 'openai-compatible')
  assert.equal(inferEndpointKind(null), 'openai-compatible')
})

test('回环地址判为本地(保持原 LOCAL_HOSTS 行为)', () => {
  for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']) {
    assert.ok(isLocalEndpoint(`http://${host}:11434`), `${host} 应判为本地`)
  }
})

test('私网段判为本地 —— 局域网 / Docker / Tailscale 上的 Ollama 不该漏判', () => {
  const locals = [
    'http://192.168.1.50:11434',   // 家用局域网
    'http://10.0.0.7:11434',       // 企业内网
    'http://172.17.0.2:11434',     // Docker 默认网段
    'http://172.31.255.1:8000',    // 172.16/12 上界
    'http://100.101.102.103:11434', // Tailscale CGNAT
    'http://169.254.1.1:1234',     // 链路本地
    'http://gpu-box.local:11434',  // mDNS
    'http://ollama.lan:11434',
  ]
  for (const url of locals) {
    assert.ok(isLocalEndpoint(url), `${url} 应判为本地`)
  }
})

test('公网地址不判为本地 —— 172.15/172.32 是公网,别误判', () => {
  const remotes = [
    'https://api.deepseek.com',
    'https://api.openai.com/v1',
    'http://172.15.0.1:11434',
    'http://172.32.0.1:11434',
    'http://8.8.8.8:11434',
    'http://192.169.1.1:11434',
  ]
  for (const url of remotes) {
    assert.equal(isLocalEndpoint(url), false, `${url} 不该判为本地`)
  }
})

test('本地端点拿到慷慨超时,云端沿用原值', () => {
  const local = resolveEndpointProfile({ baseUrl: 'http://localhost:11434', env: {} })
  const cloud = resolveEndpointProfile({ baseUrl: 'https://api.deepseek.com', env: {} })

  // 首 token 慢是本地加载权重的正常现象,给 10 分钟
  assert.ok(local.timeouts.firstTokenMs >= 600_000)
  // 云端保持改造前的 120s / 60s,不改变已有行为
  assert.equal(cloud.timeouts.firstTokenMs, 120_000)
  assert.equal(cloud.timeouts.requestMs, 60_000)
  assert.equal(cloud.timeouts.probeMs, 8_000)
  // 本地探测也要更宽 —— Ollama 冷启动加载模型时 8s 必超时
  assert.ok(local.timeouts.probeMs > cloud.timeouts.probeMs)
  // 后台任务(job/subagent)原来完全没有超时,现在必须有一个有限值
  assert.ok(Number.isFinite(local.timeouts.backgroundMs) && local.timeouts.backgroundMs > 0)
})

test('上下文窗口:本地默认 8192 而不是 100 万', () => {
  const local = resolveEndpointProfile({ baseUrl: 'http://localhost:11434', env: {} })
  assert.equal(local.contextWindow, DEFAULT_LOCAL_CONTEXT_WINDOW)
  assert.equal(local.contextWindowSource, 'local_default')
  const cloud = resolveEndpointProfile({ baseUrl: 'https://api.deepseek.com', env: {} })
  assert.equal(cloud.contextWindow, DEFAULT_CLOUD_CONTEXT_WINDOW)
  assert.equal(cloud.contextWindowSource, 'cloud_default')
})

test('上下文窗口优先级:精确模型画像 > 按模型 env > provider 旧值 > 全局 > 默认', () => {
  const env = { MODEL_CONTEXT_WINDOW: '32000', MODEL_CONTEXT_WINDOWS: 'qwen2.5=16384' }

  // 全局
  const global = resolveEndpointProfile({ baseUrl: 'http://localhost:11434', modelName: 'other', env })
  assert.equal(global.contextWindow, 32000)
  assert.equal(global.contextWindowSource, 'global')

  // provider 旧值压过全局
  const provider = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    modelName: 'other',
    env,
    overrides: { contextWindow: 4096 },
  })
  assert.equal(provider.contextWindow, 4096)
  assert.equal(provider.contextWindowSource, 'provider_override')

  // 精确 env 映射压过 provider 旧值
  const mapped = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    modelName: 'qwen2.5',
    env,
    overrides: { contextWindow: 4096 },
  })
  assert.equal(mapped.contextWindow, 16384)
  assert.equal(mapped.contextWindowSource, 'model_context_windows')

  // 精确模型画像压过所有兼容配置
  const exact = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    modelName: 'qwen2.5',
    env,
    overrides: {
      contextWindow: 4096,
      models: {
        'qwen2.5': { contextWindow: 65536 },
        sibling: { contextWindow: 8192 },
      },
    },
  })
  assert.equal(exact.contextWindow, 65536)
  assert.equal(exact.contextWindowSource, 'model_profile')
})

test('模型画像只做精确匹配,并兼容顶层 modelProfiles', () => {
  const overrides = {
    models: { known: { contextWindow: 32768 } },
  }
  const unknown = resolveEndpointProfile({
    baseUrl: 'https://api.example.com/v1',
    modelName: 'unknown',
    env: {},
    overrides,
  })
  assert.equal(unknown.contextWindow, DEFAULT_CLOUD_CONTEXT_WINDOW)
  assert.equal(unknown.contextWindowSource, 'cloud_default')

  const compatible = resolveEndpointProfile({
    baseUrl: 'https://api.example.com/v1',
    modelName: 'known',
    env: { MODEL_CONTEXT_WINDOWS: 'known=16384' },
    modelProfiles: { known: { contextWindow: 65536 } },
  })
  assert.equal(compatible.contextWindow, 65536)
  assert.equal(compatible.contextWindowSource, 'model_profile')
})

test('上下文窗口接受小于 4096 的真实小窗口(原来被硬下限顶掉)', () => {
  const profile = resolveEndpointProfile({
    baseUrl: 'http://localhost:8080/v1',
    overrides: { contextWindow: 2048 },
    env: {},
  })
  assert.equal(profile.contextWindow, 2048)
  // 但仍有一个兜底下限,避免 0 / 负数把阈值算成 0
  const floored = resolveEndpointProfile({
    baseUrl: 'http://localhost:8080/v1',
    overrides: { contextWindow: 1 },
    env: {},
  })
  assert.equal(floored.contextWindow, MIN_CONTEXT_WINDOW)
})

test('llama.cpp 默认不声明支持 tools —— 发了不支持的 tools 会整轮 400', () => {
  const llamacpp = resolveEndpointProfile({ baseUrl: 'http://localhost:8080/v1', env: {} })
  assert.equal(llamacpp.supportsTools, false)
  const ollama = resolveEndpointProfile({ baseUrl: 'http://localhost:11434', env: {} })
  assert.equal(ollama.supportsTools, true)
})

test('override 能强行开关能力,三态布尔认 0/1', () => {
  const on = resolveEndpointProfile({
    baseUrl: 'http://localhost:8080/v1',
    overrides: { supportsTools: 1 },
    env: {},
  })
  assert.equal(on.supportsTools, true)
  const off = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    overrides: { supportsTools: 0 },
    env: {},
  })
  assert.equal(off.supportsTools, false)
  // null / undefined = 未设置,回落默认
  const unset = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    overrides: { supportsTools: null },
    env: {},
  })
  assert.equal(unset.supportsTools, true)
})

test('MODEL_NAMES_TOOLS 白名单一旦设置就是精确名单', () => {
  const env = { MODEL_NAMES_TOOLS: 'qwen2.5,llama3.1' }
  assert.equal(
    resolveEndpointProfile({ baseUrl: 'http://localhost:11434', modelName: 'qwen2.5', env }).supportsTools,
    true
  )
  assert.equal(
    resolveEndpointProfile({ baseUrl: 'http://localhost:11434', modelName: 'gemma2', env }).supportsTools,
    false
  )
})

test('PDF 能力默认保守，仅官方 OpenAI 或显式白名单开启', () => {
  const openai = resolveEndpointProfile({
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4.1',
    env: {},
  })
  assert.equal(openai.supportsPdf, true)

  const compatible = resolveEndpointProfile({
    baseUrl: 'https://api.deepseek.com/v1',
    modelName: 'deepseek-chat',
    env: {},
  })
  assert.equal(compatible.supportsPdf, false)

  const whitelisted = resolveEndpointProfile({
    baseUrl: 'https://example.com/v1',
    modelName: 'document-model',
    env: { MODEL_NAMES_PDF: 'document-model' },
  })
  assert.equal(whitelisted.supportsPdf, true)

  const forcedOff = resolveEndpointProfile({
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4.1',
    env: {},
    overrides: { supportsPdf: false },
  })
  assert.equal(forcedOff.supportsPdf, false)
})

test('并行工具能力可覆盖且不会在 tools 关闭时误开启', () => {
  const openai = resolveEndpointProfile({
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4.1',
    env: {},
  })
  assert.equal(openai.supportsParallelTools, true)

  const toolsOff = resolveEndpointProfile({
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4.1',
    env: {},
    overrides: { supportsTools: false, supportsParallelTools: true },
  })
  assert.equal(toolsOff.supportsParallelTools, false)
})

test('本地端点默认不允许 failover —— 不许偷偷切到云端并扣钱', () => {
  const local = resolveEndpointProfile({ baseUrl: 'http://192.168.1.50:11434', env: {} })
  assert.equal(local.failoverEligible, false)
  const cloud = resolveEndpointProfile({ baseUrl: 'https://api.deepseek.com', env: {} })
  assert.equal(cloud.failoverEligible, true)
  // 但用户可以显式打开
  const forced = resolveEndpointProfile({
    baseUrl: 'http://192.168.1.50:11434',
    overrides: { failoverEnabled: 1 },
    env: {},
  })
  assert.equal(forced.failoverEligible, true)
})

test('Ollama 带 keep_alive,其它 kind 不带', () => {
  const ollama = resolveEndpointProfile({ baseUrl: 'http://localhost:11434', env: {} })
  assert.equal(ollama.keepAlive, '30m')
  const custom = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    env: { OLLAMA_KEEP_ALIVE: '2h' },
  })
  assert.equal(custom.keepAlive, '2h')
  const lmstudio = resolveEndpointProfile({ baseUrl: 'http://localhost:1234/v1', env: {} })
  assert.equal(lmstudio.keepAlive, null)
})

test('env 级超时覆盖生效,provider 级压过 env 级', () => {
  const envOnly = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    env: { MODEL_IDLE_TIMEOUT_MS: '45000', MODEL_FIRST_TOKEN_TIMEOUT_MS: '90000' },
  })
  assert.equal(envOnly.timeouts.idleMs, 45_000)
  assert.equal(envOnly.timeouts.firstTokenMs, 90_000)

  const providerWins = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    env: { MODEL_IDLE_TIMEOUT_MS: '45000' },
    overrides: { idleTimeoutMs: 15_000 },
  })
  assert.equal(providerWins.timeouts.idleMs, 15_000)
})

test('非法超时值被忽略,不会把超时设成 0 导致秒断', () => {
  const profile = resolveEndpointProfile({
    baseUrl: 'http://localhost:11434',
    env: { MODEL_IDLE_TIMEOUT_MS: '0', MODEL_FIRST_TOKEN_TIMEOUT_MS: 'abc' },
    overrides: { idleTimeoutMs: -5 },
  })
  assert.ok(profile.timeouts.idleMs > 0)
  assert.ok(profile.timeouts.firstTokenMs > 0)
})

test('kind override 只接受合法值', () => {
  const good = resolveEndpointProfile({
    baseUrl: 'https://example.com/v1',
    overrides: { kind: 'ollama' },
    env: {},
  })
  assert.equal(good.kind, 'ollama')
  const bad = resolveEndpointProfile({
    baseUrl: 'https://example.com/v1',
    overrides: { kind: 'nonsense' },
    env: {},
  })
  assert.equal(bad.kind, 'openai-compatible')
})

test('空入参不抛', () => {
  const profile = resolveEndpointProfile()
  assert.equal(typeof profile.kind, 'string')
  assert.equal(profile.isLocal, false)
  assert.ok(profile.contextWindow > 0)
})

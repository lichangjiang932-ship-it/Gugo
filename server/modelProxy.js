import fs from 'node:fs'
import path from 'node:path'
import {
  chargeForModelUse,
  estimateChatCost,
  getBillingDiagnostics,
  getMailDiagnostics,
  getPublicAccount,
  loadBillingConfig,
} from './billingAuth.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const REQUIRED_ENV = ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY']

function readEnvFile(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env')
  if (!fs.existsSync(envPath)) return {}

  const entries = {}
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    entries[key] = value
  }
  return entries
}

export function getRuntimeEnv(env = process.env) {
  return { ...readEnvFile(), ...env }
}

export function loadModelConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]?.trim())
  const temperature = Number(env.MODEL_TEMPERATURE ?? 0.7)
  const maxTokens = Number(env.MODEL_MAX_TOKENS ?? 4096)

  return {
    configured: missing.length === 0,
    missing,
    baseUrl: env.MODEL_BASE_URL?.trim() || '',
    modelName: env.MODEL_NAME?.trim() || '',
    apiKey: env.MODEL_API_KEY?.trim() || '',
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 4096,
  }
}

export function getModelStatus(env = process.env) {
  const config = loadModelConfig(env)
  if (!config.configured) {
    return { ok: true, configured: false, missing: config.missing }
  }

  const status = {
    ok: true,
    configured: true,
    modelName: config.modelName,
    baseUrlMasked: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  }

  const models = getVisibleModels(env, config.modelName)
  if (models.length > 1 || env.MODEL_NAMES) status.models = models
  return status
}

function normalizeModelsUrl(rawUrl = '') {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed.replace(/\/chat\/completions$/i, '/models')
  }
  return `${trimmed}/models`
}

function safeErrorMessage(error) {
  if (error?.status === 401 || error?.status === 403) return 'API Key 无效或权限不足'
  if (error?.status === 404) return '端点不支持 /models 或地址不存在'
  if (error?.name === 'AbortError') return '端点探测超时'
  return error?.message || '端点探测失败'
}

async function checkModelsEndpoint({ config, fetchImpl = fetch }) {
  if (!config.configured) {
    return { checked: false, ok: false, reason: `缺少 ${config.missing.join(', ')}` }
  }

  const url = normalizeModelsUrl(config.baseUrl)
  const controller = new AbortController()
  const started = Date.now()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const headers = {}
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || response.statusText)
      error.status = response.status
      throw error
    }
    const remoteModels = Array.isArray(data?.data)
      ? data.data.map((item) => item.id || item.name).filter(Boolean).slice(0, 50)
      : []
    return {
      checked: true,
      ok: true,
      url,
      latency: Date.now() - started,
      remoteModels,
    }
  } catch (error) {
    return {
      checked: true,
      ok: false,
      url,
      latency: Date.now() - started,
      error: safeErrorMessage(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function getSystemDiagnostics({ env = process.env, fetchImpl = fetch, checkEndpoint = false } = {}) {
  const config = loadModelConfig(env)
  const modelStatus = getModelStatus(env)
  const billing = getBillingDiagnostics(env)
  const mail = getMailDiagnostics(env)
  const endpoint = checkEndpoint
    ? await checkModelsEndpoint({ config, fetchImpl })
    : { checked: false, ok: null, reason: '未执行端点探测' }

  return {
    ok: true,
    generatedAt: Date.now(),
    model: {
      ...modelStatus,
      apiKeyConfigured: !!config.apiKey,
    },
    endpoint,
    billing,
    mail,
  }
}

export function getVisibleModels(env = process.env, defaultModel = '') {
  const names = (env.MODEL_NAMES || defaultModel)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const uniqueNames = [...new Set(names.length ? names : [defaultModel].filter(Boolean))]
  const billingConfig = loadBillingConfig({ ...env, MODEL_NAME: defaultModel })
  return uniqueNames.map((name) => ({
    name,
    multiplier: billingConfig.multipliers[name] || 1,
    active: name === defaultModel,
  }))
}

function pickAllowedModel({ requestedModel, config, env }) {
  const models = getVisibleModels(env, config.modelName)
  const allowed = new Set(models.map((item) => item.name))
  if (!requestedModel) return config.modelName
  if (!allowed.has(requestedModel)) throw new Error(`模型 ${requestedModel} 不在后端允许列表中`)
  return requestedModel
}

export function normalizeOpenAICompatibleUrl(rawUrl = '') {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('请输入 Base URL。')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

export function buildOpenAICompatibleRequest({ config, messages, stream = false }) {
  const model = config?.modelName
  if (!model) throw new Error('请输入模型名称。')
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('消息不能为空。')
  }

  const headers = { 'Content-Type': 'application/json' }
  if (config?.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  return {
    url: normalizeOpenAICompatibleUrl(config?.baseUrl),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: config?.temperature ?? 0.7,
        max_tokens: config?.maxTokens || 4096,
        stream,
      }),
    },
  }
}

export function parseOpenAICompatibleResponse(data) {
  const reply =
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    data?.output?.text ||
    data?.result

  if (!reply) throw new Error('模型返回为空，请检查模型名称或端点响应格式。')
  return reply
}

export function formatProxyError(error) {
  if (error?.status === 400) return '请求参数无效，请检查 Base URL、模型名称和消息内容。'
  if (error?.status === 401 || error?.status === 403) return 'API Key 无效或没有权限。'
  if (error?.status === 404) return '模型或端点不存在，请检查 Base URL 和模型名称。'
  if (error?.status === 408 || error?.name === 'AbortError') return '模型请求超时，请稍后重试或调小 Max Tokens。'
  if (error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED') {
    return '端点不可达，请确认本地模型服务或代理已启动。'
  }
  if (error?.status) return `模型服务返回 HTTP ${error.status}：${error.message || '请求失败'}`
  return error?.message || '模型代理调用失败。'
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function* streamOpenAICompatible({ config, messages, fetchImpl = fetch }) {
  const { url, init } = buildOpenAICompatibleRequest({ config, messages, stream: true })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120000)

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const text = await response.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
      const message = data?.error?.message || data?.message || text.slice(0, 240) || response.statusText
      const error = new Error(message)
      error.status = response.status
      throw error
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取流式响应')

    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6)
        if (payload === '[DONE]') return
        try {
          const chunk = JSON.parse(payload)
          const delta = chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.text || ''
          if (delta) yield delta
        } catch {
          // 忽略无法解析的行
        }
      }
    }
  } finally {
    clearTimeout(timeout)
  }
}

function authToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export async function handleModelProxyRequest(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '仅支持 POST 请求。' })
    return
  }

  try {
    const body = await readJson(req)
    const config = loadModelConfig(getRuntimeEnv())
    if (!config.configured) {
      sendJson(res, 500, {
        ok: false,
        error: `后端模型未配置：缺少 ${config.missing.join(', ')}。请管理员检查 .env。`,
        missing: config.missing,
      })
      return
    }

    const testMode = req.url?.startsWith('/api/model/test')
    const useStream = body.stream === true
    const messages = testMode
      ? [{ role: 'user', content: 'Reply with only: pong' }]
      : body.messages
    const selectedModel = pickAllowedModel({
      requestedModel: body.modelName,
      config,
      env: getRuntimeEnv(),
    })
    const requestConfig = { ...config, modelName: selectedModel }

    let token = ''
    let estimatedCost = 0
    if (!testMode) {
      token = authToken(req)
      const account = getPublicAccount({ token })
      const billingConfig = loadBillingConfig(getRuntimeEnv())
      estimatedCost = estimateChatCost({
        modelName: selectedModel,
        messages,
        config: billingConfig,
      })
      if (account.credits < estimatedCost) {
        sendJson(res, 402, {
          ok: false,
          error: `积分不足，需要 ${estimatedCost} 积分，当前余额 ${account.credits}。请先充值。`,
          requiredCredits: estimatedCost,
          credits: account.credits,
        })
        return
      }
    }

    if (useStream && !testMode) {
      // SSE 流式响应
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      const started = Date.now()
      try {
        for await (const delta of streamOpenAICompatible({ config: requestConfig, messages })) {
          res.write(`data: ${JSON.stringify({ ok: true, delta, latency: Date.now() - started })}\n\n`)
        }
        res.write(`data: ${JSON.stringify({ ok: true, done: true, latency: Date.now() - started })}\n\n`)

        // 扣费
        chargeForModelUse({ token, modelName: selectedModel, cost: estimatedCost })
      } catch (err) {
        res.write(`data: ${JSON.stringify({ ok: false, error: formatProxyError(err) })}\n\n`)
      }
      res.end()
      return
    }

    // 非流式响应（测试模式或前端未启用 stream）
    const started = Date.now()
    const reply = await (async () => {
      const { url, init } = buildOpenAICompatibleRequest({ config: requestConfig, messages })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60000)
      try {
        const response = await fetch(url, { ...init, signal: controller.signal })
        const text = await response.text()
        let data = null
        try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
        if (!response.ok) {
          const message = data?.error?.message || data?.message || text.slice(0, 240) || response.statusText
          const error = new Error(message)
          error.status = response.status
          throw error
        }
        return parseOpenAICompatibleResponse(data)
      } finally {
        clearTimeout(timeout)
      }
    })()

    let billing = null
    if (!testMode) {
      billing = chargeForModelUse({ token, modelName: selectedModel, cost: estimatedCost })
    }
    sendJson(res, 200, {
      ok: true,
      reply,
      latency: Date.now() - started,
      creditsCharged: estimatedCost,
      user: billing?.user,
    })
  } catch (error) {
    const status = /请先登录/.test(error?.message || '') ? 401 : 502
    sendJson(res, status, { ok: false, error: formatProxyError(error) })
  }
}

export async function handleModelStatusRequest(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: '仅支持 GET 请求。' })
    return
  }
  sendJson(res, 200, getModelStatus(getRuntimeEnv()))
}

export async function handleSystemDiagnosticsRequest(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: '仅支持 GET 请求。' })
    return
  }
  const url = new URL(req.url, 'http://localhost')
  const checkEndpoint = url.searchParams.get('check') === '1'
  sendJson(res, 200, await getSystemDiagnostics({ env: getRuntimeEnv(), checkEndpoint }))
}

export function modelProxyPlugin() {
  return {
    name: 'local-model-proxy',
    configureServer(server) {
      server.middlewares.use('/api/system/diagnostics', handleSystemDiagnosticsRequest)
      server.middlewares.use('/api/model/status', handleModelStatusRequest)
      server.middlewares.use('/api/model/test', handleModelProxyRequest)
      server.middlewares.use('/api/model/chat', handleModelProxyRequest)
    },
  }
}

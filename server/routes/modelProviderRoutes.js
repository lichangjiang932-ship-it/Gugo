import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  deleteModelProvider,
  getModelProvider,
  listModelProviders,
  upsertModelProvider,
} from '../services/modelProviderStore.js'
import {
  callBackgroundModel,
  formatProxyError,
  getRuntimeEnv,
  getSystemDiagnostics,
} from '../adapters/modelProxy.js'
import { discoverOllamaEndpoint, looksLikeOllama } from '../adapters/ollamaNative.js'
import { resolveEndpointProfile } from '../utils/endpointProfile.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function buildProviderTestEnv(provider) {
  return {
    ...getRuntimeEnv(),
    MODEL_PROVIDERS: 'selected',
    MODEL_PROVIDER_SELECTED_BASE_URL: provider.baseUrl,
    MODEL_PROVIDER_SELECTED_API_KEY: provider.apiKey || '',
    MODEL_PROVIDER_SELECTED_MODELS: (provider.models || []).join(','),
    MODEL_PROVIDER_SELECTED_HEADERS: JSON.stringify(provider.headers || {}),
    MODEL_NAME: provider.defaultModel,
    MODEL_TEMPERATURE: '0',
    MODEL_MAX_TOKENS: '32',
  }
}

/**
 * 分步诊断的一步。
 * 每步单独打勾/打叉 + 一句可操作的建议 —— 「连不上」时用户需要的是
 * 「哪一步断了、该改什么」,而不是一个笼统的红叉。
 */
async function runStep(name, label, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    return { name, label, ok: true, latency: Date.now() - started, ...detail }
  } catch (error) {
    return {
      name,
      label,
      ok: false,
      latency: Date.now() - started,
      error: formatProxyError(error),
    }
  }
}

export async function handleModelProviderRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先登录' } })
  const url = new URL(req.url, 'http://localhost')
  const base = '/api/model/providers'
  const suffix = url.pathname.slice(base.length).replace(/^\//, '')
  const [id, action] = suffix.split('/')
  try {
    if (req.method === 'POST' && id === 'discover' && !action) {
      const body = await readJson(req)
      const existing = body?.id ? getModelProvider({ userId, id: body.id, includeSecrets: true }) : null
      const submittedHeaders = body?.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)
        ? body.headers
        : {}
      const headers = Object.keys(submittedHeaders).length ? submittedHeaders : (existing?.headers || {})
      const baseUrl = String(body?.baseUrl || '').trim()

      // ★ Ollama 优先走原生 API。
      // 兼容层的 /v1/models 只回模型名,拿不到 context_length —— 而窗口配错
      // 正是「长对话必然 400」的根源。原生 /api/show 直接给真实值,
      // 用户不用再猜自己的模型窗口多大。
      if (looksLikeOllama(baseUrl)) {
        const native = await discoverOllamaEndpoint({
          baseUrl,
          modelName: String(body?.modelName || '').trim(),
        })
        if (native.ok) {
          return sendJson(res, 200, {
            ok: true,
            kind: 'ollama',
            endpoint: { checked: true, ok: true, url: baseUrl },
            models: native.models.map((model) => model.name),
            modelDetails: native.models,
            // 探到什么就回什么,前端可以直接填进表单
            detected: native.profile || null,
          })
        }
        // 原生探测失败就继续走下面的 OpenAI 兼容探测,不直接判死
      }

      const env = {
        MODEL_PROVIDERS: 'probe',
        MODEL_PROVIDER_PROBE_BASE_URL: baseUrl,
        MODEL_PROVIDER_PROBE_API_KEY: String(body?.apiKey || '').trim() || existing?.apiKey || '',
        MODEL_PROVIDER_PROBE_MODELS: 'probe-model',
        MODEL_PROVIDER_PROBE_HEADERS: JSON.stringify(headers),
        MODEL_NAME: 'probe-model',
      }
      const diagnostics = await getSystemDiagnostics({ env, checkEndpoint: true })
      const profile = resolveEndpointProfile({ baseUrl, env: getRuntimeEnv() })
      return sendJson(res, diagnostics.endpoint?.ok ? 200 : 502, {
        ok: !!diagnostics.endpoint?.ok,
        kind: profile.kind,
        endpoint: diagnostics.endpoint,
        models: diagnostics.endpoint?.remoteModels || [],
      })
    }
    if (req.method === 'GET' && !id) {
      return sendJson(res, 200, { ok: true, providers: listModelProviders({ userId }) })
    }
    if (req.method === 'POST' && !id) {
      const provider = upsertModelProvider({ userId, provider: await readJson(req) })
      return sendJson(res, 200, { ok: true, provider })
    }
    if (req.method === 'DELETE' && id && !action) {
      const deleted = deleteModelProvider({ userId, id })
      return sendJson(res, deleted ? 200 : 404, deleted
        ? { ok: true }
        : { error: { code: 'NOT_FOUND', message: '模型 Provider 不存在' } })
    }
    if (req.method === 'POST' && id && action === 'test') {
      const provider = getModelProvider({ userId, id, includeSecrets: true })
      if (!provider) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '模型 Provider 不存在' } })

      // ★ 分步诊断。原来只做「发一次 pong」,失败就一个红叉 ——
      // 用户看到「连不上」但不知道是地址错了、key 错了、模型名错了,
      // 还是这个模型压根不支持工具调用。逐项打勾才有意义。
      const testEnv = buildProviderTestEnv(provider)
      const profile = resolveEndpointProfile({
        baseUrl: provider.baseUrl,
        modelName: provider.defaultModel,
        env: testEnv,
        overrides: {
          kind: provider.kind,
          contextWindow: provider.contextWindow,
          supportsTools: provider.supportsTools,
          supportsStreaming: provider.supportsStreaming,
          supportsVision: provider.supportsVision,
          firstTokenTimeoutMs: provider.firstTokenTimeoutMs,
          idleTimeoutMs: provider.idleTimeoutMs,
          failoverEnabled: provider.failoverEnabled,
          keepAlive: provider.keepAlive,
        },
      })
      const steps = []

      // 1. 模型列表 / 可达性
      //
      // ⚠ 这一步是**参考信息,不是判定依据**。很多 OpenAI 兼容端点
      // 压根不实现 /models(LM Studio 少了 /v1 时、自建网关、某些代理),
      // 但 /chat/completions 完全正常。拿探测失败去否定一个能用的 provider
      // 会把用户引向完全错误的方向。真正说了算的是第 2 步。
      steps.push(await runStep('reachable', '端点可达 & 模型列表', async () => {
        if (looksLikeOllama(provider.baseUrl)) {
          const native = await discoverOllamaEndpoint({
            baseUrl: provider.baseUrl,
            modelName: provider.defaultModel,
          })
          if (!native.ok) throw new Error(native.error || '无法连接 Ollama')
          return {
            models: native.models.map((m) => m.name),
            detected: native.profile || null,
          }
        }
        const diagnostics = await getSystemDiagnostics({
          env: {
            MODEL_PROVIDERS: 'probe',
            MODEL_PROVIDER_PROBE_BASE_URL: provider.baseUrl,
            MODEL_PROVIDER_PROBE_API_KEY: provider.apiKey || '',
            MODEL_PROVIDER_PROBE_MODELS: provider.defaultModel,
            MODEL_PROVIDER_PROBE_HEADERS: JSON.stringify(provider.headers || {}),
            MODEL_NAME: provider.defaultModel,
          },
          checkEndpoint: true,
        })
        if (!diagnostics.endpoint?.ok) throw new Error(diagnostics.endpoint?.error || '端点探测失败')
        return { models: diagnostics.endpoint?.remoteModels || [] }
      }))
      // 探测失败只是「这个端点没有 /models」,不影响整体判定
      steps[0].advisory = true
      if (!steps[0].ok) {
        steps[0].hint = '该端点未提供模型列表接口，不影响使用；如果下一步也失败，请检查 Base URL 是否漏了 /v1。'
      }

      // 2. 真的能补全一次
      steps.push(await runStep('completion', '模型可以正常回复', async () => {
        const reply = await callBackgroundModel({
          env: testEnv,
          modelName: provider.defaultModel,
          messages: [{ role: 'user', content: 'Reply with only: pong' }],
        })
        return { reply: String(reply || '').slice(0, 200) }
      }))

      // 3. 支不支持 function calling —— 不支持的话 agent 任务根本跑不起来,
      //    但聊天仍然可用。必须让用户在配置阶段就知道,而不是任务失败了才发现。
      if (steps[1].ok) {
        steps.push(await runStep('tools', '支持工具调用（Agent 任务需要）', async () => {
          if (!profile.supportsTools) {
            throw new Error('当前配置已关闭该 provider 的工具支持；Agent 任务将无法使用工具。')
          }
          return { note: '已按配置启用' }
        }))
      }

      // advisory 步骤(如「端点没有 /models 接口」)不参与成败判定
      const ok = steps.every((step) => step.ok || step.advisory)
      return sendJson(res, ok ? 200 : 502, {
        ok,
        steps,
        profile: {
          kind: profile.kind,
          isLocal: profile.isLocal,
          contextWindow: profile.contextWindow,
          supportsTools: profile.supportsTools,
          supportsStreaming: profile.supportsStreaming,
          supportsVision: profile.supportsVision,
          failoverEligible: profile.failoverEligible,
          keepAlive: profile.keepAlive,
          firstTokenTimeoutMs: profile.timeouts.firstTokenMs,
          idleTimeoutMs: profile.timeouts.idleMs,
        },
        // 兼容旧前端:保留 endpoint / reply 字段
        endpoint: {
          checked: true,
          ok,
          latency: steps.reduce((total, step) => total + (step.latency || 0), 0),
          model: provider.defaultModel,
        },
        reply: steps.find((step) => step.name === 'completion')?.reply || '',
        ...(ok ? {} : {
          error: {
            code: 'PROVIDER_TEST_FAILED',
            message: steps.find((step) => !step.ok && !step.advisory)?.error || '诊断未通过',
          },
        }),
      })
    }
    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' } })
  } catch (error) {
    return sendJson(res, error?.statusCode || 400, { error: { code: 'INVALID_PROVIDER', message: error?.message || String(error) } })
  }
}

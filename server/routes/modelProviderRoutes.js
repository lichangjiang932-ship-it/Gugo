import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  deleteModelProvider,
  getModelProvider,
  listModelProviders,
  normalizeModelProviderBaseUrl,
  normalizeModelProviderHeaderRemovalKeys,
  normalizeModelProviderHeaders,
  recordModelProviderReadiness,
  removeModelProviderHeaders,
  upsertModelProvider,
} from '../services/modelProviderStore.js'
import {
  callBackgroundModel,
  callBackgroundModelWithTools,
  formatProxyError,
  getRuntimeEnv,
  getSystemDiagnostics,
} from '../adapters/modelProxy.js'
import { discoverOllamaEndpoint, looksLikeOllama } from '../adapters/ollamaNative.js'
import { resolveEndpointProfile } from '../utils/endpointProfile.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const PROVIDER_TOOL_PROBE_NAME = 'gugo_provider_probe'
const PROVIDER_TOOL_PROBE = Object.freeze({
  type: 'function',
  function: {
    name: PROVIDER_TOOL_PROBE_NAME,
    description: 'Return a fixed value to verify function-calling compatibility. This tool has no side effects.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', enum: ['ok'] } },
      required: ['value'],
      additionalProperties: false,
    },
  },
})

function providerToolProbeError(code, message) {
  return Object.assign(new Error(message), { code })
}

const LOCAL_PROVIDER_ERROR_CODES = new Set([
  'MODEL_AUTH_FAILED',
  'MODEL_CONFIG_MISSING',
  'MODEL_TIMEOUT',
  'MODEL_TOOLS_UNSUPPORTED',
  'PROVIDER_TOOL_CALL_MISSING',
  'PROVIDER_TOOL_CALL_INVALID',
  'PROVIDER_TOOL_ARGUMENTS_INVALID',
])

function providerDiagnosticErrorCode(error) {
  const status = Number(error?.status)
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED'
  if (status === 404) return 'PROVIDER_ENDPOINT_OR_MODEL_NOT_FOUND'
  if (status === 408) return 'PROVIDER_TIMEOUT'
  if (status === 429) return 'PROVIDER_RATE_LIMITED'
  if (Number.isFinite(status) && status >= 500) return 'PROVIDER_UPSTREAM_ERROR'
  const code = String(error?.code || '')
  if (code === 'MODEL_AUTH_FAILED') return 'PROVIDER_AUTH_FAILED'
  if (LOCAL_PROVIDER_ERROR_CODES.has(code)) return code
  if (code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED') return 'PROVIDER_UNREACHABLE'
  return 'PROVIDER_REQUEST_FAILED'
}

function redactProviderDiagnostic(value, sensitiveValues = []) {
  let output = String(value || '')
  for (const raw of sensitiveValues) {
    const secret = String(raw || '')
    if (secret && output.includes(secret)) output = output.split(secret).join('[REDACTED]')
  }
  return output
}

function providerSensitiveValues(provider = {}) {
  return [provider.apiKey, ...Object.values(provider.headers || {})].filter((value) => String(value || ''))
}

function redactEndpointDiagnostics(endpoint, sensitiveValues) {
  if (!endpoint || typeof endpoint !== 'object' || !endpoint.error) return endpoint
  return { ...endpoint, error: redactProviderDiagnostic(endpoint.error, sensitiveValues) }
}

export function validateProviderToolProbe(response = {}) {
  const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : []
  if (calls.length === 0) {
    throw providerToolProbeError(
      'PROVIDER_TOOL_CALL_MISSING',
      '模型完成了文本回复，但没有返回要求的函数调用；该 Provider 暂不能用于当前 Agent 对话。',
    )
  }
  if (calls.length !== 1) {
    throw providerToolProbeError(
      'PROVIDER_TOOL_CALL_INVALID',
      '模型返回了多个或冲突的函数调用；该 Provider 暂不能可靠执行 Agent 工具。',
    )
  }
  const [call] = calls
  const toolName = String(call?.function?.name || call?.name || '')
  if (call?.type !== 'function' || toolName !== PROVIDER_TOOL_PROBE_NAME) {
    throw providerToolProbeError(
      'PROVIDER_TOOL_CALL_INVALID',
      '模型没有遵守指定的函数调用；该 Provider 暂不能可靠执行 Agent 工具。',
    )
  }
  const rawArguments = call?.function?.arguments ?? call?.arguments
  let args
  try {
    args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments
  } catch {
    throw providerToolProbeError(
      'PROVIDER_TOOL_ARGUMENTS_INVALID',
      '模型返回了函数调用，但参数不是合法 JSON；该 Provider 暂不能可靠执行 Agent 工具。',
    )
  }
  if (
    !args
    || typeof args !== 'object'
    || Array.isArray(args)
    || args.value !== 'ok'
    || Object.keys(args).length !== 1
  ) {
    throw providerToolProbeError(
      'PROVIDER_TOOL_ARGUMENTS_INVALID',
      '模型返回了函数调用，但参数不符合工具 Schema；该 Provider 暂不能可靠执行 Agent 工具。',
    )
  }
  return { toolCallId: String(call.id || ''), toolName: PROVIDER_TOOL_PROBE_NAME }
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

export function buildProviderProfileOverrides(provider = {}) {
  return {
    kind: provider.kind,
    contextWindow: provider.contextWindow,
    supportsTools: provider.supportsTools,
    supportsStreaming: provider.supportsStreaming,
    supportsVision: provider.supportsVision,
    supportsPdf: provider.supportsPdf,
    firstTokenTimeoutMs: provider.firstTokenTimeoutMs,
    idleTimeoutMs: provider.idleTimeoutMs,
    failoverEnabled: provider.failoverEnabled,
    keepAlive: provider.keepAlive,
    ...(provider.modelProfiles && Object.keys(provider.modelProfiles).length
      ? { models: provider.modelProfiles }
      : {}),
  }
}

function buildProviderTestEnv(provider, modelName) {
  return {
    ...getRuntimeEnv(),
    MODEL_PROVIDERS: 'selected',
    MODEL_PROVIDER_SELECTED_BASE_URL: provider.baseUrl,
    MODEL_PROVIDER_SELECTED_API_KEY: provider.apiKey || '',
    MODEL_PROVIDER_SELECTED_MODELS: (provider.models || []).join(','),
    MODEL_PROVIDER_SELECTED_HEADERS: JSON.stringify(provider.headers || {}),
    MODEL_PROVIDER_SELECTED_PROFILE: JSON.stringify(buildProviderProfileOverrides(provider)),
    MODEL_NAME: modelName,
    MODEL_TEMPERATURE: '0',
    // Thinking models can spend the first 100+ tokens exclusively in
    // reasoning_content. A 32-token probe therefore reported a healthy LM
    // Studio/Qwen endpoint as an empty response. Keep the probe bounded while
    // leaving enough room for a short final answer.
    MODEL_MAX_TOKENS: '512',
  }
}

/**
 * 分步诊断的一步。
 * 每步单独打勾/打叉 + 一句可操作的建议 —— 「连不上」时用户需要的是
 * 「哪一步断了、该改什么」,而不是一个笼统的红叉。
 */
async function runStep(name, label, fn, { sensitiveValues = [] } = {}) {
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
      error: redactProviderDiagnostic(formatProxyError(error), sensitiveValues),
      errorCode: providerDiagnosticErrorCode(error),
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
      const hasHeaders = Object.hasOwn(body || {}, 'headers')
      const hasHeaderUpdates = Object.hasOwn(body || {}, 'headerUpdates')
      if (hasHeaders && hasHeaderUpdates) {
        throw Object.assign(new Error('不能同时提交 headers 和 headerUpdates'), {
          code: 'MODEL_PROVIDER_HEADERS_CONFLICT',
          statusCode: 400,
          field: 'headers',
        })
      }
      const submittedHeaders = hasHeaders
        ? normalizeModelProviderHeaders(body.headers, { field: 'headers' })
        : hasHeaderUpdates
          ? normalizeModelProviderHeaders(body.headerUpdates, { field: 'headerUpdates' })
          : {}
      const removeHeaderKeys = Object.hasOwn(body || {}, 'removeHeaderKeys')
        ? normalizeModelProviderHeaderRemovalKeys(body.removeHeaderKeys)
        : []
      const clearHeaders = body?.clearHeaders === true
      const retainedHeaders = removeModelProviderHeaders(existing?.headers || {}, removeHeaderKeys)
      const headers = clearHeaders
        ? {}
        : { ...retainedHeaders, ...submittedHeaders }
      const baseUrl = normalizeModelProviderBaseUrl(body?.baseUrl)
      const clearApiKey = body?.clearApiKey === true
      const apiKey = clearApiKey
        ? ''
        : (String(body?.apiKey || '').trim() || existing?.apiKey || '')

      // ★ Ollama 优先走原生 API。
      // 兼容层的 /v1/models 只回模型名,拿不到 context_length —— 而窗口配错
      // 正是「长对话必然 400」的根源。原生 /api/show 直接给真实值,
      // 用户不用再猜自己的模型窗口多大。
      if (looksLikeOllama(baseUrl)) {
        const native = await discoverOllamaEndpoint({
          baseUrl,
          modelName: String(body?.modelName || '').trim(),
          headers,
          apiKey,
        })
        if (native.ok) {
          return sendJson(res, 200, {
            ok: true,
            kind: 'ollama',
            endpoint: { checked: true, ok: true, url: baseUrl },
            models: native.models.map((model) => model.name),
            modelDetails: native.models,
            modelProfiles: native.modelProfiles || {},
            // 探到什么就回什么,前端可以直接填进表单
            detected: native.profile || null,
          })
        }
        // 原生探测失败就继续走下面的 OpenAI 兼容探测,不直接判死
      }

      const env = {
        MODEL_PROVIDERS: 'probe',
        MODEL_PROVIDER_PROBE_BASE_URL: baseUrl,
        MODEL_PROVIDER_PROBE_API_KEY: apiKey,
        MODEL_PROVIDER_PROBE_MODELS: 'probe-model',
        MODEL_PROVIDER_PROBE_HEADERS: JSON.stringify(headers),
        MODEL_NAME: 'probe-model',
      }
      const diagnostics = await getSystemDiagnostics({ env, checkEndpoint: true, userId })
      const profile = resolveEndpointProfile({ baseUrl, env: getRuntimeEnv() })
      const endpoint = redactEndpointDiagnostics(diagnostics.endpoint, [
        env.MODEL_PROVIDER_PROBE_API_KEY,
        ...Object.values(headers),
      ])
      return sendJson(res, diagnostics.endpoint?.ok ? 200 : 502, {
        ok: !!diagnostics.endpoint?.ok,
        kind: profile.kind,
        endpoint,
        models: diagnostics.endpoint?.remoteModels || [],
        modelProfiles: diagnostics.endpoint?.remoteModelProfiles || {},
      })
    }
    if (req.method === 'GET' && !id) {
      return sendJson(res, 200, { ok: true, providers: listModelProviders({ userId }) })
    }
    if (req.method === 'POST' && !id) {
      const provider = upsertModelProvider({ userId, provider: await readJson(req), env: getRuntimeEnv() })
      return sendJson(res, 200, { ok: true, provider })
    }
    if (req.method === 'DELETE' && id && !action) {
      const deleted = deleteModelProvider({ userId, id })
      return sendJson(res, deleted ? 200 : 404, deleted
        ? { ok: true }
        : { error: { code: 'NOT_FOUND', message: '模型 Provider 不存在' } })
    }
    if (req.method === 'POST' && id && action === 'test') {
      const body = await readJson(req)
      const provider = getModelProvider({ userId, id, includeSecrets: true })
      if (!provider) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '模型 Provider 不存在' } })
      const rawModelName = body?.modelName
      const modelName = typeof rawModelName === 'string' ? rawModelName.trim() : ''
      if (rawModelName == null || (typeof rawModelName === 'string' && !modelName)) {
        throw Object.assign(new Error('请选择要测试的模型'), {
          code: 'MODEL_PROVIDER_MODEL_REQUIRED',
          statusCode: 400,
          field: 'modelName',
        })
      }
      if (typeof rawModelName !== 'string' || !provider.models.includes(modelName)) {
        throw Object.assign(new Error('测试模型必须属于当前 Provider 的模型列表'), {
          code: 'MODEL_PROVIDER_MODEL_INVALID',
          statusCode: 400,
          field: 'modelName',
        })
      }

      // ★ 分步诊断。原来只做「发一次 pong」,失败就一个红叉 ——
      // 用户看到「连不上」但不知道是地址错了、key 错了、模型名错了,
      // 还是这个模型压根不支持工具调用。逐项打勾才有意义。
      const testEnv = buildProviderTestEnv(provider, modelName)
      const profile = resolveEndpointProfile({
        baseUrl: provider.baseUrl,
        modelName,
        env: testEnv,
        overrides: buildProviderProfileOverrides(provider),
      })
      const steps = []
      const sensitiveValues = providerSensitiveValues(provider)

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
            modelName,
            headers: provider.headers || {},
            apiKey: provider.apiKey || '',
          })
          if (!native.ok) throw new Error(native.error || '无法连接 Ollama')
          return {
            models: native.models.map((m) => m.name),
            detected: native.profile || null,
            modelProfiles: native.modelProfiles || {},
          }
        }
        const diagnostics = await getSystemDiagnostics({
          env: {
            MODEL_PROVIDERS: 'probe',
            MODEL_PROVIDER_PROBE_BASE_URL: provider.baseUrl,
            MODEL_PROVIDER_PROBE_API_KEY: provider.apiKey || '',
            MODEL_PROVIDER_PROBE_MODELS: modelName,
            MODEL_PROVIDER_PROBE_HEADERS: JSON.stringify(provider.headers || {}),
            MODEL_NAME: modelName,
          },
          checkEndpoint: true,
          userId,
        })
        if (!diagnostics.endpoint?.ok) {
          const error = new Error(diagnostics.endpoint?.error || '端点探测失败')
          if (diagnostics.endpoint?.errorCode) error.code = diagnostics.endpoint.errorCode
          if (diagnostics.endpoint?.status) error.status = diagnostics.endpoint.status
          throw error
        }
        return { models: diagnostics.endpoint?.remoteModels || [] }
      }, { sensitiveValues }))
      // 探测失败只是「这个端点没有 /models」,不影响整体判定
      steps[0].advisory = true
      if (!steps[0].ok) {
        steps[0].hint = '该端点未提供模型列表接口，不影响使用；如果下一步也失败，请检查 Base URL 是否漏了 /v1。'
      }

      // 2. 真的能补全一次
      steps.push(await runStep('completion', '模型可以正常回复', async () => {
        const reply = await callBackgroundModel({
          env: testEnv,
          usageOwnerId: userId,
          modelName,
          messages: [{ role: 'user', content: 'Reply with only: pong' }],
        })
        return { reply: String(reply || '').slice(0, 200) }
      }, { sensitiveValues }))

      // 3. 真实 function-call 探针。画像只决定是否允许发送工具协议，不能证明
      //    上游真的会遵守 schema；因此启用工具时必须发出一次无副作用调用并校验。
      //    工具不兼容不会否定普通聊天能力，但会明确标记为 chat-only。
      if (steps[1].ok) {
        let toolStep
        if (!profile.supportsTools) {
          toolStep = {
            name: 'tools',
            label: '支持工具调用（Agent 任务需要）',
            ok: false,
            advisory: true,
            latency: 0,
            supported: false,
            mode: 'chat_only',
            errorCode: 'PROVIDER_TOOLS_DISABLED',
            error: '当前配置已关闭工具调用；文本补全测试可通过，但当前 Agent 对话不可用。',
          }
        } else {
          toolStep = await runStep('tools', '支持工具调用（Agent 任务需要）', async () => {
            const response = await callBackgroundModelWithTools({
              env: testEnv,
              usageOwnerId: userId,
              modelName,
              messages: [{
                role: 'user',
                content: `Call ${PROVIDER_TOOL_PROBE_NAME} with {"value":"ok"}. Do not answer with text.`,
              }],
              tools: [PROVIDER_TOOL_PROBE],
              toolChoice: { type: 'function', function: { name: PROVIDER_TOOL_PROBE_NAME } },
            })
            return {
              ...validateProviderToolProbe(response),
              supported: true,
              mode: 'agent',
              note: '已通过真实 function-call 探针',
            }
          }, { sensitiveValues })
          if (!toolStep.ok) {
            toolStep.advisory = true
            toolStep.supported = false
            toolStep.mode = 'chat_only'
            toolStep.hint = '当前界面通过 Agent 运行时发送消息；请更换支持 function calling 的模型。'
          }
        }
        steps.push(toolStep)
      }

      // advisory 步骤(如「端点没有 /models 接口」)不参与成败判定
      const ok = steps.every((step) => step.ok || step.advisory)
      const completionStep = steps.find((step) => step.name === 'completion')
      const toolStep = steps.find((step) => step.name === 'tools')
      const chatReady = completionStep?.ok === true
      const agentReady = chatReady && toolStep?.ok === true
      const capabilities = {
        chat: chatReady,
        tools: toolStep?.ok === true,
        agent: agentReady,
        mode: agentReady ? 'agent' : chatReady ? 'chat_only' : 'unavailable',
      }
      const blockingStep = steps.find((step) => !step.ok && !step.advisory)
      const testedProvider = recordModelProviderReadiness({
        userId,
        id: provider.id,
        modelName,
        expectedConfigRevision: provider.configRevision,
        readiness: {
          ...capabilities,
          ...(blockingStep?.errorCode ? { errorCode: blockingStep.errorCode } : {}),
        },
      })
      if (!testedProvider) {
        return sendJson(res, 409, {
          error: {
            code: 'MODEL_PROVIDER_CONFIG_CHANGED',
            message: 'Provider 配置在测试期间已变更，本次测试结果未保存；请重新测试最新配置。',
          },
        })
      }
      return sendJson(res, ok ? 200 : 502, {
        ok,
        steps,
        modelName,
        capabilities,
        readiness: testedProvider?.modelReadiness?.[modelName] || null,
        provider: testedProvider,
        profile: {
          kind: profile.kind,
          isLocal: profile.isLocal,
          contextWindow: profile.contextWindow,
          supportsTools: profile.supportsTools,
          supportsStreaming: profile.supportsStreaming,
          supportsVision: profile.supportsVision,
          supportsPdf: profile.supportsPdf,
          supportsParallelTools: profile.supportsParallelTools,
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
          model: modelName,
        },
        reply: steps.find((step) => step.name === 'completion')?.reply || '',
        ...(ok ? {} : {
          error: {
            code: 'PROVIDER_TEST_FAILED',
            message: blockingStep?.error || '诊断未通过',
          },
        }),
      })
    }
    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' } })
  } catch (error) {
    const errorCode = String(error?.code || '')
    const code = errorCode.startsWith('MODEL_PROVIDER_') ? errorCode : 'INVALID_PROVIDER'
    return sendJson(res, error?.statusCode || 400, {
      error: {
        code,
        message: error?.message || String(error),
        ...(error?.field ? { field: error.field } : {}),
        ...(error?.action ? { action: error.action } : {}),
        ...(error?.providerId ? { providerId: error.providerId } : {}),
        ...(error?.details ? { details: error.details } : {}),
      },
    })
  }
}

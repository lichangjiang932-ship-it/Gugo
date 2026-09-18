/**
 * Provider diagnostic probe shared by the HTTP test route and the headless CLI
 * preflight. Keeping one implementation prevents the CLI from inventing a
 * second model-selection or readiness path.
 */
import {
  callBackgroundModel,
  callBackgroundModelWithTools,
  formatProxyError,
  getRuntimeEnv,
  getSystemDiagnostics,
} from '../adapters/modelProxy.js'
import { discoverOllamaEndpoint, looksLikeOllama } from '../adapters/ollamaNative.js'

export const PROVIDER_TOOL_PROBE_NAME = 'gugo_provider_probe'
export const PROVIDER_TOOL_PROBE = Object.freeze({
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

export function providerDiagnosticErrorCode(error) {
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

export function redactProviderDiagnostic(value, sensitiveValues = []) {
  let output = String(value || '')
  for (const raw of sensitiveValues) {
    const secret = String(raw || '')
    if (secret && output.includes(secret)) output = output.split(secret).join('[REDACTED]')
  }
  return output
}

export function providerSensitiveValues(provider = {}) {
  return [provider.apiKey, ...Object.values(provider.headers || {})].filter((value) => String(value || ''))
}

function redactEndpointDiagnostics(endpoint, sensitiveValues) {
  if (!endpoint || typeof endpoint !== 'object' || !endpoint.error) return endpoint
  return { ...endpoint, error: redactProviderDiagnostic(endpoint.error, sensitiveValues) }
}
export { redactEndpointDiagnostics }

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

export function buildProviderProfileOverrides(provider = {}) {
  return {
    kind: provider.kind,
    contextWindow: provider.contextWindow,
    supportsTools: provider.supportsTools,
    supportsNamedToolChoice: provider.supportsNamedToolChoice,
    supportsMidConversationSystem: provider.supportsMidConversationSystem,
    supportsStreamUsage: provider.supportsStreamUsage,
    requiresUserMessage: provider.requiresUserMessage,
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

export function buildProviderTestEnv(provider, modelName, runtimeEnv = getRuntimeEnv()) {
  return {
    ...runtimeEnv,
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

export async function runProviderDiagnosticSteps({ provider, modelName, userId, testEnv, profile }, dependencies = {}) {
  const steps = []
  const sensitiveValues = providerSensitiveValues(provider)
  const callModel = dependencies.callBackgroundModel || callBackgroundModel
  const callModelWithTools = dependencies.callBackgroundModelWithTools || callBackgroundModelWithTools
  const discoverOllama = dependencies.discoverOllamaEndpoint || discoverOllamaEndpoint
  const systemDiagnostics = dependencies.getSystemDiagnostics || getSystemDiagnostics
  const probeToolCall = () => callModelWithTools({
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
  steps.push(await runStep('reachable', '端点可达 & 模型列表', async () => {
    if (looksLikeOllama(provider.baseUrl)) {
      const native = await discoverOllama({
        baseUrl: provider.baseUrl,
        modelName,
        headers: provider.headers || {},
        apiKey: provider.apiKey || '',
      })
      if (!native.ok) throw new Error(native.error || '无法连接 Ollama')
      return {
        models: native.models.map((model) => model.name),
        detected: native.profile || null,
        modelProfiles: native.modelProfiles || {},
      }
    }
    const diagnostics = await systemDiagnostics({
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
    return { models: redactEndpointDiagnostics(diagnostics.endpoint, sensitiveValues)?.remoteModels || [] }
  }, { sensitiveValues }))
  steps[0].advisory = true
  if (!steps[0].ok) {
    steps[0].hint = '该端点未提供模型列表接口，不影响使用；如果下一步也失败，请检查 Base URL 是否漏了 /v1。'
  }
  steps.push(await runStep('completion', '模型可以正常回复', async () => {
    const reply = await callModel({
      env: testEnv,
      usageOwnerId: userId,
      modelName,
      messages: [{ role: 'user', content: 'Reply with only: pong' }],
    })
    return { reply: String(reply || '').slice(0, 200) }
  }, { sensitiveValues }))
  if (steps[1].ok) {
    let toolStep
    if (!profile.supportsTools) {
      toolStep = {
        name: 'tools', label: '支持工具调用（Agent 任务需要）', ok: false, advisory: true,
        latency: 0, supported: false, mode: 'chat_only',
        errorCode: 'PROVIDER_TOOLS_DISABLED',
        error: '当前配置已关闭工具调用；文本补全测试可通过，但当前 Agent 对话不可用。',
      }
    } else {
      toolStep = await runStep('tools', '支持工具调用（Agent 任务需要）', async () => {
        // A single text-only answer is not proof the endpoint cannot call
        // tools; local/streaming models intermittently ignore a forced
        // tool_choice. Retry once (bounded) before declaring chat_only.
        const first = await probeToolCall()
        try {
          return {
            ...validateProviderToolProbe(first), supported: true, mode: 'agent',
            note: '已通过真实 function-call 探针',
          }
        } catch (error) {
          if (error?.code !== 'PROVIDER_TOOL_CALL_MISSING') throw error
          const retry = await probeToolCall()
          return {
            ...validateProviderToolProbe(retry), supported: true, mode: 'agent',
            note: '已通过真实 function-call 探针（第二次尝试）', retried: true,
          }
        }
      }, { sensitiveValues })
      if (!toolStep.ok) {
        Object.assign(toolStep, {
          advisory: true, supported: false, mode: 'chat_only',
          hint: '当前界面通过 Agent 运行时发送消息；请更换支持 function calling 的模型。',
        })
      }
    }
    steps.push(toolStep)
  }
  return steps
}

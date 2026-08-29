import { ensureApiVersionPath, profileForConfig } from './modelEndpoint.js'
import { attachModelRequestIdentity } from './modelRequestIdentity.js'
import { prepareOutboundMessages, retainReasoningForEnv } from './outboundMessagePipeline.js'
import { buildNativeProviderRequest, isNativeProviderKind } from './nativeModelProviders.js'

export function normalizeOpenAICompatibleUrl(rawUrl = '') {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('请输入 Base URL。')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  // 同 normalizeModelsUrl:用户只填 host:port 时补 /v1,否则聊天也会 404
  return `${ensureApiVersionPath(trimmed)}/chat/completions`
}

/**
 * 合并开头连续的 system 消息。
 *
 * 本项目把前置上下文拆成多个独立 system block(identity / ishiki / skills /
 * sessions / memory),这在云端 API 上没问题,但部分本地 OpenAI 兼容层只接受
 * 一个前置 system。只合并开头连续的 system，不改变对话中间的消息顺序。
 */
function mergeLeadingSystemMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length < 2) return messages
  let end = 0
  while (end < messages.length && messages[end]?.role === 'system') end += 1
  if (end < 2) return messages

  const merged = messages
    .slice(0, end)
    .map((message) => systemContentToText(message?.content))
    .filter(Boolean)
    .join('\n\n')

  return [{ role: 'system', content: merged }, ...messages.slice(end)]
}

function systemContentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
      if (typeof part?.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function normalizeMessagesForOpenAI(messages = []) {
  return mergeLeadingSystemMessages(messages).map((message) => {
    if (
      message?.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length > 0
      && message.content === ''
    ) {
      return { ...message, content: null }
    }
    return message
  })
}

/**
 * 该端点能不能吃 stream_options.include_usage。
 * 保守策略:已知支持的家族才开;其余保持关闭,除非用户显式 MODEL_STREAM_USAGE=1。
 */
export function supportsStreamUsage(config, env = process.env) {
  const forced = String(env.MODEL_STREAM_USAGE || '').trim()
  if (forced === '1') return true
  if (forced === '0') return false
  const base = String(config?.baseUrl || '').toLowerCase()
  if (!base) return false
  return /(^|\/\/|\.)(api\.)?(deepseek|openai|siliconflow|moonshot|dashscope|bigmodel|xiaomimimo|together|fireworks|groq)\b/.test(base)
    || base.includes('openai.azure.com')
}

export { retainReasoningForEnv }

export function buildOpenAICompatibleRequest({
  config,
  messages,
  stream = false,
  tools,
  toolChoice,
  env = process.env,
  profile = null,
  ephemeralContext = '',
}) {
  const endpoint = profile || profileForConfig(config || {}, env)
  const model = config?.modelName
  if (!model) throw new Error('请输入模型名称。')
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('消息不能为空。')
  }

  const headers = { 'Content-Type': 'application/json', ...(config?.headers || {}) }
  if (config?.apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }

  const outboundMessages = prepareOutboundMessages({
    messages,
    profile: endpoint,
    modelName: model,
    providerKind: endpoint.kind,
    providerId: config?.providerId,
    ephemeralContext,
    retainReasoning: retainReasoningForEnv(env),
  })
  if (outboundMessages.length === 0) throw new Error('消息不能为空。')

  const body = {
    model,
    messages: normalizeMessagesForOpenAI(outboundMessages),
    temperature: config?.temperature ?? 0.7,
    stream,
  }
  // maxTokens 为 0/未设置 = 不限制，不发字段，让端点使用自身上限。
  const outputCap = Number(config?.maxTokens)
  if (Number.isFinite(outputCap) && outputCap > 0) {
    body.max_tokens = outputCap
  }
  if (Array.isArray(tools) && tools.length > 0 && endpoint.supportsTools !== true) {
    const error = new Error('当前模型端点未启用 function calling，无法执行需要工具的任务。请启用工具调用支持或选择兼容模型。')
    error.code = 'MODEL_TOOLS_UNSUPPORTED'
    error.type = 'configuration_error'
    error.retryable = false
    throw error
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
    if (endpoint.supportsParallelTools) body.parallel_tool_calls = true
  }
  if (endpoint.keepAlive) {
    body.keep_alive = endpoint.keepAlive
  }
  if (stream && supportsStreamUsage(config)) {
    body.stream_options = { include_usage: true }
  }

  return {
    url: normalizeOpenAICompatibleUrl(config?.baseUrl),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  }
}

export function buildModelProviderRequest(args = {}) {
  const profile = args.profile || profileForConfig(args.config || {}, args.env)
  const providerRequest = isNativeProviderKind(profile.kind)
    ? buildNativeProviderRequest({ ...args, profile })
    : buildOpenAICompatibleRequest({ ...args, profile })
  return attachModelRequestIdentity(providerRequest, args.modelRequestId)
}

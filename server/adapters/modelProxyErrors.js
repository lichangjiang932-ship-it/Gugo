export const MODEL_CONFIG_MISSING_CODE = 'MODEL_CONFIG_MISSING'
export const MODEL_CONFIG_MISSING_MESSAGE = '模型服务尚未配置，请先在设置中添加并启用模型 Provider。'

export function isContextLengthError(error) {
  const detail = [error?.message, error?.code, error?.type].filter(Boolean).join(' ')
  if (!detail) return false
  const status = Number(error?.status)
  const statusLooksRight = status === 400 || status === 413 || status === 500 || !Number.isFinite(status)
  if (!statusLooksRight) return false
  return /context_length|context window|context size|token.?limit|maximum context|reduce the length|too many tokens|exceeds?\s+the\s+(available\s+)?context|n_ctx|prompt is too long|kv cache|input is too long|too long for the model/i
    .test(detail)
}

export function formatProxyError(error) {
  const message = error?.message || ''

  if (error?.code === MODEL_CONFIG_MISSING_CODE) return MODEL_CONFIG_MISSING_MESSAGE
  if (String(error?.code || '').startsWith('OUTBOUND_')) {
    return '模型端点被出站安全策略拒绝，请检查 Base URL、DNS 解析和重定向目标。'
  }
  if (error?.code === 'MODEL_TIMEOUT') return message || '模型请求超时。'
  if (error?.status === 400) {
    if (isContextLengthError(error)) {
      return '内容超出模型最大上下文长度，请缩短消息或开启会话压缩。'
    }
    if (/invalid.*model|model.*not found/i.test(message)) {
      return '模型名称无效，请检查当前 Provider 的模型名称。'
    }
    if (/rate.?limit/i.test(message)) return 'API 调用频率超限，请稍后重试。'
    return '请求参数无效：请检查消息内容、工具调用上下文或当前模型的 OpenAI 兼容性。'
  }
  if (error?.status === 401 || error?.status === 403) return 'API Key 无效或没有权限。'
  if (error?.status === 404) return '模型或端点不存在，请检查 Base URL 和模型名称。'
  if (error?.status === 408 || error?.name === 'AbortError') return '模型请求超时，请稍后重试或调小 Max Tokens。'
  if (error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED') {
    return '端点不可达，请确认本地模型服务或代理已启动。'
  }
  if (error?.status) return `模型服务返回 HTTP ${error.status}：${message || '请求失败'}`
  return message || '模型代理调用失败。'
}

/**
 * Keep raw configuration keys available to server-side diagnostics without
 * making them part of the public error payload. Several callers surface an
 * Error message directly to users, so the message itself must remain safe.
 */
export function createModelConfigMissingError(config = {}) {
  const error = new Error(MODEL_CONFIG_MISSING_MESSAGE)
  error.code = MODEL_CONFIG_MISSING_CODE
  error.statusCode = 503
  Object.defineProperty(error, 'diagnostics', {
    value: Object.freeze({
      missingFields: Object.freeze(Array.isArray(config.missing) ? [...config.missing] : []),
    }),
    enumerable: false,
  })
  return error
}

export function assertModelConfigured(config) {
  if (!config?.configured) throw createModelConfigMissingError(config)
  return config
}

export function endpointProbeErrorCode(error) {
  const status = Number(error?.status)
  if (status === 401 || status === 403) return 'MODEL_AUTH_FAILED'
  if (status === 404) return 'MODEL_ENDPOINT_NOT_FOUND'
  if (error?.name === 'AbortError') return 'MODEL_ENDPOINT_TIMEOUT'
  if (error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED') return 'MODEL_ENDPOINT_UNREACHABLE'
  if (Number.isFinite(status) && status >= 400) return 'MODEL_ENDPOINT_HTTP_ERROR'
  return 'MODEL_ENDPOINT_PROBE_FAILED'
}

export function redactModelConfigSecrets(value, config = {}) {
  let output = String(value || '')
  const sensitiveValues = [config.apiKey, ...Object.values(config.headers || {})]
  for (const raw of sensitiveValues) {
    const secret = String(raw || '')
    if (secret && output.includes(secret)) output = output.split(secret).join('[REDACTED]')
  }
  return output
}

export function redactModelError(error, config = {}) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  for (const field of ['message', 'code', 'type', 'responseBody']) {
    if (error[field] == null) continue
    const redacted = redactModelConfigSecrets(error[field], config)
    try { error[field] = redacted } catch { /* immutable upstream error */ }
  }
  return error
}

export async function withRedactedModelErrors(config, operation) {
  try {
    return await operation()
  } catch (error) {
    throw redactModelError(error, config)
  }
}

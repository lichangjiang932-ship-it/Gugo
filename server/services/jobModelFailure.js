import { isContextLengthError } from '../adapters/modelProxy.js'

const PUBLIC_FAILURES = Object.freeze({
  MODEL_CONFIG_MISSING: {
    message: '还没有可用的模型。请先到“设置 → 模型”添加并保存模型服务。',
    action: 'configure_model',
    statusCode: 503,
  },
  MODEL_PROVIDER_UNVERIFIED: {
    message: '该模型 Provider 尚未完成可用性测试，请先在“设置 → 模型”中测试连接。',
    action: 'test_provider',
    statusCode: 409,
  },
  MODEL_PROVIDER_CHAT_ONLY: {
    message: '该模型不支持当前 Agent 任务所需的工具调用，请选择可用于 Agent 的模型。',
    action: 'choose_agent_provider',
    statusCode: 409,
  },
  MODEL_PROVIDER_UNAVAILABLE: {
    message: '该模型 Provider 当前不可用，请检查 URL、API Key 和模型名称后重新测试。',
    action: 'test_provider',
    statusCode: 503,
  },
  MODEL_PROVIDER_AMBIGUOUS: {
    message: '多个 Provider 提供同名模型，请明确选择要使用的 Provider。',
    action: 'choose_agent_provider',
    statusCode: 409,
  },
  MODEL_PROVIDER_BINDING_MISSING: {
    message: '该任务缺少可验证的模型 Provider 绑定，请重新创建任务。',
    action: 'recreate_job',
    statusCode: 409,
  },
  MODEL_PROVIDER_CONFIG_CHANGED: {
    message: '任务绑定的模型 Provider 配置已变更，请确认配置后重新创建任务。',
    action: 'recreate_job',
    statusCode: 409,
  },
  MODEL_REQUEST_OUTCOME_UNKNOWN: {
    message: '模型请求的最终结果无法确认；继续前需要人工核验，避免重复执行。',
    action: 'verify_model_request',
    statusCode: 409,
  },
  MODEL_AUTH_FAILED: {
    message: '模型服务拒绝了认证信息，请检查 API Key 或自定义 Header 后重新测试。',
    action: 'test_provider',
    statusCode: 502,
  },
  MODEL_ENDPOINT_NOT_FOUND: {
    message: '模型端点或模型名称不存在，请检查 Base URL 和模型名称后重新测试。',
    action: 'test_provider',
    statusCode: 502,
  },
  MODEL_ENDPOINT_UNREACHABLE: {
    message: '无法连接模型服务，请确认本地服务已启动，并检查 Base URL 与网络访问。',
    action: 'test_provider',
    statusCode: 503,
  },
  MODEL_OUTBOUND_BLOCKED: {
    message: '模型端点被本地出站安全策略拒绝，请检查 Base URL、DNS 和重定向目标。',
    action: 'test_provider',
    statusCode: 502,
  },
  MODEL_TIMEOUT: {
    message: '模型服务长时间没有响应，请确认服务仍在运行后重试。',
    action: 'retry',
    statusCode: 504,
  },
  MODEL_RATE_LIMITED: {
    message: '模型服务当前请求过多，请稍后重试。',
    action: 'retry',
    statusCode: 429,
  },
  MODEL_CONTEXT_LIMIT: {
    message: '任务内容超出模型上下文长度，请缩短任务描述或选择更大上下文的模型。',
    action: 'retry',
    statusCode: 422,
  },
  MODEL_REQUEST_REJECTED: {
    message: '模型服务拒绝了规划请求，请检查模型名称和兼容设置后重试。',
    action: 'test_provider',
    statusCode: 502,
  },
  MODEL_UPSTREAM_ERROR: {
    message: '模型服务暂时不可用，请稍后重试。',
    action: 'retry',
    statusCode: 503,
  },
})

function sourceCode(error) {
  return String(error?.code || error?.cause?.code || '').trim().toUpperCase()
}

function upstreamStatus(error) {
  const status = Number(error?.status)
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null
}

export function isJobModelFailure(error) {
  return Boolean(publicCode(error))
}

function publicCode(error) {
  const code = sourceCode(error)
  const status = upstreamStatus(error)
  if (status === 401 || status === 403) return 'MODEL_AUTH_FAILED'
  if (status === 404) return 'MODEL_ENDPOINT_NOT_FOUND'
  if (status === 408) return 'MODEL_TIMEOUT'
  if (status === 429) return 'MODEL_RATE_LIMITED'
  if (isContextLengthError(error)) return 'MODEL_CONTEXT_LIMIT'
  if (Object.hasOwn(PUBLIC_FAILURES, code)) return code
  if (code.startsWith('OUTBOUND_')) return 'MODEL_OUTBOUND_BLOCKED'
  if (['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'].includes(code)) {
    return 'MODEL_ENDPOINT_UNREACHABLE'
  }
  if (code === 'ETIMEDOUT' || error?.name === 'AbortError') return 'MODEL_TIMEOUT'
  if (status === 400) return 'MODEL_REQUEST_REJECTED'
  if (status !== null && status >= 500) return 'MODEL_UPSTREAM_ERROR'
  return ''
}

function normalizedRevision(value) {
  const revision = Number(value)
  return Number.isInteger(revision) && revision > 0 ? revision : null
}

export function describeJobModelFailure(error, context = {}) {
  const code = publicCode(error)
  if (!code) return null
  const spec = PUBLIC_FAILURES[code]
  return Object.freeze({
    code,
    message: spec.message,
    action: spec.action,
    statusCode: spec.statusCode,
    providerId: String(error?.providerId || context.providerId || context.modelProviderId || '').trim() || null,
    modelName: String(error?.modelName || context.modelName || '').trim() || null,
    configRevision: normalizedRevision(error?.configRevision ?? context.configRevision ?? context.modelConfigRevision),
  })
}

export class JobModelFailureError extends Error {
  constructor(error, context = {}) {
    const failure = describeJobModelFailure(error, context)
    if (!failure) throw new TypeError('JobModelFailureError requires a model failure')
    super(failure.message, { cause: error })
    this.name = 'JobModelFailureError'
    Object.assign(this, failure)
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      action: this.action,
      providerId: this.providerId,
      modelName: this.modelName,
      configRevision: this.configRevision,
    }
  }
}

export function wrapJobModelFailure(error, context = {}) {
  return isJobModelFailure(error) ? new JobModelFailureError(error, context) : null
}

export function isJobModelFailureError(error) {
  return error instanceof JobModelFailureError
}

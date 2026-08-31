import { isContextLengthError } from '../adapters/modelProxy.js'

const PUBLIC_FAILURES = Object.freeze({
  MODEL_CONFIG_MISSING: {
    message: 'No model service is configured. Configure a model service before retrying.',
    action: 'configure_model',
    statusCode: 503,
  },
  MODEL_PROVIDER_UNVERIFIED: {
    message: 'The model provider has not passed its availability check. Test the provider before retrying.',
    action: 'test_provider',
    statusCode: 409,
  },
  MODEL_PROVIDER_CHAT_ONLY: {
    message: 'The selected model does not support the tool calls required by this Agent task.',
    action: 'choose_agent_provider',
    statusCode: 409,
  },
  MODEL_PROVIDER_UNAVAILABLE: {
    message: 'The model provider is unavailable. Check its URL, credentials, and model name before retrying.',
    action: 'test_provider',
    statusCode: 503,
  },
  MODEL_PROVIDER_AMBIGUOUS: {
    message: 'Multiple providers expose this model name. Select a provider explicitly.',
    action: 'choose_agent_provider',
    statusCode: 409,
  },
  MODEL_PROVIDER_BINDING_MISSING: {
    message: 'The task has no verifiable model-provider binding. Recreate the task.',
    action: 'recreate_job',
    statusCode: 409,
  },
  MODEL_PROVIDER_CONFIG_CHANGED: {
    message: 'The model-provider configuration bound to this task has changed. Recreate the task.',
    action: 'recreate_job',
    statusCode: 409,
  },
  MODEL_REQUEST_OUTCOME_UNKNOWN: {
    message: 'The final model-request outcome is unknown. Verify it before continuing to avoid duplicate execution.',
    action: 'verify_model_request',
    statusCode: 409,
  },
  MODEL_AUTH_FAILED: {
    message: 'The model service rejected the credentials. Check the API key or custom headers.',
    action: 'test_provider',
    statusCode: 502,
  },
  MODEL_ENDPOINT_NOT_FOUND: {
    message: 'The model endpoint or model name was not found. Check the base URL and model name.',
    action: 'test_provider',
    statusCode: 502,
  },
  MODEL_ENDPOINT_UNREACHABLE: {
    message: 'The model service could not be reached. Check that it is running and that its URL is accessible.',
    action: 'test_provider',
    statusCode: 503,
  },
  MODEL_OUTBOUND_BLOCKED: {
    message: 'The model endpoint was blocked by the outbound network policy. Check its URL, DNS, and redirects.',
    action: 'test_provider',
    statusCode: 502,
  },
  MODEL_TIMEOUT: {
    message: 'The model service timed out. Confirm that it is still running before retrying.',
    action: 'retry',
    statusCode: 504,
  },
  MODEL_RATE_LIMITED: {
    message: 'The model service is rate limited. Retry later.',
    action: 'retry',
    statusCode: 429,
  },
  MODEL_CONTEXT_LIMIT: {
    message: 'The task exceeds the model context limit. Shorten the input or select a model with a larger context.',
    action: 'retry',
    statusCode: 422,
  },
  MODEL_REQUEST_REJECTED: {
    message: 'The model service rejected the planning request. Check the model name and compatibility settings.',
    action: 'test_provider',
    statusCode: 502,
  },
  MODEL_UPSTREAM_ERROR: {
    message: 'The model service is temporarily unavailable. Retry later.',
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

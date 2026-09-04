import {
  getModelProviders,
  MODEL_CONFIG_MISSING_CODE,
  profileForConfig,
  resolveModelConfigForModel,
} from '../adapters/modelProxy.js'
import {
  buildUserModelEnv,
  getModelProvider,
  listModelProviders,
  resolveUserModelProvider,
} from './modelProviderStore.js'
import { credentialScopedFingerprint } from '../utils/credentialVault.js'

const READINESS_ERRORS = Object.freeze({
  [MODEL_CONFIG_MISSING_CODE]: {
    statusCode: 503,
    action: 'configure_model',
    message: '还没有可用的模型。请先到“设置 → 模型”添加并保存模型服务。',
  },
  MODEL_PROVIDER_NOT_FOUND: {
    statusCode: 404,
    action: 'choose_agent_provider',
    message: '指定的模型 Provider 不存在，请检查 --provider 或重新选择 Provider。',
  },
  MODEL_PROVIDER_DISABLED: {
    statusCode: 409,
    action: 'enable_provider',
    message: '指定的模型 Provider 已禁用，请先启用该 Provider。',
  },
  MODEL_PROVIDER_MODEL_INVALID: {
    statusCode: 400,
    action: 'choose_agent_provider',
    message: '指定的模型不属于该 Provider，请检查 --model 或选择已配置的模型。',
  },
  MODEL_PROVIDER_UNVERIFIED: {
    statusCode: 409,
    action: 'test_provider',
    message: '该模型 Provider 尚未完成可用性测试，请先在“设置 → 模型”中测试连接。',
  },
  MODEL_PROVIDER_CHAT_ONLY: {
    statusCode: 409,
    action: 'choose_agent_provider',
    message: '该模型已通过文本补全测试，但不支持当前 Agent 对话所需的工具调用。',
  },
  MODEL_PROVIDER_UNAVAILABLE: {
    statusCode: 503,
    action: 'test_provider',
    message: '该模型 Provider 最近一次测试不可用，请检查 URL、API Key 和模型名称后重新测试。',
  },
  MODEL_PROVIDER_CONFIG_CHANGED: {
    statusCode: 409,
    action: 'recreate_job',
    message: '任务绑定的模型 Provider 配置已变更或不可用。为避免静默切换模型，请重新测试 Provider 后创建新任务。',
  },
  MODEL_PROVIDER_BINDING_MISSING: {
    statusCode: 409,
    action: 'recreate_job',
    message: '该任务没有可验证的模型 Provider 绑定。为避免使用错误模型，请重新创建任务。',
  },
  MODEL_PROVIDER_AMBIGUOUS: {
    statusCode: 409,
    action: 'choose_agent_provider',
    message: '多个 Provider 提供同名模型，请传入 modelProviderId。',
  },
})

const UNKNOWN_PUBLIC_READINESS_ERROR = Object.freeze({
  statusCode: 409,
  action: 'configure_model',
  message: '模型配置当前不可用，请到“设置 → 模型”检查配置后重试。',
})

export class ModelReadinessError extends Error {
  constructor(code, context = {}) {
    const spec = READINESS_ERRORS[code] || READINESS_ERRORS[MODEL_CONFIG_MISSING_CODE]
    super(spec.message)
    this.name = 'ModelReadinessError'
    this.code = code
    this.action = spec.action
    this.statusCode = spec.statusCode
    this.providerId = String(context.providerId || '').trim() || null
    this.modelName = String(context.modelName || '').trim() || null
    this.configRevision = Number.isInteger(context.configRevision) ? context.configRevision : null
    this.details = context.details && typeof context.details === 'object' ? context.details : null
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      action: this.action,
      providerId: this.providerId,
      modelName: this.modelName,
      configRevision: this.configRevision,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function isModelReadinessError(error) {
  return error instanceof ModelReadinessError
    || (typeof error?.code === 'string' && Object.hasOwn(READINESS_ERRORS, error.code))
}

/**
 * Project an internal readiness failure onto the stable public HTTP contract.
 * Diagnostic fields such as `details.missing` deliberately stay on the source
 * error and must never be copied into API responses or persisted task output.
 */
export function describeModelReadinessFailure(error) {
  const sourceCode = String(error?.code || '').trim()
  const knownSpec = READINESS_ERRORS[sourceCode]
  const spec = knownSpec || UNKNOWN_PUBLIC_READINESS_ERROR
  const revision = Number(error?.configRevision)
  return Object.freeze({
    statusCode: spec.statusCode,
    error: Object.freeze({
      code: knownSpec ? sourceCode : 'MODEL_READINESS_FAILED',
      message: spec.message,
      action: spec.action,
      providerId: String(error?.providerId || '').trim() || null,
      modelName: String(error?.modelName || '').trim() || null,
      configRevision: Number.isInteger(revision) && revision > 0 ? revision : null,
    }),
  })
}

function fail(code, context) {
  throw new ModelReadinessError(code, context)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function environmentConfigRevision({ provider, config, env }) {
  if (!provider) return null
  const serialized = JSON.stringify(canonicalize({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    headers: provider.headers,
    models: provider.models,
    profileOverrides: provider.profileOverrides,
    modelName: config.modelName,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  }))
  const fingerprint = credentialScopedFingerprint(serialized, {
    purpose: 'environment-model-provider-runtime',
    env: { ...process.env, ...env },
  })
  // Thirteen hex digits stay below Number.MAX_SAFE_INTEGER. Zero is reserved
  // for an absent revision, so normalize the astronomically unlikely all-zero
  // prefix to one.
  return Number.parseInt(fingerprint.slice(0, 13), 16) || 1
}

/**
 * Resolve the exact model configuration a new Agent job will use and reject it
 * before planning/persistence when that configuration cannot safely run tools.
 *
 * Database-backed providers require a probe for their current config revision.
 * Legacy .env-only setups remain compatible and use the endpoint profile as the
 * capability source because they have no provider row on which to persist a probe.
 */
function resolveRequestedProvider({ userId, requestedProviderId, requestedModel, runtimeEnv }) {
  let provider
  try {
    provider = resolveUserModelProvider({
      userId,
      providerId: requestedProviderId,
      modelName: requestedModel,
    })
  } catch (error) {
    if (error?.code === 'MODEL_PROVIDER_AMBIGUOUS') {
      fail('MODEL_PROVIDER_AMBIGUOUS', {
        modelName: requestedModel,
        details: error.details,
      })
    }
    throw error
  }
  const requestedEnvironmentProvider = !provider && requestedProviderId
    ? getModelProviders(runtimeEnv).find((item) => item.id === requestedProviderId) || null
    : null
  const environmentProvider = requestedEnvironmentProvider
    && (!requestedModel || requestedEnvironmentProvider.models.includes(requestedModel))
    ? requestedEnvironmentProvider
    : null
  return { provider, requestedEnvironmentProvider, environmentProvider }
}

export function assertAgentModelReady({
  userId,
  providerId = '',
  modelName = '',
  configRevision = null,
  env = process.env,
  requireAgent = true,
} = {}) {
  const requestedProviderId = String(providerId || '').trim()
  const requestedModel = String(modelName || '').trim()
  const expectedRevision = Number(configRevision)
  const hasExpectedRevision = Number.isInteger(expectedRevision) && expectedRevision > 0
  const runtimeEnv = buildUserModelEnv({ userId, env })
  const { provider, requestedEnvironmentProvider, environmentProvider } = resolveRequestedProvider({
    userId,
    requestedProviderId,
    requestedModel,
    runtimeEnv,
  })

  if (requestedProviderId && !provider && !environmentProvider) {
    const persistedProviders = listModelProviders({ userId })
    const persisted = persistedProviders.find((item) => item.id === requestedProviderId)
      || persistedProviders.find((item) => item.key === requestedProviderId)
    let code = 'MODEL_PROVIDER_NOT_FOUND'
    let reason = 'provider_not_found'
    if (persisted && !persisted.enabled) {
      code = 'MODEL_PROVIDER_DISABLED'
      reason = 'provider_disabled'
    } else if ((persisted || requestedEnvironmentProvider) && requestedModel) {
      code = 'MODEL_PROVIDER_MODEL_INVALID'
      reason = 'model_not_in_provider'
    }
    fail(hasExpectedRevision ? 'MODEL_PROVIDER_CONFIG_CHANGED' : code, {
      providerId: requestedProviderId,
      modelName: requestedModel,
      configRevision: hasExpectedRevision ? expectedRevision : null,
      details: { reason },
    })
  }

  if (provider && hasExpectedRevision && provider.configRevision !== expectedRevision) {
    fail('MODEL_PROVIDER_CONFIG_CHANGED', {
      providerId: provider.id,
      modelName: requestedModel || provider.defaultModel,
      configRevision: expectedRevision,
      details: {
        expectedRevision,
        currentRevision: provider.configRevision,
      },
    })
  }

  const selectedModel = requestedModel || provider?.defaultModel || environmentProvider?.models[0] || ''
  const validationEnv = provider
    ? lockRuntimeEnvToProvider({ runtimeEnv, provider, modelName: selectedModel })
    : runtimeEnv
  const config = resolveModelConfigForModel({
    modelName: selectedModel,
    providerId: environmentProvider?.id || '',
    env: validationEnv,
  })
  const environmentRevision = environmentConfigRevision({
    provider: environmentProvider,
    config,
    env: validationEnv,
  })
  if (environmentProvider && hasExpectedRevision && environmentRevision !== expectedRevision) {
    fail('MODEL_PROVIDER_CONFIG_CHANGED', {
      providerId: requestedProviderId,
      modelName: config.modelName || selectedModel,
      configRevision: expectedRevision,
      details: {
        reason: 'environment_provider_config_changed',
        expectedRevision,
        currentRevision: environmentRevision,
      },
    })
  }
  const context = {
    providerId: provider?.id || environmentProvider?.id || requestedProviderId,
    modelName: config.modelName || selectedModel,
    configRevision: provider?.configRevision ?? environmentRevision,
  }

  if (!config.configured) {
    fail(MODEL_CONFIG_MISSING_CODE, {
      ...context,
      details: { missing: Array.isArray(config.missing) ? config.missing : [] },
    })
  }

  if (provider) {
    const readiness = provider.modelReadiness?.[context.modelName] || null
    if (!readiness) fail('MODEL_PROVIDER_UNVERIFIED', context)
    if (readiness.mode === 'unavailable' || readiness.chat !== true) {
      fail('MODEL_PROVIDER_UNAVAILABLE', {
        ...context,
        details: readiness.errorCode ? { errorCode: readiness.errorCode } : null,
      })
    }
    if (requireAgent && (readiness.mode === 'chat_only' || readiness.agent !== true || readiness.tools !== true)) {
      fail('MODEL_PROVIDER_CHAT_ONLY', context)
    }
    return {
      providerId: provider.id,
      modelName: context.modelName,
      configRevision: provider.configRevision,
      readiness,
      source: 'provider',
    }
  }

  const profile = profileForConfig(config, validationEnv)
  if (requireAgent && profile.supportsTools !== true) {
    fail('MODEL_PROVIDER_CHAT_ONLY', {
      ...context,
      details: { source: 'endpoint_profile' },
    })
  }
  return {
    providerId: environmentProvider?.id || null,
    modelName: context.modelName,
    configRevision: environmentRevision,
    readiness: {
      chat: true,
      tools: profile.supportsTools === true,
      agent: profile.supportsTools === true,
      mode: profile.supportsTools === true ? 'agent' : 'chat_only',
      checkedAt: null,
      configRevision: environmentRevision,
    },
    source: 'environment',
  }
}

export function assertChatModelReady(options = {}) {
  return assertAgentModelReady({ ...options, requireAgent: false })
}

function providerEnvPrefix(key) {
  return `MODEL_PROVIDER_${String(key || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

function lockRuntimeEnvToProvider({ runtimeEnv, provider, modelName }) {
  const prefix = providerEnvPrefix(provider.key)
  return {
    ...runtimeEnv,
    MODEL_PROVIDERS: provider.key,
    MODEL_NAME: modelName,
    MODEL_NAMES: provider.models.join(','),
    MODEL_BASE_URL: runtimeEnv[`${prefix}_BASE_URL`] || provider.baseUrl,
    MODEL_API_KEY: runtimeEnv[`${prefix}_API_KEY`] || '',
  }
}

/**
 * Resolve a model binding together with an in-memory, single-provider runtime
 * environment. The returned environment contains credentials and must never be
 * persisted or serialized. Call modelProxy with userId=null when supplying it,
 * otherwise buildUserModelEnv() would expand the scope back to every provider.
 */
export function resolveAgentModelRuntimeBinding({
  userId,
  providerId = '',
  modelName = '',
  configRevision = null,
  env = process.env,
  requirePersistedBinding = false,
  readinessAssertion = assertAgentModelReady,
} = {}) {
  if (requirePersistedBinding && !String(modelName || '').trim()) {
    fail('MODEL_PROVIDER_BINDING_MISSING', {
      providerId,
      modelName: null,
      configRevision: Number.isInteger(Number(configRevision)) && Number(configRevision) > 0
        ? Number(configRevision)
        : null,
      details: { reason: 'model_snapshot_missing' },
    })
  }
  const binding = readinessAssertion({
    userId,
    providerId,
    modelName,
    configRevision,
    env,
  })
  const runtimeEnv = buildUserModelEnv({ userId, env })

  if (binding.source === 'provider') {
    if (requirePersistedBinding && (
      !providerId
      || !Number.isInteger(Number(configRevision))
      || Number(configRevision) <= 0
    )) {
      fail('MODEL_PROVIDER_BINDING_MISSING', {
        providerId: binding.providerId,
        modelName: binding.modelName,
        configRevision: binding.configRevision,
        details: { reason: 'provider_snapshot_missing' },
      })
    }
    const provider = getModelProvider({ userId, id: binding.providerId })
    if (!provider) {
      fail('MODEL_PROVIDER_CONFIG_CHANGED', {
        providerId: binding.providerId,
        modelName: binding.modelName,
        configRevision: binding.configRevision,
        details: { reason: 'provider_not_found' },
      })
    }
    return {
      ...binding,
      env: lockRuntimeEnvToProvider({ runtimeEnv, provider, modelName: binding.modelName }),
    }
  }

  const requestedEnvironmentProvider = String(providerId || '').trim()
  const resolvedEnvironmentProvider = String(binding.providerId || '').trim()
  const invalidPersistedEnvironmentBinding = resolvedEnvironmentProvider
    ? (
        !requestedEnvironmentProvider
        || !Number.isInteger(Number(configRevision))
        || Number(configRevision) <= 0
        || resolvedEnvironmentProvider !== requestedEnvironmentProvider
        || binding.configRevision !== Number(configRevision)
      )
    : (configRevision != null || Boolean(requestedEnvironmentProvider))
  if (requirePersistedBinding && invalidPersistedEnvironmentBinding) {
    fail('MODEL_PROVIDER_CONFIG_CHANGED', {
      providerId,
      modelName: binding.modelName,
      configRevision: Number.isInteger(Number(configRevision)) ? Number(configRevision) : null,
      details: { reason: 'provider_snapshot_no_longer_resolves' },
    })
  }
  return { ...binding, env: runtimeEnv }
}

export function resolveChatModelRuntimeBinding(options = {}) {
  return resolveAgentModelRuntimeBinding({
    ...options,
    readinessAssertion: assertChatModelReady,
  })
}

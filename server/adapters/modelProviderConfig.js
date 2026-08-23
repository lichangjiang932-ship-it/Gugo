import { resolveEndpointProfile } from '../utils/endpointProfile.js'
import { resolveModelProviderRuntimeKey } from '../utils/modelProviderRuntimeBinding.js'

const REQUIRED_ENV = ['MODEL_BASE_URL', 'MODEL_NAME']

export function parseModelList(raw = '') {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function providerEnvPrefix(id = '') {
  return `MODEL_PROVIDER_${String(id).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

function parseHeaders(raw = '') {
  if (!raw) return {}
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [String(key), String(val)]))
  } catch {
    return {}
  }
}

function parseProfileOverrides(raw) {
  if (!raw) return {}
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function getModelProviders(env = process.env) {
  const ids = parseModelList(env.MODEL_PROVIDERS)
  return ids.map((id) => {
    const prefix = providerEnvPrefix(id)
    return {
      id,
      label: env[`${prefix}_LABEL`]?.trim() || '',
      baseUrl: env[`${prefix}_BASE_URL`]?.trim() || '',
      apiKey: env[`${prefix}_API_KEY`]?.trim() || '',
      models: parseModelList(env[`${prefix}_MODELS`]),
      headers: parseHeaders(env[`${prefix}_HEADERS`]),
      profileOverrides: parseProfileOverrides(env[`${prefix}_PROFILE`]),
    }
  })
}

function findProviderForModel(modelName, env = process.env, providerId = '') {
  const requestedProviderId = resolveModelProviderRuntimeKey(providerId, env)
  return getModelProviders(env).find((provider) => (
    (!requestedProviderId || provider.id === requestedProviderId)
    && provider.models.includes(modelName)
  )) || null
}

function providerMissingFields(provider) {
  const prefix = providerEnvPrefix(provider.id)
  const missing = []
  if (!provider.baseUrl) missing.push(`${prefix}_BASE_URL`)
  if (!provider.models.length) missing.push(`${prefix}_MODELS`)
  return missing
}

function parseMaxTokens(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return 0
  if (['0', 'unlimited', 'none', 'inf', 'infinite'].includes(text.toLowerCase())) return 0
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function loadModelConfig(env = process.env) {
  const providers = getModelProviders(env)
  const missing = REQUIRED_ENV.filter((key) => !env[key]?.trim())
  const temperature = Number(env.MODEL_TEMPERATURE ?? 0.7)
  const maxTokens = parseMaxTokens(env.MODEL_MAX_TOKENS)

  if (providers.length) {
    const modelName = env.MODEL_NAME?.trim() || providers.find((provider) => provider.models.length)?.models[0] || ''
    const provider = findProviderForModel(modelName, env) || providers[0]
    const providerMissing = provider ? providerMissingFields(provider) : ['MODEL_PROVIDERS']
    if (!modelName) providerMissing.unshift('MODEL_NAME')

    return {
      configured: providerMissing.length === 0,
      missing: providerMissing,
      baseUrl: provider?.baseUrl || '',
      modelName,
      apiKey: provider?.apiKey || '',
      ...(Object.keys(provider?.headers || {}).length ? { headers: provider.headers } : {}),
      ...(Object.keys(provider?.profileOverrides || {}).length
        ? { profileOverrides: provider.profileOverrides }
        : {}),
      temperature: Number.isFinite(temperature) ? temperature : 0.7,
      maxTokens,
    }
  }

  return {
    configured: missing.length === 0,
    missing,
    baseUrl: env.MODEL_BASE_URL?.trim() || '',
    modelName: env.MODEL_NAME?.trim() || '',
    apiKey: env.MODEL_API_KEY?.trim() || '',
    ...(Object.keys(parseHeaders(env.MODEL_HEADERS)).length ? { headers: parseHeaders(env.MODEL_HEADERS) } : {}),
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    maxTokens,
  }
}

export function resolveModelConfigForModel({ modelName, providerId = '', env = process.env } = {}) {
  const base = loadModelConfig(env)
  const selectedModel = modelName?.trim() || base.modelName
  const requestedProviderId = resolveModelProviderRuntimeKey(providerId, env)
  const provider = findProviderForModel(selectedModel, env, requestedProviderId)
  if (!provider) {
    const conservative = {
      ...base,
      modelName: selectedModel,
      ...(requestedProviderId ? {
        configured: false,
        missing: [`MODEL_PROVIDER_${requestedProviderId}`],
        providerId: requestedProviderId,
      } : {}),
    }
    delete conservative.profileOverrides
    delete conservative.modelProfiles
    return conservative
  }

  const missing = providerMissingFields(provider)
  const baseWithoutHeaders = { ...base }
  delete baseWithoutHeaders.headers
  delete baseWithoutHeaders.profileOverrides
  return {
    ...baseWithoutHeaders,
    configured: missing.length === 0,
    missing,
    baseUrl: provider.baseUrl,
    modelName: selectedModel,
    apiKey: provider.apiKey,
    ...(Object.keys(provider.headers || {}).length ? { headers: provider.headers } : {}),
    ...(Object.keys(provider.profileOverrides || {}).length
      ? { profileOverrides: provider.profileOverrides }
      : {}),
  }
}

export function resolveModelFailoverConfigs({ modelName, providerId = '', env = process.env } = {}) {
  const base = loadModelConfig(env)
  const selectedModel = modelName?.trim() || base.modelName
  const requestedProviderId = resolveModelProviderRuntimeKey(providerId, env)
  const primary = resolveModelConfigForModel({ modelName: selectedModel, providerId: requestedProviderId, env })
  const configs = [{
    ...primary,
    providerId: findProviderForModel(selectedModel, env, requestedProviderId)?.id || requestedProviderId || 'default',
  }]

  if (requestedProviderId) return configs.filter((config) => config.configured).slice(0, 1)

  const primaryOverrides = configs[0]?.profileOverrides || {}
  const failoverOverride = primaryOverrides.failoverEnabled === true
    || primaryOverrides.failoverEnabled === 1
    ? true
    : (primaryOverrides.failoverEnabled === false || primaryOverrides.failoverEnabled === 0 ? false : null)
  const globalCrossProviderOptIn = String(env.MODEL_FAILOVER_CROSS_PROVIDER || '').trim() === '1'
  const crossProviderOptIn = failoverOverride === true
    || (failoverOverride === null && globalCrossProviderOptIn)
  const strictSelection = String(env.MODEL_STRICT_SELECTION ?? '1').trim() !== '0'
  const crossModelOptIn = primaryOverrides.failoverEnabled === true
    || primaryOverrides.failoverEnabled === 1
  const allowCrossModel = !strictSelection && (
    String(env.MODEL_FAILOVER_CROSS_MODEL || '').trim() === '1' || crossModelOptIn
  )

  for (const provider of getModelProviders(env)) {
    if (providerMissingFields(provider).length) continue
    const hasSameModel = provider.models.includes(selectedModel)
    if (!hasSameModel && !allowCrossModel) continue
    const candidateModel = hasSameModel ? selectedModel : provider.models[0]
    if (!candidateModel) continue
    configs.push({
      ...base,
      configured: true,
      missing: [],
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      modelName: candidateModel,
      apiKey: provider.apiKey,
      ...(Object.keys(provider.headers || {}).length ? { headers: provider.headers } : {}),
      ...(Object.keys(provider.profileOverrides || {}).length
        ? { profileOverrides: provider.profileOverrides }
        : {}),
    })
  }
  const seen = new Set()
  const deduped = configs.filter((config) => {
    if (!config.configured) return false
    const key = `${config.baseUrl}\u0000${config.modelName}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const primaryProfile = deduped.length
    ? resolveEndpointProfile({
        baseUrl: deduped[0].baseUrl,
        modelName: deduped[0].modelName,
        env,
        overrides: deduped[0].profileOverrides || {},
        modelProfiles: deduped[0].modelProfiles || null,
      })
    : null
  const allowCrossProvider = crossProviderOptIn && primaryProfile?.failoverEligible !== false
  if (!allowCrossProvider && deduped.length > 1) {
    const primaryConfig = deduped[0]
    Object.defineProperty(primaryConfig, 'failoverPolicy', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        blockedProviderCount: deduped.length - 1,
        reason: failoverOverride === false || crossProviderOptIn
          ? 'primary_provider_disabled'
          : 'explicit_opt_in_required',
      }),
    })
    return [primaryConfig]
  }

  return allowCrossProvider ? deduped : deduped.slice(0, 1)
}

import { callBackgroundModelWithTools, getRuntimeEnv } from '../adapters/modelProxy.js'
import {
  buildUserModelEnv,
  getModelProvider,
  listModelProviders,
} from './modelProviderStore.js'

function runtimeError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode })
}

function providerEnvPrefix(key) {
  return `MODEL_PROVIDER_${String(key || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

function snapshotRuntimeEnv({ userId, provider = null, modelName }) {
  const runtimeEnv = buildUserModelEnv({ userId, env: getRuntimeEnv() })
  if (!provider) {
    return {
      ...runtimeEnv,
      MODEL_STRICT_SELECTION: '1',
      MODEL_FAILOVER_CROSS_MODEL: '0',
    }
  }
  const prefix = providerEnvPrefix(provider.key)
  return {
    ...runtimeEnv,
    MODEL_PROVIDERS: provider.key,
    MODEL_NAME: modelName,
    MODEL_NAMES: provider.models.join(','),
    MODEL_BASE_URL: runtimeEnv[`${prefix}_BASE_URL`] || provider.baseUrl,
    MODEL_API_KEY: runtimeEnv[`${prefix}_API_KEY`] || '',
    MODEL_STRICT_SELECTION: '1',
    MODEL_FAILOVER_CROSS_MODEL: '0',
  }
}

/**
 * Evolution records keep the database Provider id as their durable audit
 * identity. modelProxy, however, addresses providers by their environment key.
 * Resolve that boundary once without exposing credentials to the caller.
 *
 * A key that does not belong to a database Provider is retained for backwards
 * compatibility with environment-only MODEL_PROVIDERS deployments.
 */
export function resolveEvolutionModelIdentity({ userId, providerId, modelName } = {}) {
  const owner = String(userId || '').trim()
  const requestedProvider = String(providerId || '').trim()
  const requestedModel = String(modelName || '').trim()
  const providers = listModelProviders({ userId: owner })
  // Durable UUIDs are authoritative. Provider keys are user-controlled legacy
  // aliases and one key may equal another row's UUID, so resolve in two passes
  // instead of allowing list order to decide which Provider owns the request.
  const provider = providers.find((item) => item.id === requestedProvider)
    || providers.find((item) => item.key === requestedProvider)

  if (!provider) {
    return {
      providerId: requestedProvider,
      runtimeProviderId: requestedProvider,
      modelName: requestedModel,
      configRevision: null,
      source: 'environment',
      runtimeEnv: snapshotRuntimeEnv({ userId: owner, modelName: requestedModel }),
    }
  }
  if (!provider.enabled) {
    throw runtimeError(
      'EVOLUTION_MODEL_PROVIDER_DISABLED',
      'selected evolution model Provider is disabled',
    )
  }
  if (!provider.models.includes(requestedModel)) {
    throw runtimeError(
      'EVOLUTION_MODEL_NOT_AVAILABLE',
      'selected evolution model is not available from this Provider',
    )
  }
  return {
    providerId: provider.id,
    runtimeProviderId: provider.key,
    modelName: requestedModel,
    configRevision: provider.configRevision,
    source: 'database',
    runtimeEnv: snapshotRuntimeEnv({ userId: owner, provider, modelName: requestedModel }),
  }
}

export function assertEvolutionModelIdentityCurrent({ userId, identity } = {}) {
  if (!identity || identity.source !== 'database') return true
  const provider = getModelProvider({ userId, id: identity.providerId })
  if (!provider
    || !provider.enabled
    || provider.key !== identity.runtimeProviderId
    || provider.configRevision !== identity.configRevision
    || !provider.models.includes(identity.modelName)) {
    throw runtimeError(
      'EVOLUTION_MODEL_PROVIDER_CONFIG_CHANGED',
      'selected evolution model Provider configuration changed during the run',
    )
  }
  return true
}

/**
 * Call modelProxy with its key-based identity, verify the physical response,
 * then restore the durable Provider id expected by evolution provenance.
 */
export async function callEvolutionBackgroundModel({
  messages,
  userId,
  providerId,
  runtimeProviderId = providerId,
  modelName,
  signal,
  runtimeEnv = null,
  envOverrides = null,
} = {}) {
  const runtimeProvider = String(runtimeProviderId || providerId || '').trim()
  const selectedModel = String(modelName || '').trim()
  const fixedEnv = runtimeEnv && typeof runtimeEnv === 'object'
    ? { ...runtimeEnv, ...(envOverrides || {}) }
    : envOverrides && typeof envOverrides === 'object'
      ? { ...getRuntimeEnv(), ...envOverrides }
      : null
  const response = await callBackgroundModelWithTools({
    messages,
    userId: fixedEnv ? null : userId,
    usageOwnerId: userId,
    modelProviderId: runtimeProvider,
    modelName: selectedModel,
    signal,
    ...(fixedEnv ? { env: fixedEnv } : {}),
  })
  const actualRuntimeProvider = String(response?.providerId || '').trim()
  const actualModel = String(response?.modelName || '').trim()
  if (actualRuntimeProvider !== runtimeProvider || actualModel !== selectedModel) return response
  return {
    ...response,
    providerId: String(providerId || '').trim(),
  }
}

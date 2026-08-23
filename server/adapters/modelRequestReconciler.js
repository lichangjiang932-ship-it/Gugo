import { profileForConfig } from './modelEndpoint.js'
import { resolveModelConfigForModel } from './modelProviderConfig.js'
import {
  MODEL_REQUEST_RECONCILER_AUTHORITY,
  MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
} from './modelProviderRegistry.js'
import {
  getEffectiveModelProviderAdapter,
  getEffectiveModelProviderProvenance,
} from './nativeModelProviders.js'
import { fingerprintModelProviderConfig } from './modelRequestAttempt.js'
import { assertValidCompletedModelResponse } from '../utils/modelResponseValidation.js'

function normalizedRevision(value) {
  const revision = Number(value)
  return Number.isInteger(revision) && revision > 0 ? revision : null
}

function unsupported(reason) {
  return {
    contractVersion: MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
    source: 'provider',
    outcome: 'unsupported',
    receipt: { reason },
  }
}

function lastPhysicalAttempt(invocation) {
  const attempts = Array.isArray(invocation?.providerAttempts)
    ? invocation.providerAttempts
    : []
  return attempts.length > 0 ? attempts.at(-1) : null
}

function stableCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    id: String(value.id || '').trim(),
    owner: String(value.owner || '').trim(),
    version: String(value.version || '').trim(),
    revision: Number(value.revision),
    releaseDigest: value.releaseDigest == null ? null : String(value.releaseDigest).trim(),
  }
}

function sameCapability(left, right) {
  const a = stableCapability(left)
  const b = stableCapability(right)
  return JSON.stringify(a) === JSON.stringify(b)
}

function evidenceError(message) {
  const error = new Error(message)
  error.code = 'MODEL_REQUEST_RECONCILER_EVIDENCE_INVALID'
  error.retryable = false
  error.unsafeToReplay = true
  return error
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Query a provider only when its adapter explicitly implements the versioned
 * request-reconciler contract. Merely carrying an idempotency header is never
 * interpreted as proof that an upstream request is queryable or exactly-once.
 */
export async function reconcileModelRequestWithProvider({
  invocation,
  modelName = null,
  modelProviderId = null,
  modelConfigRevision = null,
  env = process.env,
} = {}) {
  const providerId = String(modelProviderId || '').trim() || null
  const selectedModel = String(modelName || '').trim() || null
  const configRevision = normalizedRevision(modelConfigRevision)
  if (!invocation || typeof invocation !== 'object') return unsupported('invocation_missing')
  if (invocation.providerId !== providerId
    || invocation.modelName !== selectedModel
    || normalizedRevision(invocation.configRevision) !== configRevision) {
    const error = new Error('model request binding changed before reconciliation')
    error.code = 'MODEL_REQUEST_CONTEXT_DRIFT'
    error.retryable = false
    throw error
  }

  const physicalAttempt = lastPhysicalAttempt(invocation)
  const actualProviderId = String(physicalAttempt?.providerId || providerId || '').trim() || null
  const actualModelName = String(physicalAttempt?.modelName || selectedModel || '').trim() || null
  // `default` is the persisted identity of the single global BYOK Provider,
  // not a named MODEL_PROVIDER_DEFAULT_* entry. Resolve it through the same
  // global MODEL_BASE_URL / MODEL_NAME path used when the request was sent.
  // Named failover Providers must keep their exact id so drift checks still
  // compare against the physical Provider that received the request.
  const configProviderId = actualProviderId === 'default' ? null : actualProviderId
  const config = resolveModelConfigForModel({
    modelName: actualModelName || '',
    providerId: configProviderId || '',
    env,
  })
  if (!config?.configured) return unsupported('provider_configuration_unavailable')
  config.providerId = actualProviderId || 'default'
  const profile = profileForConfig(config, env)
  const currentCapability = getEffectiveModelProviderProvenance(profile.kind)
  if (physicalAttempt && (
    physicalAttempt.providerKind !== profile.kind
    || physicalAttempt.configFingerprint !== fingerprintModelProviderConfig({ config, profile })
  )) {
    const error = new Error('physical model Provider configuration changed before reconciliation')
    error.code = 'MODEL_REQUEST_CONTEXT_DRIFT'
    error.retryable = false
    throw error
  }
  if ((physicalAttempt?.providerCapability || currentCapability)
    && !sameCapability(physicalAttempt?.providerCapability, currentCapability)) {
    const error = new Error('physical model Provider plugin release changed before reconciliation')
    error.code = 'MODEL_REQUEST_CONTEXT_DRIFT'
    error.retryable = false
    throw error
  }
  if (currentCapability?.owner !== 'builtin' && !currentCapability?.releaseDigest) {
    return unsupported('plugin_provider_release_unverified')
  }
  const reconciler = getEffectiveModelProviderAdapter(profile?.kind)?.requestReconciler || null
  if (!reconciler) return unsupported('provider_reconciler_not_registered')
  if (reconciler.contractVersion !== MODEL_REQUEST_RECONCILER_CONTRACT_VERSION) {
    return unsupported('provider_reconciler_version_mismatch')
  }
  if (reconciler.authority !== MODEL_REQUEST_RECONCILER_AUTHORITY) {
    return unsupported('provider_reconciler_not_authoritative')
  }

  const result = await reconciler.reconcile({
    contractVersion: MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
    request: {
      id: invocation.id,
      idempotencyKey: invocation.idempotencyKey,
      fingerprint: invocation.fingerprint,
      iteration: invocation.iteration,
      attempt: invocation.attempt,
      ...(physicalAttempt ? { physicalAttempt } : {}),
    },
    provider: {
      id: actualProviderId,
      kind: profile.kind,
      modelName: actualModelName,
      configRevision,
      ...(physicalAttempt ? {
        logicalProviderId: providerId,
        logicalModelName: selectedModel,
      } : {}),
    },
    // Runtime-only credentials/configuration are available to the provider
    // adapter for its authoritative query, but are never returned or persisted
    // by this dispatcher.
    config: {
      ...config,
      providerId: actualProviderId,
      profile,
    },
  })
  const normalizedResult = result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : {}
  const outcome = String(normalizedResult.outcome || '').trim()
  const decisive = outcome === 'completed' || outcome === 'not_sent'
  if (decisive) {
    if (normalizedResult.authoritative !== true) {
      throw evidenceError('decisive model request reconciliation must be authoritative')
    }
    if (!isPlainObject(normalizedResult.receipt) || Object.keys(normalizedResult.receipt).length === 0) {
      throw evidenceError('decisive model request reconciliation requires a non-empty receipt')
    }
    if (outcome === 'completed') {
      try {
        assertValidCompletedModelResponse(normalizedResult.response)
      } catch (cause) {
        const error = evidenceError(cause?.message || 'completed model reconciliation response is invalid')
        error.cause = cause
        throw error
      }
    }
  }
  const verification = {
    modelRequestId: invocation.id,
    idempotencyKey: invocation.idempotencyKey,
    requestFingerprint: invocation.fingerprint,
    providerId: actualProviderId,
    modelName: actualModelName,
    configFingerprint: physicalAttempt?.configFingerprint
      || fingerprintModelProviderConfig({ config, profile }),
    physicalAttemptSequence: physicalAttempt?.sequence ?? null,
    providerCapability: stableCapability(currentCapability),
  }
  return {
    ...normalizedResult,
    contractVersion: MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
    source: 'provider',
    ...(decisive ? { authoritative: true, verification } : {}),
  }
}

import { createHash } from 'node:crypto'

export const MODEL_PROVIDER_ATTEMPT_VERSION = 1

function normalizeProviderCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = String(value.id || '').trim()
  const owner = String(value.owner || '').trim()
  const version = String(value.version || '').trim()
  const revision = Number(value.revision)
  const releaseDigest = value.releaseDigest == null ? null : String(value.releaseDigest).trim()
  if (!id || id.length > 128 || !owner || owner.length > 128
    || !version || version.length > 128
    || !Number.isSafeInteger(revision) || revision < 1
    || (releaseDigest !== null && !/^sha256-(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/iu.test(releaseDigest))) {
    throw new TypeError('model Provider capability identity is invalid')
  }
  return Object.freeze({ id, owner, version, revision, releaseDigest })
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export function fingerprintModelProviderEndpoint(requestUrl) {
  return fingerprint({ requestUrl: String(requestUrl || '').trim() })
}

export function fingerprintModelProviderConfig({ config, profile } = {}) {
  const providerId = String(config?.providerId || 'default').trim() || 'default'
  const modelName = String(config?.modelName || '').trim()
  const providerKind = String(profile?.kind || 'openai-compatible').trim() || 'openai-compatible'
  return fingerprint({
    providerId,
    modelName,
    providerKind,
    baseUrl: String(config?.baseUrl || '').trim(),
    apiKey: String(config?.apiKey || ''),
    headers: config?.headers || {},
    profileOverrides: config?.profileOverrides || {},
  })
}

/**
 * Build a secret-free identity for one physical Provider request.
 *
 * Raw URLs, API keys and headers are never persisted. Their hashes still let
 * recovery reject a Provider configuration that drifted after the request was
 * sent, including a failover Provider that differs from the logical binding.
 */
export function createModelProviderAttempt({
  config,
  profile,
  requestUrl,
  providerCapability = null,
  physicalAttempt,
  providerAttempt,
  failoverIndex,
} = {}) {
  const providerId = String(config?.providerId || 'default').trim() || 'default'
  const modelName = String(config?.modelName || '').trim()
  const providerKind = String(profile?.kind || 'openai-compatible').trim() || 'openai-compatible'
  const sequence = Number(physicalAttempt)
  const candidateAttempt = Number(providerAttempt)
  const candidateIndex = Number(failoverIndex)
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('physical model attempt must be a positive safe integer')
  }
  if (!Number.isSafeInteger(candidateAttempt) || candidateAttempt < 1) {
    throw new TypeError('Provider attempt must be a positive safe integer')
  }
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0) {
    throw new TypeError('Provider failover index must be a non-negative safe integer')
  }
  if (!modelName) throw new TypeError('physical model attempt requires modelName')

  return Object.freeze({
    version: MODEL_PROVIDER_ATTEMPT_VERSION,
    sequence,
    providerAttempt: candidateAttempt,
    failoverIndex: candidateIndex,
    providerId,
    modelName,
    providerKind,
    endpointFingerprint: fingerprintModelProviderEndpoint(requestUrl),
    configFingerprint: fingerprintModelProviderConfig({ config, profile }),
    ...(providerCapability ? { providerCapability: normalizeProviderCapability(providerCapability) } : {}),
  })
}

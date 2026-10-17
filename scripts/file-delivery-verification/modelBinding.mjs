import { isAbsolute } from 'node:path'
import { withDiagnosticRuntimeScope } from '../../server/core/diagnosticRuntimeScope.js'
import { providersFromSettings, readDefaultModel, readSettings } from '../../server/llm/llmConfigStore.js'

const MESSAGES = Object.freeze({
  FILE_DELIVERY_MODEL_OPT_IN_REQUIRED: 'Trusted-host model access requires enabled: true.',
  FILE_DELIVERY_MODEL_DATABASE_UNAVAILABLE: 'Database-backed defaults require a safe provider-only read port; none is enabled here.',
  FILE_DELIVERY_MODEL_DEFAULT_MISSING: 'No explicit current default model and provider can be established.',
  FILE_DELIVERY_MODEL_PROVIDER_DISABLED: 'The default provider is disabled.',
  FILE_DELIVERY_MODEL_MODEL_DISABLED: 'The default model is disabled or absent from its provider.',
  FILE_DELIVERY_MODEL_AMBIGUOUS: 'The default model matches multiple providers or colliding provider keys.',
  FILE_DELIVERY_MODEL_VAULT_UNAVAILABLE: 'An existing, explicitly located credential fingerprint key is required; no key will be created.',
  FILE_DELIVERY_MODEL_SOURCE_CHANGED: 'The default binding changed during read-only resolution.',
  FILE_DELIVERY_MODEL_UNAVAILABLE: 'The current default cannot be safely resolved for Agent use.',
})
const READINESS_CODES = new Set([
  'MODEL_CONFIG_MISSING', 'MODEL_PROVIDER_NOT_FOUND', 'MODEL_PROVIDER_DISABLED',
  'MODEL_PROVIDER_MODEL_INVALID', 'MODEL_PROVIDER_UNVERIFIED', 'MODEL_PROVIDER_CHAT_ONLY',
  'MODEL_PROVIDER_UNAVAILABLE', 'MODEL_PROVIDER_CONFIG_CHANGED', 'MODEL_PROVIDER_BINDING_MISSING',
  'MODEL_PROVIDER_AMBIGUOUS',
])
const PROFILE_KEYS = [
  'kind', 'contextWindow', 'maxOutputTokens', 'supportsTools', 'supportsStreaming',
  'supportsVision', 'supportsPdf', 'supportsParallelTools', 'supportsPromptCaching',
  'supportsReasoning', 'firstTokenTimeoutMs', 'idleTimeoutMs', 'requestTimeoutMs',
  'backgroundTimeoutMs', 'failoverEnabled', 'keepAlive', 'source', 'sourceUrl', 'verifiedAt',
]

export class FileDeliveryModelBindingError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) || READINESS_CODES.has(code)
      ? code : 'FILE_DELIVERY_MODEL_UNAVAILABLE'
    super(MESSAGES[safeCode] || MESSAGES.FILE_DELIVERY_MODEL_UNAVAILABLE)
    this.name = 'FileDeliveryModelBindingError'
    this.code = safeCode
  }
}

function fail(code) { throw new FileDeliveryModelBindingError(code) }
function text(value) { return String(value || '').trim() }
function prefix(id) { return `MODEL_PROVIDER_${text(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` }
function pickScalars(value, keys) {
  return Object.fromEntries(keys.filter(key => ['string', 'boolean', 'number'].includes(typeof value?.[key]))
    .map(key => [key, value[key]]))
}

// This is a denial port, not an empty/fabricated database. Even an import-time
// getDb() must fail rather than initialize the host DB or enumerate sessions.
const deniedDatabase = Object.freeze({ prepare() { fail('FILE_DELIVERY_MODEL_DATABASE_UNAVAILABLE') } })

async function loadProductionRuntime() {
  const [readiness, config, endpoint] = await Promise.all([
    import('../../server/services/modelReadinessService.js'),
    import('../../server/adapters/modelProviderConfig.js'),
    import('../../server/adapters/modelEndpoint.js'),
  ])
  return {
    resolveAgentModelRuntimeBinding: readiness.resolveAgentModelRuntimeBinding,
    getModelProviders: config.getModelProviders,
    resolveModelConfigForModel: config.resolveModelConfigForModel,
    profileForConfig: endpoint.profileForConfig,
  }
}

function selectedModelProfiles(config, modelName) {
  for (const source of [config.modelProfiles, config.profileOverrides?.modelProfiles, config.profileOverrides?.models]) {
    const entry = Array.isArray(source)
      ? source.find(item => text(item?.id || item?.model) === modelName)
      : source?.[modelName]
    if (entry && typeof entry === 'object') return { [modelName]: Object.freeze(pickScalars(entry, PROFILE_KEYS)) }
  }
  return {}
}

function selectDefault(settings, env, providers) {
  const saved = readDefaultModel(settings)
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) fail('FILE_DELIVERY_MODEL_AMBIGUOUS')
  const environmentModel = text(env.MODEL_NAME)
  const modelName = environmentModel || text(saved.model)
  if (!modelName) fail('FILE_DELIVERY_MODEL_DEFAULT_MISSING')
  const matches = providers.filter(provider => provider.models.includes(modelName))
  let provider
  if (environmentModel) {
    if (matches.length > 1) fail('FILE_DELIVERY_MODEL_AMBIGUOUS')
    provider = matches[0]
    if (!provider && providers.length) fail('FILE_DELIVERY_MODEL_MODEL_DISABLED')
    if (!provider && !text(env.MODEL_BASE_URL)) fail('FILE_DELIVERY_MODEL_DEFAULT_MISSING')
  } else {
    if (!text(saved.provider)) fail('FILE_DELIVERY_MODEL_DEFAULT_MISSING')
    provider = matches.find(item => item.id === text(saved.provider))
    if (!provider) fail('FILE_DELIVERY_MODEL_MODEL_DISABLED')
  }
  if (provider) {
    if (providers.filter(item => prefix(item.id) === prefix(provider.id)).length !== 1) {
      fail('FILE_DELIVERY_MODEL_AMBIGUOUS')
    }
    // Environment namespaces override settings with the same id in production.
    const environmentIds = text(env.MODEL_PROVIDERS).split(',').map(text)
    const stored = providersFromSettings(settings)[provider.id]
    if (!environmentIds.includes(provider.id) && stored?.enabled === false) fail('FILE_DELIVERY_MODEL_PROVIDER_DISABLED')
    if (provider.enabled === false) fail('FILE_DELIVERY_MODEL_PROVIDER_DISABLED')
  }
  return { modelName, providerId: provider?.id || '', provider }
}

function diagnosticEnv(env) {
  // credentialVault merges process.env internally. Explicit empty entries stop
  // an injected env from accidentally inheriting the host's vault configuration.
  return {
    ...env,
    CREDENTIAL_ENCRYPTION_KEY: text(env.CREDENTIAL_ENCRYPTION_KEY),
    CREDENTIAL_KEY_PATH: text(env.CREDENTIAL_KEY_PATH),
    APP_DB_PATH: text(env.APP_DB_PATH),
    APP_DATA_DIR: text(env.APP_DATA_DIR),
  }
}

function requireExistingVaultLocator(env) {
  if (text(env.CREDENTIAL_ENCRYPTION_KEY)) return
  const locator = text(env.CREDENTIAL_KEY_PATH) || text(env.APP_DB_PATH) || text(env.APP_DATA_DIR)
  if (!locator || !isAbsolute(locator)) fail('FILE_DELIVERY_MODEL_VAULT_UNAVAILABLE')
}

function transportFromConfig(config, selected, profile) {
  const modelProfiles = selectedModelProfiles(config, selected.modelName)
  return Object.freeze({
    providerKey: selected.providerId,
    modelName: selected.modelName,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || '',
    headers: Object.freeze(Object.fromEntries(Object.entries(config.headers || {})
      .filter(([, value]) => typeof value === 'string'))),
    profileOverrides: Object.freeze(pickScalars(config.profileOverrides, PROFILE_KEYS)),
    modelProfiles: Object.freeze(modelProfiles),
    // The production endpoint profile contains capabilities/timeouts, not env.
    profile: Object.freeze(profile),
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  })
}

/**
 * Trusted-host only. No CLI, dotenv, network, database opening, writes or logging.
 * enabled must be boolean true; a string/env flag is intentionally insufficient.
 * Reads only the standard settings/credential files, the optional local
 * models.dev metadata cache (production resolver), and an explicitly located
 * existing vault key. A caller may pass an already-exported environment, never
 * an .env filename. No model/provider override is accepted: this binds only the
 * current explicit default. Database defaults are deliberately unsupported.
 *
 * The result is SECRET IN-MEMORY MATERIAL for a trusted isolated worker only.
 * Never put transport in reports/logs/artifacts or serialize it to disk. Build
 * the worker's single-provider env from transport, not the host/binding env.
 * dependencies is a trusted test seam, never model/HTTP/user-controlled input.
 */
export async function resolveFileDeliveryModelBinding(options = {}, dependencies = {}) {
  if (options.enabled !== true) fail('FILE_DELIVERY_MODEL_OPT_IN_REQUIRED')
  try {
    if (options.userId != null) fail('FILE_DELIVERY_MODEL_DATABASE_UNAVAILABLE')
    const env = diagnosticEnv(options.env ?? process.env)
    const settings = (dependencies.readSettings || readSettings)(env)
    return await withDiagnosticRuntimeScope({ database: deniedDatabase, env }, async () => {
      const runtime = await (dependencies.loadRuntime || loadProductionRuntime)()
      const selected = selectDefault(settings, env, runtime.getModelProviders(env))
      if (selected.provider) requireExistingVaultLocator(env)
      const binding = runtime.resolveAgentModelRuntimeBinding({
        userId: null, providerId: selected.providerId, modelName: selected.modelName, env,
      })
      if (binding.source !== 'environment'
        || text(binding.providerId) !== selected.providerId || binding.modelName !== selected.modelName) {
        fail('FILE_DELIVERY_MODEL_SOURCE_CHANGED')
      }
      const config = runtime.resolveModelConfigForModel({
        modelName: binding.modelName, providerId: selected.providerId, env: binding.env,
      })
      if (!config.configured || !config.baseUrl || config.modelName !== selected.modelName
        || text(config.providerId) !== selected.providerId) fail('FILE_DELIVERY_MODEL_SOURCE_CHANGED')
      if (selected.provider && (config.baseUrl !== selected.provider.baseUrl || config.apiKey !== selected.provider.apiKey)) {
        fail('FILE_DELIVERY_MODEL_SOURCE_CHANGED')
      }
      const profile = runtime.profileForConfig(config, binding.env)
      if (profile.supportsTools !== true) fail('MODEL_PROVIDER_CHAT_ONLY')
      return Object.freeze({
        binding: Object.freeze({
          providerId: selected.providerId || null,
          modelName: binding.modelName,
          configRevision: binding.configRevision,
          source: binding.source,
        }),
        transport: transportFromConfig(config, selected, profile),
      })
    })
  } catch (error) {
    // No cause/details/provider URLs/raw YAML/vault errors may escape this edge.
    if (error instanceof FileDeliveryModelBindingError) fail(error.code)
    if (READINESS_CODES.has(error?.code)) fail(error.code)
    if (String(error?.code || '').startsWith('CREDENTIAL_VAULT_')) fail('FILE_DELIVERY_MODEL_VAULT_UNAVAILABLE')
    fail('FILE_DELIVERY_MODEL_UNAVAILABLE')
  }
}

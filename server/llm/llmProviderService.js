import {
  credentialDescriptor,
  LLM_SETTINGS_NAMESPACE,
  providersFromSettings,
  readCredentials,
  readDefaultModel,
  readSettings,
  redactSecrets,
  resolveApiKey,
  writeCredentials,
  writeSettings,
} from './llmConfigStore.js'
import {
  isValidProviderId,
  isSupportedProtocol,
  LLM_PROTOCOLS,
  LOCAL_PROVIDER_PRESETS,
  presetProviderConfig,
  PROVIDER_CATALOG,
} from '../../shared/llmProviderCatalog.js'

const PROBE_TIMEOUT_MS = 8000

export function listCatalog() {
  return { protocols: LLM_PROTOCOLS, cloud: PROVIDER_CATALOG, local: LOCAL_PROVIDER_PRESETS }
}

function authHeaders(provider = {}, apiKey = '') {
  const key = String(apiKey || '').trim()
  if (!key) return {}
  return provider.api === 'anthropic-messages'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` }
}

/** Never contains a key: the descriptor is what the UI shows. */
export function publicProviderView(id, provider = {}, { defaultModel = {}, credentials = {}, env = process.env } = {}) {
  const resolved = resolveApiKey(id, provider, { env, credentials })
  return {
    id,
    displayName: String(provider.displayName || id),
    api: String(provider.api || 'openai-completions'),
    baseURL: String(provider.baseURL || ''),
    apiKeyEnv: String(provider.apiKeyEnv || ''),
    autoProbe: provider.autoProbe === true,
    custom: provider.custom === true,
    models: Array.isArray(provider.models) ? provider.models.map((model) => ({ ...model })) : [],
    credential: {
      configured: Boolean(resolved.apiKey),
      source: resolved.source,
      descriptor: credentialDescriptor(resolved.apiKey),
    },
    isDefault: defaultModel.provider === id,
  }
}

export function listProviders(env = process.env) {
  const settings = readSettings(env)
  const credentials = readCredentials(env)
  const defaultModel = readDefaultModel(settings)
  return {
    defaultModel,
    providers: Object.entries(providersFromSettings(settings))
      .map(([id, provider]) => publicProviderView(id, provider, { defaultModel, credentials, env })),
  }
}

function requireProtocol(api) {
  if (!isSupportedProtocol(api)) throw Object.assign(new Error('LLM_PROTOCOL_UNSUPPORTED'), { code: 'LLM_PROTOCOL_UNSUPPORTED' })
}

function normalizeModels(models) {
  const seen = new Set()
  const normalized = []
  for (const model of Array.isArray(models) ? models : []) {
    const id = String(typeof model === 'string' ? model : model?.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    normalized.push({ ...(typeof model === 'object' && model ? model : {}), id })
  }
  return normalized
}

export function upsertProvider(input = {}, env = process.env) {
  const id = String(input.id || '').trim().toLowerCase()
  if (!isValidProviderId(id)) throw Object.assign(new Error('LLM_PROVIDER_ID_INVALID'), { code: 'LLM_PROVIDER_ID_INVALID' })
  if (input.apiKey) throw Object.assign(new Error('LLM_PROVIDER_KEY_IN_FORBIDDEN'), { code: 'LLM_PROVIDER_KEY_IN_FORBIDDEN' })
  const preset = presetProviderConfig(id) || {}
  const api = String(input.api || preset.api || 'openai-completions')
  requireProtocol(api)
  const previous = providersFromSettings(readSettings(env))[id] || {}
  const provider = {
    displayName: String(input.displayName || previous.displayName || preset.displayName || id),
    api,
    baseURL: String(input.baseURL ?? previous.baseURL ?? preset.baseURL ?? ''),
    apiKeyEnv: String(input.apiKeyEnv ?? previous.apiKeyEnv ?? preset.apiKeyEnv ?? ''),
    models: normalizeModels(input.models ?? previous.models ?? preset.models),
    ...(input.custom === true || previous.custom === true ? { custom: true } : {}),
    ...(input.autoProbe === true || previous.autoProbe === true ? { autoProbe: true } : {}),
  }
  const settings = readSettings(env)
  const providers = { ...providersFromSettings(settings), [id]: provider }
  writeSettings({ ...settings, [LLM_SETTINGS_NAMESPACE]: { ...(settings[LLM_SETTINGS_NAMESPACE] || {}), providers } }, env)
  return publicProviderView(id, provider, { defaultModel: readDefaultModel(settings), credentials: readCredentials(env), env })
}

export function removeProvider(id, env = process.env) {
  const settings = readSettings(env)
  const providers = { ...providersFromSettings(settings) }
  if (!providers[id]) return false
  delete providers[id]
  const next = { ...settings, [LLM_SETTINGS_NAMESPACE]: { ...(settings[LLM_SETTINGS_NAMESPACE] || {}), providers } }
  if (readDefaultModel(settings).provider === id) delete next['agent-default-model']
  writeSettings(next, env)
  const credentials = readCredentials(env)
  if (credentials?.providers?.[id]) {
    const remaining = { ...credentials.providers }
    delete remaining[id]
    writeCredentials({ ...credentials, providers: remaining }, env)
  }
  return true
}

export function setCredential(id, apiKey, env = process.env) {
  const value = String(apiKey || '').trim()
  const credentials = readCredentials(env)
  const providers = { ...(credentials.providers || {}) }
  if (value) providers[id] = { apiKey: value, savedAt: new Date().toISOString() }
  else delete providers[id]
  writeCredentials({ ...credentials, version: credentials.version || 1, providers }, env)
  return credentialDescriptor(value)
}

export function setDefaultModel({ provider, model } = {}, env = process.env) {
  const settings = readSettings(env)
  const providerId = String(provider || '').trim()
  const modelId = String(model || '').trim()
  if (!providerId || !modelId) throw Object.assign(new Error('LLM_DEFAULT_MODEL_INVALID'), { code: 'LLM_DEFAULT_MODEL_INVALID' })
  writeSettings({ ...settings, 'agent-default-model': { provider: providerId, model: modelId } }, env)
  return { provider: providerId, model: modelId }
}

export function addModel(id, modelId, env = process.env) {
  const provider = providersFromSettings(readSettings(env))[id]
  if (!provider) throw Object.assign(new Error('LLM_PROVIDER_NOT_FOUND'), { code: 'LLM_PROVIDER_NOT_FOUND' })
  const models = normalizeModels([...normalizeModels(provider.models), { id: modelId }])
  return upsertProvider({ id, models }, env)
}

export function removeModel(id, modelId, env = process.env) {
  const provider = providersFromSettings(readSettings(env))[id]
  if (!provider) throw Object.assign(new Error('LLM_PROVIDER_NOT_FOUND'), { code: 'LLM_PROVIDER_NOT_FOUND' })
  return upsertProvider({ id, models: normalizeModels(provider.models).filter((model) => model.id !== modelId) }, env)
}

function parseProbePayload(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  return data.map((entry) => String(entry?.id || entry?.name || '').trim()).filter(Boolean)
}

/**
 * Ask the endpoint what it serves. Only the provider's own baseURL is ever
 * called, the key travels in the protocol's own header, and a failure is
 * reported with any secret already scrubbed out of it.
 */
async function fetchModelList({ baseURL, provider = {}, apiKey = '', fetchImpl }) {
  const endpoint = String(baseURL || '').replace(/\/+$/u, '')
  if (!endpoint) throw Object.assign(new Error('LLM_PROVIDER_URL_MISSING'), { code: 'LLM_PROVIDER_URL_MISSING' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${endpoint}/models`, {
      headers: { accept: 'application/json', ...authHeaders(provider, apiKey) },
      signal: controller.signal,
    })
    if (!response.ok) throw Object.assign(new Error('LLM_PROBE_HTTP_ERROR'), { code: 'LLM_PROBE_HTTP_ERROR' })
    return parseProbePayload(await response.json())
  } catch (error) {
    const message = redactSecrets(error?.message || error, [apiKey])
    throw Object.assign(new Error(message || 'LLM_PROBE_FAILED'), { code: error?.code || 'LLM_PROBE_FAILED' })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe a provider that is not saved yet: the add panel asks the endpoint what
 * it serves before anything is written, so "获取可用模型" works on the form the
 * user is still filling in. Nothing is persisted here.
 */
export async function probeDraftModels({ baseURL = '', api = 'openai-completions', apiKey = '' } = {}, { fetchImpl = globalThis.fetch } = {}) {
  requireProtocol(api)
  const discovered = await fetchModelList({ baseURL, provider: { api }, apiKey, fetchImpl })
  return { discovered }
}

export async function probeModels(id, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const provider = providersFromSettings(readSettings(env))[id]
  if (!provider) throw Object.assign(new Error('LLM_PROVIDER_NOT_FOUND'), { code: 'LLM_PROVIDER_NOT_FOUND' })
  const { apiKey } = resolveApiKey(id, provider, { env })
  const discovered = await fetchModelList({ baseURL: provider.baseURL, provider, apiKey, fetchImpl })
  const merged = normalizeModels([...normalizeModels(provider.models), ...discovered.map((modelId) => ({ id: modelId }))])
  upsertProvider({ id, models: merged }, env)
  return { discovered, merged: merged.map((model) => model.id) }
}

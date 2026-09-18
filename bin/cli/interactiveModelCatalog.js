import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { CliUsageError } from './errors.js'
import { getModelProviders, parseModelList } from '../../server/adapters/modelProviderConfig.js'

const CACHE_VERSION = 2
const MAX_ENTRIES = 500
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const safeText = (value) => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 256) : ''

function publicProfile(value = {}) {
  return Object.fromEntries(['kind', 'contextWindow', 'supportsTools', 'supportsStreaming', 'supportsVision', 'supportsPdf']
    .filter((key) => ['string', 'number', 'boolean'].includes(typeof value?.[key]))
    .map((key) => [key, value[key]]))
}

/** Only public selection identity is persisted; never endpoints, headers or secrets. */
export function modelCatalogEntries(providers = []) {
  const found = new Map()
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = safeText(provider.id) || null
    const providerKey = safeText(provider.key) || null
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      const modelName = safeText(model)
      if (!modelName) continue
      const key = JSON.stringify([providerId, modelName])
      if (found.has(key)) continue
      const readiness = provider.modelReadiness?.[modelName]
      found.set(key, Object.freeze({
        providerId, providerKey, modelName,
        displayName: `${safeText(provider.label) || providerKey || providerId || 'environment'} · ${modelName}`,
        value: providerId ? `${providerId}/${modelName}` : modelName,
        enabled: provider.enabled !== false,
        configRevision: Number.isSafeInteger(provider.configRevision) ? provider.configRevision : null,
        readiness: readiness ? {
          agent: readiness.agent === true, tools: readiness.tools === true,
          checkedAt: Number(readiness.checkedAt) > 0 ? Number(readiness.checkedAt) : null,
        } : null,
        profile: publicProfile(provider.modelProfiles?.[modelName] || provider.profileOverrides || provider),
      }))
      if (found.size === MAX_ENTRIES) return [...found.values()]
    }
  }
  return [...found.values()]
}

async function readLocalProviders({ userId, env }) {
  const { listModelProviders, buildUserModelEnv } = await import('../../server/services/modelProviderStore.js')
  const saved = listModelProviders({ userId })
  // Use the runtime's namespace merge: enabled saved Providers override their
  // own environment namespace, not every separately configured local endpoint.
  // Keep saved rows for durable UUID/revision/readiness and disabled diagnostics.
  const savedKeys = new Set(saved.filter((provider) => provider.enabled).map((provider) => provider.key))
  const named = getModelProviders(buildUserModelEnv({ userId, env }))
    .filter((provider) => !savedKeys.has(provider.id))
  if (saved.length || named.length) return [...saved, ...named]
  const models = [...new Set([...parseModelList(env.MODEL_NAMES), ...parseModelList(env.GUGO_DEFAULT_MODELS),
    safeText(env.MODEL_NAME), safeText(env.GUGO_MODEL)].filter(Boolean))]
  return models.length ? [{ id: null, label: 'environment', models, enabled: true }] : []
}

function qualifiedSelection(entry, value) {
  return entry.value === value || (entry.providerKey && `${entry.providerKey}/${entry.modelName}` === value)
}

function rejectUnavailableSelection(entries, value) {
  if (entries.some((entry) => entry.modelName === value || qualifiedSelection(entry, value))) {
    throw new CliUsageError('MODEL_PROVIDER_DISABLED', 'The selected Provider is disabled.')
  }
  if (!value.includes('/')) return
  const prefix = value.slice(0, value.indexOf('/'))
  const providers = entries.filter((entry) => entry.providerId === prefix || entry.providerKey === prefix)
  if (providers.length && !providers.some((entry) => entry.enabled)) {
    throw new CliUsageError('MODEL_PROVIDER_DISABLED', 'The selected Provider is disabled.')
  }
  throw new CliUsageError(providers.length ? 'MODEL_PROVIDER_MODEL_INVALID' : 'MODEL_PROVIDER_NOT_FOUND',
    'The qualified selection is not in the current catalog. Select an available Provider/model entry; slash model names must be explicitly configured.')
}

function readCache(filePath, scope, now) {
  if (!filePath) return []
  try {
    if (statSync(filePath).size > 512 * 1024) return []
    const value = JSON.parse(readFileSync(filePath, 'utf8'))
    if (value.version !== CACHE_VERSION || value.scope !== scope || !Number.isFinite(value.updatedAt)
      || value.updatedAt > now || now - value.updatedAt > CACHE_TTL_MS || !Array.isArray(value.entries)) return []
    // Re-normalize cached data rather than trusting arbitrary cache fields as identity.
    return value.entries.slice(0, MAX_ENTRIES).flatMap((entry) => modelCatalogEntries([{
      id: entry.providerId, key: entry.providerKey, models: [entry.modelName], enabled: entry.enabled,
      configRevision: entry.configRevision,
    }]))
  } catch { return [] }
}

function persistCache(filePath, scope, entries, now) {
  if (!filePath) return false
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, scope, updatedAt: now, entries }), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, filePath)
    return true
  } catch { return false }
  finally { try { rmSync(temporary, { force: true }) } catch { /* Only this generated sibling. */ } }
}

export function selectCatalogModel(entries, requested, { currentProviderId = null } = {}) {
  const value = String(requested ?? '').trim()
  if (!value) throw new CliUsageError('CLI_MODEL_REQUIRED', 'a model selection is required')
  const active = entries.filter((entry) => entry.enabled)
  // Exact model names win, so models such as qwen/model are never guessed to be providers.
  const named = active.filter((entry) => entry.modelName === value)
  const qualified = active.filter((entry) => qualifiedSelection(entry, value))
  const candidates = named.length ? named : qualified
  if (candidates.length > 1) {
    const bound = candidates.find((entry) => entry.providerId === currentProviderId)
    if (bound) return bound
    throw new CliUsageError('MODEL_PROVIDER_AMBIGUOUS', 'More than one Provider has this model. Select its qualified catalog entry.')
  }
  if (candidates.length === 1) return candidates[0]
  rejectUnavailableSelection(entries, value)
  // Preserve unqualified legacy entry, but never erase an unknown/deleted
  // Provider qualifier and route its prompt through the default endpoint.
  return { modelName: value, providerId: currentProviderId }
}

export function createInteractiveModelCatalog({ userId, env = {}, readProviders = readLocalProviders, now = Date.now } = {}) {
  const scope = createHash('sha256').update(JSON.stringify([userId || null,
    path.resolve(env.APP_DATA_DIR || '.'), env.APP_DB_PATH || null])).digest('hex')
  const filePath = userId && env.APP_DATA_DIR ? path.join(env.APP_DATA_DIR, `model-catalog-${scope}.json`) : null
  let entries = readCache(filePath, scope, now())
  let status = entries.length ? 'cache' : 'empty'
  let refreshing = null
  let closed = false
  let observedAt = null
  return {
    entries: () => entries.map((entry) => ({ ...entry })),
    list: () => entries.filter((entry) => entry.enabled).map((entry) => entry.value),
    diagnostics: () => ({ source: status, lastSuccessfulRefresh: observedAt, cached: status === 'cache' || status === 'stale' }),
    close() { closed = true },
    refresh() {
      if (closed) return Promise.resolve(false)
      if (refreshing) return refreshing
      refreshing = Promise.resolve().then(() => readProviders({ userId, env })).then((providers) => {
        if (closed) return false
        if (!Array.isArray(providers)) throw new TypeError('invalid model catalog')
        const next = modelCatalogEntries(providers)
        const changed = JSON.stringify(next) !== JSON.stringify(entries)
        entries = next // An authoritative empty catalog removes deleted models.
        status = 'local'
        observedAt = now()
        persistCache(filePath, scope, entries, observedAt)
        return changed
      }).catch(() => { if (!closed) status = entries.length ? 'stale' : 'unavailable'; return false })
        .finally(() => { refreshing = null })
      return refreshing
    },
    async select(value, options) {
      await this.refresh()
      if (closed || status !== 'local') throw new CliUsageError('CLI_MODEL_CATALOG_UNAVAILABLE',
        'Current model configuration could not be read. Cached names are display-only; retry when configuration is available.')
      if (value && typeof value === 'object') {
        const entry = entries.find((item) => item.providerId === value.providerId && item.modelName === value.modelName)
        if (!entry || !entry.enabled || entry.configRevision !== value.configRevision) {
          throw new CliUsageError('MODEL_PROVIDER_CONFIG_CHANGED', 'The selected model configuration changed. Open the model picker again.')
        }
        return entry
      }
      return selectCatalogModel(entries, value, options)
    },
  }
}

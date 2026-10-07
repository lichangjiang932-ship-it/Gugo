import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readSettings, resolveGugoHome } from './llmConfigStore.js'

/**
 * models.dev metadata, cached locally.
 *
 * The cache is a plain file so it survives restarts and so an offline machine
 * still has names/context windows. Listing providers never fetches: it reads
 * whatever is cached, and a refresh is an explicit act. A corrupt or missing
 * cache is simply "no metadata", never an error the UI has to handle.
 */
export const MODELS_DEV_FILE = 'models-dev.cache.json'
export const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json'
export const DEFAULT_CACHE_TTL_HOURS = 24

export function modelsDevPath(env = process.env) {
  return join(resolveGugoHome(env), MODELS_DEV_FILE)
}

export function modelsDevConfig(settings = undefined, env = process.env) {
  const configured = (settings || readSettings(env))?.modelsDev
  const url = String(configured?.url || DEFAULT_MODELS_DEV_URL)
  const ttlHours = Number(configured?.cacheTtlHours)
  return {
    enabled: configured?.enabled !== false,
    url: /^https:\/\//u.test(url) ? url : DEFAULT_MODELS_DEV_URL,
    cacheTtlHours: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_CACHE_TTL_HOURS,
  }
}

export function readModelsDevCache(env = process.env) {
  const path = modelsDevPath(env)
  if (!existsSync(path)) return { fetchedAt: 0, models: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const models = parsed?.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models) ? parsed.models : {}
    const fetchedAt = Number(parsed?.fetchedAt)
    return { fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0, models }
  } catch {
    // A half-written or hand-edited cache is treated as absent, not fatal.
    return { fetchedAt: 0, models: {} }
  }
}

function writeCache(cache, env) {
  const path = modelsDevPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(cache), 'utf8')
  renameSync(temporary, path)
}

/** models.dev groups by provider and lists models per provider. */
export function indexModelsDevPayload(payload) {
  const models = {}
  if (!payload || typeof payload !== 'object') return models
  for (const provider of Object.values(payload)) {
    const entries = provider?.models
    if (!entries || typeof entries !== 'object') continue
    for (const [id, meta] of Object.entries(entries)) {
      if (!id) continue
      models[id] = {
        ...(meta?.name ? { displayName: String(meta.name) } : {}),
        ...(Number.isFinite(Number(meta?.limit?.context)) ? { contextWindow: Number(meta.limit.context) } : {}),
        ...(Number.isFinite(Number(meta?.limit?.output)) ? { maxTokens: Number(meta.limit.output) } : {}),
      }
    }
  }
  return models
}

export function isCacheFresh(cache, { now = Date.now(), ttlHours = DEFAULT_CACHE_TTL_HOURS } = {}) {
  if (!cache?.fetchedAt) return false
  return now - cache.fetchedAt < ttlHours * 3600 * 1000
}

export function modelsDevStatus(env = process.env, { now = Date.now() } = {}) {
  const settings = readSettings(env)
  const config = modelsDevConfig(settings)
  const cache = readModelsDevCache(env)
  return {
    enabled: config.enabled,
    url: config.url,
    cacheTtlHours: config.cacheTtlHours,
    fetchedAt: cache.fetchedAt,
    count: Object.keys(cache.models).length,
    fresh: isCacheFresh(cache, { now, ttlHours: config.cacheTtlHours }),
  }
}

/**
 * Fetch and cache. Called only from an explicit refresh; failures leave the
 * previous cache untouched so an offline machine keeps its metadata.
 */
export async function refreshModelsDev({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const settings = readSettings(env)
  const config = modelsDevConfig(settings)
  if (!config.enabled) return { ok: false, code: 'MODELS_DEV_DISABLED', ...modelsDevStatus(env, { now }) }
  try {
    const response = await fetchImpl(config.url, { headers: { accept: 'application/json' } })
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`)
    const models = indexModelsDevPayload(await response.json())
    writeCache({ fetchedAt: now, source: config.url, models }, env)
    return { ok: true, ...modelsDevStatus(env, { now }) }
  } catch (error) {
    return { ok: false, code: 'MODELS_DEV_FETCH_FAILED', message: String(error?.message || error), ...modelsDevStatus(env, { now }) }
  }
}

/** Cached metadata for one model id, or null. Never fetches. */
export function modelsDevMeta(modelId, env = process.env) {
  const cache = readModelsDevCache(env)
  const meta = cache.models[String(modelId || '')]
  return meta && Object.keys(meta).length > 0 ? { ...meta } : null
}

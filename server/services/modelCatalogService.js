import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CATALOG_SOURCE_URL,
  MAX_RESPONSE_BYTES,
  buildSnapshot,
  isUsableSnapshot,
} from '../../shared/modelCatalogSnapshot.js'

/**
 * The provider/model knowledge base, with models.dev as the upstream.
 *
 * Two layers, deliberately:
 *
 * - A generated snapshot ships with the app (`shared/modelCatalogSnapshot.json`,
 *   written by `scripts/generate-model-catalog.mjs`). It is what makes first run,
 *   offline use, and the test suite work without a third party: a model picker
 *   that only exists behind a network call is unusable exactly when a reader has
 *   no network.
 * - A refresh pulls the same document from models.dev and replaces the in-memory
 *   view once it passes `isUsableSnapshot`. Vendors ship models faster than this
 *   app ships releases, so the snapshot alone would be stale by design; the
 *   refresh is how the picker learns about a model that did not exist when this
 *   build was cut.
 *
 * A failed or malformed refresh never replaces good data: the last known-good
 * catalogue stays in place and the failure is reported alongside it.
 *
 * Preset aliases are needed because this app's own preset ids predate the
 * catalogue (`gemini`, `qwen`, `moonshot`, `zhipu`) while models.dev keys those
 * providers as `google`, `alibaba`, `moonshotai`, `zhipuai`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SNAPSHOT_PATH = path.resolve(HERE, '../../shared/modelCatalogSnapshot.json')
export { CATALOG_SOURCE_URL }

// Bound the refresh: the document comes from the network and is held in memory.
const REFRESH_TIMEOUT_MS = 20_000
const MAX_MODELS_RETURNED = 500

/** Preset id → catalogue id, for the presets whose ids differ upstream. */
export const PROVIDER_ID_ALIASES = Object.freeze({
  gemini: 'google',
  qwen: 'alibaba',
  moonshot: 'moonshotai',
  zhipu: 'zhipuai',
})

/** The catalogue's id for one of this app's preset ids. */
export function catalogIdForPreset(presetId) {
  const id = String(presetId || '').trim()
  if (!id) return ''
  return PROVIDER_ID_ALIASES[id] || id
}

function readSnapshotFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
    return isUsableSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

let cached = null
let refreshedAt = 0
let lastError = ''

/**
 * The catalogue currently in use: the refreshed document when one has been
 * accepted, otherwise the bundled snapshot.
 */
export function currentCatalog() {
  if (!cached) cached = readSnapshotFile()
  return cached
}

/** Where the current catalogue came from, for display next to a model list. */
export function catalogStatus() {
  const catalog = currentCatalog()
  if (!catalog) return { available: false, source: 'none', providers: 0, models: 0, generatedAt: '', error: lastError }
  return {
    available: true,
    source: refreshedAt ? 'models.dev' : 'bundled',
    providers: catalog.providerCount || catalog.providers.length,
    models: catalog.modelCount || 0,
    generatedAt: catalog.generatedAt || '',
    refreshedAt: refreshedAt || 0,
    error: lastError,
  }
}

/** One provider, with its models, by catalogue id or by this app's preset id. */
export function catalogProvider(presetOrCatalogId) {
  const catalog = currentCatalog()
  if (!catalog) return null
  const wanted = catalogIdForPreset(presetOrCatalogId)
  return catalog.providers.find((provider) => provider.id === wanted) || null
}

/**
 * The model ids a provider currently serves, newest first.
 *
 * This is the whole point of the catalogue: the answer comes from upstream
 * release dates rather than from whichever ids were typed into this repo.
 */
export function catalogModelIds(presetOrCatalogId, { limit = MAX_MODELS_RETURNED, includeDeprecated = false } = {}) {
  const provider = catalogProvider(presetOrCatalogId)
  if (!provider) return []
  const models = includeDeprecated ? provider.models : provider.models.filter((model) => model.deprecated !== true)
  return models.slice(0, limit).map((model) => model.id)
}

/** Every provider the catalogue knows, trimmed for a picker. */
export function listCatalogProviders({ query = '', limit = 400 } = {}) {
  const catalog = currentCatalog()
  if (!catalog) return []
  const needle = String(query || '').trim().toLowerCase()
  return catalog.providers
    .filter((provider) => {
      if (!needle) return true
      return provider.id.toLowerCase().includes(needle) || String(provider.name || '').toLowerCase().includes(needle)
    })
    .slice(0, limit)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      modelCount: provider.models.length,
      ...(provider.doc ? { doc: provider.doc } : {}),
    }))
}

async function readBoundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('model catalogue is larger than this app will accept')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('model catalogue is larger than this app will accept')
  }
  return JSON.parse(text)
}

/**
 * Pull the catalogue from models.dev and adopt it if it validates.
 *
 * Returns the new status either way. A failure is reported, not thrown at the
 * caller: a refresh is an improvement to data the app already has, so failing to
 * improve it must not break the settings page.
 */
export async function refreshCatalog({
  fetchImpl = fetch,
  url = CATALOG_SOURCE_URL,
  now = Date.now(),
  timeoutMs = REFRESH_TIMEOUT_MS,
} = {}) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`models.dev responded ${response.status}`)
    const snapshot = buildSnapshot(await readBoundedJson(response), { now: new Date(now), sourceUrl: url })
    if (!isUsableSnapshot(snapshot)) throw new Error('models.dev returned an unusable catalogue')
    cached = snapshot
    refreshedAt = now
    lastError = ''
  } catch (error) {
    lastError = String(error?.message || error)
  }
  return catalogStatus()
}

/** Test seam: the cache and the refresh stamp are process-wide. */
export function resetCatalogCache() {
  cached = null
  refreshedAt = 0
  lastError = ''
}

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { catalogIdForPreset } from '../../shared/modelCatalogSnapshot.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BUNDLED_CATALOG_PATH = path.resolve(HERE, '../../shared/modelCatalogSnapshot.json')

let cachedCatalog = null

function loadCatalog() {
  if (cachedCatalog !== null) return cachedCatalog
  try {
    const parsed = JSON.parse(readFileSync(BUNDLED_CATALOG_PATH, 'utf8'))
    cachedCatalog = Array.isArray(parsed?.providers) ? parsed : null
  } catch {
    cachedCatalog = null
  }
  return cachedCatalog
}

export function indexBundledCatalog(catalog) {
  const byProvider = new Map()
  const byModel = new Map()
  for (const provider of Array.isArray(catalog?.providers) ? catalog.providers : []) {
    const providerId = String(provider?.id || '').trim()
    if (!providerId) continue
    const models = new Map()
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      const modelId = String(model?.id || '').trim()
      const context = Number(model?.context)
      if (!modelId || !Number.isFinite(context) || context <= 0) continue
      models.set(modelId, Math.floor(context))
      const seen = byModel.get(modelId) || new Set()
      seen.add(Math.floor(context))
      byModel.set(modelId, seen)
    }
    if (models.size > 0) byProvider.set(providerId, models)
  }
  return { byProvider, byModel }
}

let cachedIndex = null

function bundledIndex(catalog) {
  if (catalog) return indexBundledCatalog(catalog)
  if (!cachedIndex) cachedIndex = indexBundledCatalog(loadCatalog())
  return cachedIndex
}

/**
 * A context window from the catalogue that ships with the app.
 *
 * Two lookups, in order: the selected provider's own entry, then a model id that
 * every provider agrees on. A model id that different providers list with
 * different windows is not guessed — the model runtime falls back to its normal
 * defaults instead of showing a number the endpoint may not honour.
 */
export function bundledModelContextWindow(modelId, { providerId = '', catalog = null } = {}) {
  const id = String(modelId || '').trim()
  if (!id) return null
  const index = bundledIndex(catalog)
  const catalogProviderId = catalogIdForPreset(providerId)
  if (catalogProviderId) {
    const exact = index.byProvider.get(catalogProviderId)?.get(id)
    if (exact) return exact
  }
  const contexts = index.byModel.get(id)
  if (contexts?.size === 1) return contexts.values().next().value
  return null
}

/** Test seam: the bundled file and its index are process-wide. */
export function resetBundledModelCatalog() {
  cachedCatalog = null
  cachedIndex = null
}

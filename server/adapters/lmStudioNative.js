import { isLocalModelEndpoint } from './modelEndpoint.js'

/**
 * LM Studio's own model list — the only place a local server says how much
 * context it is actually serving.
 *
 * The OpenAI-compatible `/v1/models` answers with bare ids, which is why a local
 * model used to fall back to the conservative default window. LM Studio's
 * `/api/v0/models` adds `max_context_length` (the model's ceiling) and
 * `loaded_context_length` (the window it is serving right now), and that second
 * number is the one a compaction threshold needs: without it the app compressed
 * conversations that fit and refused ones the endpoint would have served.
 *
 * The probe is best-effort and local-only. Anything unexpected — an endpoint that
 * is not LM Studio, a missing field, a refused connection — leaves the caller with
 * an empty result rather than an error, because a nice-to-have number must never
 * be the reason a provider test fails.
 */

const DEFAULT_TIMEOUT_MS = 8_000
const MAX_MODELS = 200

function positiveLimit(...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return null
}

export function lmStudioCatalogUrl(baseUrl = '') {
  const url = new URL(String(baseUrl))
  return `${url.origin}/api/v0/models`
}

/**
 * The window a catalog item states, and where that number came from: a loaded
 * model reports the window it is serving, a model LM Studio has not loaded yet
 * only reports the ceiling it would load with.
 */
export function parseLmStudioCatalog(data) {
  const items = Array.isArray(data?.data) ? data.data : []
  const models = []
  const modelProfiles = {}
  for (const item of items.slice(0, MAX_MODELS)) {
    const name = String(item?.id || item?.name || '').trim()
    if (!name || models.includes(name)) continue
    const loaded = positiveLimit(item?.loaded_context_length)
    const ceiling = positiveLimit(item?.max_context_length)
    const contextWindow = loaded || ceiling
    if (!contextWindow) continue
    models.push(name)
    modelProfiles[name] = {
      contextWindow,
      source: 'lmstudio-api',
      basis: loaded ? 'loaded' : 'ceiling',
    }
  }
  return { models, modelProfiles }
}

export async function discoverLmStudioEndpoint({
  baseUrl = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  apiKey = '',
} = {}) {
  const result = { ok: false, models: [], modelProfiles: {}, error: null }
  if (!isLocalModelEndpoint(baseUrl)) return result
  let url
  try {
    url = lmStudioCatalogUrl(baseUrl)
  } catch {
    return result
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: controller.signal,
    })
    if (!response?.ok) return result
    const parsed = parseLmStudioCatalog(await response.json())
    if (!parsed.models.length) return result
    return { ok: true, ...parsed, error: null }
  } catch (error) {
    result.error = error?.message || String(error)
    return result
  } finally {
    clearTimeout(timer)
  }
}

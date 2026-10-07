import { authHeaders, parseProxyResponse } from './modelHttp.js'

/**
 * The provider/model knowledge base on the local server.
 *
 * `/api/model/providers` is the reader's own saved endpoints; this is the
 * catalogue those endpoints are configured from. Three calls, all behind the
 * same local auth header as the rest of the model settings surface.
 */
async function catalogRequest(path = '', init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/model/catalog${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(authHeaders() || {}),
      ...(init.headers || {}),
    },
  })
  // parseProxyResponse reads the server's `{ ok, error }` envelope, so a 404
  // arrives as an error carrying `code: 'CATALOG_PROVIDER_UNKNOWN'` and the
  // catalogue provenance that came with it.
  return parseProxyResponse(response)
}

/** Provenance of the catalogue in use: source, counts, generated date, last refresh error. */
export async function getModelCatalog({ fetchImpl = fetch } = {}) {
  const data = await catalogRequest('', {}, fetchImpl)
  return data?.catalog || null
}

/**
 * The searchable provider index.
 *
 * Served from the catalogue rather than mirrored into the client: a second copy
 * of the provider list would drift from the knowledge base it describes. This is
 * what makes a provider with no bundled preset (amazon-bedrock, cerebras, …)
 * discoverable by browsing instead of by already knowing its id.
 */
export async function listCatalogProviders({ query = '', fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ providers: '1' })
  const needle = String(query || '').trim()
  if (needle) params.set('q', needle)
  const data = await catalogRequest(`?${params.toString()}`, {}, fetchImpl)
  return {
    providers: Array.isArray(data?.providers) ? data.providers : [],
    catalog: data?.catalog || null,
  }
}

/** One provider's current models, by this app's preset id or the catalogue id. */
export async function getCatalogProviderModels(providerId, { fetchImpl = fetch } = {}) {
  const data = await catalogRequest(`/${encodeURIComponent(String(providerId || '').trim())}`, {}, fetchImpl)
  return {
    provider: data?.provider || null,
    models: Array.isArray(data?.models) ? data.models : [],
    catalog: data?.catalog || null,
  }
}

/**
 * Pull a fresh catalogue from models.dev.
 *
 * The server reports a refresh failure inside `catalog.error` instead of failing
 * the request, so this resolves with the status either way and the caller keeps
 * the last known-good list.
 */
export async function refreshModelCatalog({ fetchImpl = fetch } = {}) {
  const data = await catalogRequest('/refresh', { method: 'POST' }, fetchImpl)
  return data?.catalog || null
}

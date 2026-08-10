import net from 'node:net'
import { WEB_SEARCH_PROVIDER_IDS, getWebSearchProvider } from '../../shared/webSearchProviders.js'
import { fetchConnectorJson } from './connectorHttp.js'
import { isUnsafeIp } from '../utils/outboundNetworkGuard.js'
import {
  getWebSearchCredentials,
  recordWebSearchTest,
  saveWebSearchConfig,
  saveWebSearchConfigs,
} from './webSearchConfigStore.js'

const MAX_RESULTS = 10
const MAX_CONNECTIONS = 8
const MAX_TEMPLATE_CHARS = 16_000
const DEFAULT_CUSTOM_BODY = '{"q":"{query}","num":"{maxResults}"}'
const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function webSearchError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function boundedText(value, field, max = MAX_TEMPLATE_CHARS) {
  const text = String(value ?? '').trim()
  if (text.length > max) throw webSearchError(`${field} is too long`, 'WEB_SEARCH_CONFIG_INVALID')
  return text
}

function parseJsonObject(value, field, fallback = {}) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(boundedText(value, field))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed
  } catch {
    throw webSearchError(`${field} must be a JSON object`, 'WEB_SEARCH_CONFIG_INVALID')
  }
}

function normalizePath(value, fallback) {
  const path = boundedText(value, 'result path', 200) || fallback
  if (!/^[A-Za-z0-9_$.-]+$/.test(path)) {
    throw webSearchError('Result paths may contain only letters, numbers, dots, underscores, dollar signs, and hyphens', 'WEB_SEARCH_CONFIG_INVALID')
  }
  return path
}

export function normalizeWebSearchConfig(provider, value = {}) {
  if (!WEB_SEARCH_PROVIDER_IDS.includes(provider)) {
    throw webSearchError(`Unknown web search provider: ${provider}`, 'WEB_SEARCH_PROVIDER_INVALID')
  }
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  if (provider === 'google_cse') {
    return { cx: boundedText(config.cx, 'Google search engine ID', 300) }
  }
  if (provider !== 'custom') return {}

  const baseUrl = boundedText(config.baseUrl, 'Base URL', 2_000)
  let parsed
  try { parsed = new URL(baseUrl) } catch { throw webSearchError('Custom search Base URL is invalid', 'WEB_SEARCH_URL_INVALID') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw webSearchError('Custom search Base URL must be an HTTP(S) URL without embedded credentials', 'WEB_SEARCH_URL_INVALID')
  }
  const method = String(config.method || 'POST').toUpperCase()
  if (!['GET', 'POST'].includes(method)) {
    throw webSearchError('Custom search method must be GET or POST', 'WEB_SEARCH_CONFIG_INVALID')
  }
  parseJsonObject(config.headersTemplate, 'Headers template')
  if (method === 'POST') parseJsonObject(config.bodyTemplate || DEFAULT_CUSTOM_BODY, 'Body template')
  return {
    baseUrl: parsed.toString(),
    method,
    queryParam: boundedText(config.queryParam, 'Query parameter', 100) || 'q',
    headersTemplate: boundedText(config.headersTemplate, 'Headers template') || '{}',
    bodyTemplate: method === 'POST'
      ? (boundedText(config.bodyTemplate, 'Body template') || DEFAULT_CUSTOM_BODY)
      : '',
    resultPath: normalizePath(config.resultPath, 'results'),
    titlePath: normalizePath(config.titlePath, 'title'),
    urlPath: normalizePath(config.urlPath, 'url'),
    snippetPath: normalizePath(config.snippetPath, 'snippet'),
  }
}

export function normalizeWebSearchConnections(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw webSearchError('Add at least one web search API configuration', 'WEB_SEARCH_CONNECTIONS_REQUIRED')
  }
  if (value.length > MAX_CONNECTIONS) {
    throw webSearchError(`At most ${MAX_CONNECTIONS} web search API configurations are allowed`, 'WEB_SEARCH_CONFIG_INVALID')
  }
  const seen = new Set()
  return value.map((item, index) => {
    const id = String(item?.id || (index === 0 ? 'primary' : `connection-${index + 1}`)).trim()
    if (!CONNECTION_ID_RE.test(id) || seen.has(id)) {
      throw webSearchError('Each web search API configuration needs a unique valid ID', 'WEB_SEARCH_CONFIG_INVALID')
    }
    seen.add(id)
    const provider = String(item?.provider || '').trim()
    return {
      id,
      provider,
      enabled: item?.enabled !== false,
      config: normalizeWebSearchConfig(provider, item?.config),
    }
  })
}

function readPath(value, path) {
  if (!path || path === '$') return value
  const parts = String(path).replace(/^\$\.?/, '').split('.').filter(Boolean)
  let current = value
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function applyTemplate(value, replacements) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{(query|maxResults|apiKey)\}$/)
    if (exact) return replacements[exact[1]]
    return value.replace(/\{(query|maxResults|apiKey)\}/g, (_match, key) => String(replacements[key] ?? ''))
  }
  if (Array.isArray(value)) return value.map((item) => applyTemplate(item, replacements))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyTemplate(item, replacements)]))
  }
  return value
}

function normalizeResult(item, paths) {
  const title = String(readPath(item, paths.title) ?? '').trim()
  const url = String(readPath(item, paths.url) ?? '').trim()
  const snippet = String(readPath(item, paths.snippet) ?? '').trim()
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol) || !title) return null
  return { title: title.slice(0, 500), url: parsed.toString(), snippet: snippet.slice(0, 2_000) }
}

function assertResponse(response, data) {
  if (response?.ok) return
  const message = String(data?.message || data?.error?.message || data?.error || '').slice(0, 300)
  throw webSearchError(message || `Search provider returned HTTP ${response?.status || 502}`, 'WEB_SEARCH_UPSTREAM_ERROR', 502)
}

async function requestJson(url, init, fetchImpl) {
  const result = await fetchConnectorJson(url, init, {
    fetchImpl,
    timeoutMs: 20_000,
    maxResponseBytes: 1024 * 1024,
  })
  assertResponse(result.response, result.data)
  return result.data || {}
}

function fixedProviderRequest(provider, { query, maxResults, apiKey, config }) {
  if (provider === 'tavily') return {
    url: 'https://api.tavily.com/search',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: 'basic' }) },
    listPath: 'results', paths: { title: 'title', url: 'url', snippet: 'content' },
  }
  if (provider === 'brave') {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query); url.searchParams.set('count', String(maxResults))
    return { url: url.toString(), init: { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey } }, listPath: 'web.results', paths: { title: 'title', url: 'url', snippet: 'description' } }
  }
  if (provider === 'serper') return {
    url: 'https://google.serper.dev/search',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey }, body: JSON.stringify({ q: query, num: maxResults }) },
    listPath: 'organic', paths: { title: 'title', url: 'link', snippet: 'snippet' },
  }
  if (provider === 'bing') {
    const url = new URL('https://api.bing.microsoft.com/v7.0/search')
    url.searchParams.set('q', query); url.searchParams.set('count', String(maxResults)); url.searchParams.set('responseFilter', 'Webpages')
    return { url: url.toString(), init: { headers: { 'Ocp-Apim-Subscription-Key': apiKey } }, listPath: 'webPages.value', paths: { title: 'name', url: 'url', snippet: 'snippet' } }
  }
  const url = new URL('https://www.googleapis.com/customsearch/v1')
  url.searchParams.set('key', apiKey); url.searchParams.set('cx', config.cx); url.searchParams.set('q', query); url.searchParams.set('num', String(maxResults))
  return { url: url.toString(), init: {}, listPath: 'items', paths: { title: 'title', url: 'link', snippet: 'snippet' } }
}

function assertCustomLiteralHostSafe(url) {
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isUnsafeIp(host))) {
    throw webSearchError('Custom search URL resolves to a private, loopback, or link-local address', 'WEB_SEARCH_SSRF_BLOCKED')
  }
}

function customProviderRequest(config, replacements) {
  assertCustomLiteralHostSafe(config.baseUrl)
  const headers = applyTemplate(parseJsonObject(config.headersTemplate, 'Headers template'), replacements)
  const url = new URL(config.baseUrl)
  if (config.method === 'GET') url.searchParams.set(config.queryParam, String(replacements.query))
  const init = { method: config.method, headers }
  if (config.method === 'POST') {
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(applyTemplate(parseJsonObject(config.bodyTemplate, 'Body template'), replacements))
  }
  return {
    url: url.toString(), init, listPath: config.resultPath,
    paths: { title: config.titlePath, url: config.urlPath, snippet: config.snippetPath },
  }
}

function assertConnectionReady(connection) {
  const provider = connection.provider
  const config = normalizeWebSearchConfig(provider, connection.config)
  const apiKey = String(connection.secret?.apiKey || '').trim()
  if (provider !== 'custom' && !apiKey) {
    throw webSearchError(`Search provider ${getWebSearchProvider(provider)?.label || provider} is missing an API key`, 'WEB_SEARCH_API_KEY_REQUIRED')
  }
  if (provider === 'google_cse' && !config.cx) {
    throw webSearchError('Google Custom Search also requires a search engine ID (cx)', 'WEB_SEARCH_CX_REQUIRED')
  }
  return { provider, config, apiKey }
}

async function searchWithConnection({ connection, query, maxResults, fetchImpl }) {
  const { provider, config, apiKey } = assertConnectionReady(connection)
  const request = provider === 'custom'
    ? customProviderRequest(config, { query, maxResults, apiKey })
    : fixedProviderRequest(provider, { query, maxResults, apiKey, config })
  let data
  try {
    data = await requestJson(request.url, request.init, fetchImpl)
  } catch (error) {
    if (apiKey && typeof error?.message === 'string' && error.message.includes(apiKey)) {
      error.message = error.message.replaceAll(apiKey, '[REDACTED]')
    }
    throw error
  }
  const rawItems = readPath(data, request.listPath)
  const results = (Array.isArray(rawItems) ? rawItems : [])
    .map((item) => normalizeResult(item, request.paths))
    .filter(Boolean)
    .slice(0, maxResults)
  return { ok: true, provider, connectionId: connection.id, query, results }
}

export async function searchWeb({ userId, query, maxResults = 5, connectionId, fetchImpl = fetch } = {}) {
  const text = String(query || '').trim()
  if (!text) throw webSearchError('Search query is required', 'WEB_SEARCH_QUERY_REQUIRED')
  const saved = getWebSearchCredentials({ userId })
  if (!saved) {
    throw webSearchError('联网搜索尚未配置。请前往“设置 → 联网搜索”添加至少一个搜索 API。', 'WEB_SEARCH_NOT_CONFIGURED')
  }
  if (!saved.enabled) {
    throw webSearchError('联网搜索已关闭。请在“设置 → 联网搜索”中启用后重试。', 'WEB_SEARCH_DISABLED')
  }
  let candidates = saved.connections.filter((item) => item.enabled !== false)
  if (connectionId) candidates = candidates.filter((item) => item.id === connectionId)
  if (!candidates.length) {
    throw webSearchError(connectionId ? 'The selected web search API is disabled or missing' : 'No web search API is enabled', 'WEB_SEARCH_DISABLED')
  }
  const limit = Math.max(1, Math.min(MAX_RESULTS, Number(maxResults) || 5))
  const failures = []
  for (const connection of candidates) {
    try {
      const result = await searchWithConnection({ connection, query: text, maxResults: limit, fetchImpl })
      return { ...result, attemptedProviders: [...failures.map((item) => item.provider), result.provider] }
    } catch (error) {
      failures.push({ provider: connection.provider, error })
    }
  }
  if (failures.length === 1) throw failures[0].error
  const providerNames = failures.map(({ provider }) => getWebSearchProvider(provider)?.label || provider).join(', ')
  const statusCode = failures.some(({ error }) => Number(error?.statusCode) >= 500) ? 502 : 400
  throw webSearchError(`All configured web search APIs failed (${providerNames})`, 'WEB_SEARCH_ALL_PROVIDERS_FAILED', statusCode)
}

export function configureWebSearch({ userId, provider, enabled, config, apiKey, connections, strategy } = {}) {
  if (Array.isArray(connections)) {
    const normalized = normalizeWebSearchConnections(connections)
    return saveWebSearchConfigs({
      userId,
      enabled,
      strategy,
      connections: normalized.map((connection, index) => ({
        ...connection,
        ...(Object.hasOwn(connections[index] || {}, 'apiKey') ? { apiKey: connections[index].apiKey } : {}),
      })),
    })
  }
  const normalized = normalizeWebSearchConfig(provider, config)
  return saveWebSearchConfig({ userId, provider, enabled, config: normalized, apiKey })
}

export function isWebSearchReady({ userId } = {}) {
  const saved = getWebSearchCredentials({ userId })
  if (!saved?.enabled) return false
  return saved.connections.some((connection) => {
    if (connection.enabled === false) return false
    try {
      assertConnectionReady(connection)
      return true
    } catch {
      return false
    }
  })
}

export async function testWebSearch({ userId, connectionId, fetchImpl = fetch } = {}) {
  const saved = getWebSearchCredentials({ userId })
  if (!saved) throw webSearchError('Please save a web search configuration first', 'WEB_SEARCH_NOT_CONFIGURED')
  try {
    const result = await searchWeb({ userId, connectionId, query: 'OpenAI', maxResults: 3, fetchImpl })
    const label = getWebSearchProvider(result.provider)?.label || result.provider
    const message = result.results.length
      ? `Connected to ${label}; ${result.results.length} result(s) returned.`
      : `Connected to ${label}; no results returned for the test query.`
    recordWebSearchTest({ userId, ok: true, message })
    return { ok: true, provider: result.provider, connectionId: result.connectionId, resultCount: result.results.length, message }
  } catch (error) {
    recordWebSearchTest({ userId, ok: false, message: error?.message || 'Connection failed' })
    throw error
  }
}

import { browserConnectApp, browserOpenUrl, browserState } from '../adapters/browserAutomation.js'
import { findWebConnectorsForUrl, getWebConnector } from '../../shared/webConnectorCatalog.js'
import {
  getEnabledIntegrationCredentials,
  getIntegrationByProvider,
  isIntegrationEnabled,
  listIntegrations,
  upsertIntegration,
} from './integrationsStore.js'

function connectorError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max)
}

function credentials(userId, provider) {
  const value = getEnabledIntegrationCredentials({ userId, provider })
  if (!value) throw connectorError(`${provider} is not connected or is disabled`, 409)
  return value
}

function browserApp(provider) {
  const connector = getWebConnector(provider)
  if (!connector) throw connectorError(`Unknown Browser app: ${provider}`, 404)
  return connector
}

function assertBrowserEnabled(userId) {
  if (!isIntegrationEnabled({ userId, provider: 'browser', defaultEnabled: true })) {
    throw connectorError('Browser is disabled in Access', 403)
  }
}

function publicBrowserApp(connector, integration) {
  return {
    provider: connector.provider,
    label: connector.label,
    category: connector.category,
    capability: connector.capability,
    enabled: integration.enabled,
    connectedAt: integration.config?.connectedAt || integration.createdAt,
  }
}

export function listConnectedBrowserApps({ userId, enabledOnly = true } = {}) {
  if (!userId) return []
  const integrations = listIntegrations({ userId, kind: 'browser_app' })
  return integrations.flatMap((integration) => {
    if (enabledOnly && !integration.enabled) return []
    const connector = getWebConnector(integration.provider)
    return connector ? [publicBrowserApp(connector, integration)] : []
  })
}

export function assertBrowserAppUrlAccess({ userId, url } = {}) {
  const matches = findWebConnectorsForUrl(url)
  if (!matches.length) return null
  const connected = matches.find((connector) => {
    const integration = getIntegrationByProvider({ userId, provider: connector.provider })
    return integration?.kind === 'browser_app' && integration.enabled
  })
  if (!connected) {
    throw connectorError(`${matches.map((connector) => connector.label).join(' / ')} is not connected or is disabled`, 409)
  }
  return connected
}

export async function assertBrowserSessionAppAccess({ userId } = {}) {
  const state = await browserState({ userId })
  if (state?.url) assertBrowserAppUrlAccess({ userId, url: state.url })
  return state
}

export async function connectBrowserApp({ userId, provider, connectImpl = browserConnectApp } = {}) {
  assertBrowserEnabled(userId)
  const connector = browserApp(provider)
  const browser = await connectImpl({ userId, url: connector.webUrl })
  const integration = upsertIntegration({
    userId,
    provider: connector.provider,
    name: connector.label,
    enabled: true,
    config: { connectionMode: 'browser', connectedAt: Date.now() },
    secret: {},
  })
  return { app: publicBrowserApp(connector, integration), integration, browser }
}

export async function openConnectedBrowserApp({ userId, provider, openImpl = browserOpenUrl } = {}) {
  assertBrowserEnabled(userId)
  const connector = browserApp(provider)
  const integration = getIntegrationByProvider({ userId, provider: connector.provider })
  if (!integration || !integration.enabled || integration.kind !== 'browser_app') {
    throw connectorError(`${connector.label} is not connected or is disabled`, 409)
  }
  const browser = await openImpl({ userId, url: connector.webUrl })
  return { app: publicBrowserApp(connector, integration), browser }
}

async function apiJson(url, init = {}, fetchImpl = fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    if (!response.ok) throw connectorError(data?.message || `HTTP ${response.status}`, response.status)
    return data
  } finally {
    clearTimeout(timer)
  }
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  }
}

export async function searchNotion({ userId, query = '', fetchImpl = fetch }) {
  const { secret } = credentials(userId, 'notion')
  const data = await apiJson('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: notionHeaders(secret.token),
    body: JSON.stringify({ query: clean(query), page_size: 50 }),
  }, fetchImpl)
  return {
    results: (data?.results || []).map((item) => ({
      id: item.id,
      object: item.object,
      url: item.url || '',
      lastEditedTime: item.last_edited_time || null,
      title: item.properties?.title?.title?.map((part) => part.plain_text).join('')
        || item.title?.map?.((part) => part.plain_text).join('')
        || '',
    })),
    hasMore: !!data?.has_more,
  }
}

function notionId(value) {
  const id = clean(value, 64).replace(/-/g, '')
  if (!/^[a-f0-9]{32}$/i.test(id)) throw connectorError('Invalid Notion page ID')
  return id
}

export async function fetchNotionPage({ userId, pageId, fetchImpl = fetch }) {
  const { secret } = credentials(userId, 'notion')
  const id = notionId(pageId)
  const headers = notionHeaders(secret.token)
  const [page, children] = await Promise.all([
    apiJson(`https://api.notion.com/v1/pages/${id}`, { headers }, fetchImpl),
    apiJson(`https://api.notion.com/v1/blocks/${id}/children?page_size=100`, { headers }, fetchImpl),
  ])
  return { page, blocks: children?.results || [], hasMore: !!children?.has_more }
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'your-model-atelier',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

export async function searchGithubRepositories({ userId, query, fetchImpl = fetch }) {
  const { secret } = credentials(userId, 'github')
  const q = clean(query)
  if (!q) throw connectorError('query is required')
  const data = await apiJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=20`, {
    headers: githubHeaders(secret.token),
  }, fetchImpl)
  return {
    totalCount: data?.total_count || 0,
    repositories: (data?.items || []).map((item) => ({
      fullName: item.full_name,
      description: item.description || '',
      url: item.html_url,
      defaultBranch: item.default_branch,
      private: !!item.private,
      updatedAt: item.updated_at,
    })),
  }
}

function githubPart(value, label) {
  const part = clean(value, 100)
  if (!/^[A-Za-z0-9_.-]+$/.test(part)) throw connectorError(`Invalid GitHub ${label}`)
  return part
}

export async function getGithubFile({ userId, owner, repo, path, ref = '', fetchImpl = fetch }) {
  const { secret } = credentials(userId, 'github')
  const safeOwner = githubPart(owner, 'owner')
  const safeRepo = githubPart(repo, 'repository')
  const segments = clean(path, 1000).split('/').filter(Boolean)
  if (!segments.length || segments.some((part) => part === '.' || part === '..')) throw connectorError('Invalid GitHub file path')
  const encodedPath = segments.map(encodeURIComponent).join('/')
  const suffix = ref ? `?ref=${encodeURIComponent(clean(ref, 200))}` : ''
  const data = await apiJson(`https://api.github.com/repos/${safeOwner}/${safeRepo}/contents/${encodedPath}${suffix}`, {
    headers: githubHeaders(secret.token),
  }, fetchImpl)
  if (Array.isArray(data)) {
    return { type: 'directory', entries: data.map((item) => ({ name: item.name, path: item.path, type: item.type, sha: item.sha })) }
  }
  const content = data?.encoding === 'base64' && data?.content
    ? Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8')
    : ''
  return { type: data?.type || 'file', path: data?.path || path, sha: data?.sha || '', content }
}

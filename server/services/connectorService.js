import { browserConnectApp, browserState } from '../adapters/browserAutomation.js'
import { findWebConnectorsForUrl, getWebConnector } from '../../shared/webConnectorCatalog.js'
import {
  getEnabledIntegrationCredentials,
  getIntegrationByProvider,
  isIntegrationEnabled,
  listIntegrations,
  upsertIntegration,
} from './integrationsStore.js'
import { getOAuthAccessToken } from './integrationOAuthService.js'
import {
  allowQqMailEnvCredentials,
  listImapMessages,
  readImapMessage,
  resolveQqMailSettings,
  sendSmtpMessage,
} from './mailProtocolClient.js'

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

function qqMailSettings(userId, env) {
  const { config, secret } = credentials(userId, 'qq_mail')
  return resolveQqMailSettings({
    config,
    secret,
    env,
    allowEnvCredentials: allowQqMailEnvCredentials(env),
  })
}

export async function listQqMailMessages({
  userId,
  limit = 20,
  env = process.env,
  mailClient = {},
} = {}) {
  const settings = qqMailSettings(userId, env)
  return (mailClient.listMessages || listImapMessages)(settings, { limit })
}

export async function readQqMailMessage({
  userId,
  uid,
  env = process.env,
  mailClient = {},
} = {}) {
  const settings = qqMailSettings(userId, env)
  return (mailClient.readMessage || readImapMessage)(settings, { uid })
}

export async function sendQqMailMessage({
  userId,
  to,
  subject,
  text,
  html,
  env = process.env,
  mailClient = {},
} = {}) {
  const settings = qqMailSettings(userId, env)
  return (mailClient.sendMessage || sendSmtpMessage)(settings, { to, subject, text, html })
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
    intendedCapability: connector.intendedCapability,
    capabilityLevel: connector.capabilityLevel,
    integrationDepth: connector.integrationDepth,
    providerSpecificTools: connector.providerSpecificTools,
    availableTools: ['connected_app_open'],
    enabled: integration.enabled,
    persistent: true,
    connectedAt: integration.config?.connectedAt || integration.createdAt,
    lastOpenedAt: integration.config?.lastOpenedAt || null,
  }
}

function connectedBrowserApp(userId, provider) {
  const connector = browserApp(provider)
  const integration = getIntegrationByProvider({ userId, provider: connector.provider })
  if (!integration || !integration.enabled || integration.kind !== 'browser_app') {
    throw connectorError(`${connector.label} is not connected or is disabled`, 409)
  }
  return { connector, integration }
}

function preferredConnectedBrowserApp(userId) {
  const candidates = listIntegrations({ userId, kind: 'browser_app' })
    .filter((integration) => integration.enabled)
    .map((integration) => ({ integration, connector: getWebConnector(integration.provider) }))
    .filter((item) => item.connector)
  candidates.sort((a, b) => {
    const aUsed = Number(a.integration.config?.lastOpenedAt || a.integration.config?.connectedAt || a.integration.updatedAt || 0)
    const bUsed = Number(b.integration.config?.lastOpenedAt || b.integration.config?.connectedAt || b.integration.updatedAt || 0)
    return bUsed - aUsed
  })
  return candidates[0] || null
}

function rememberBrowserAppUse({ userId, connector, integration, now = Date.now() }) {
  return upsertIntegration({
    userId,
    id: integration.id,
    provider: connector.provider,
    name: connector.label,
    enabled: true,
    config: {
      ...(integration.config || {}),
      connectionMode: 'persistent_browser',
      connectedAt: integration.config?.connectedAt || now,
      lastOpenedAt: now,
    },
  })
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
  const state = await ensureConnectedBrowserAppSession({ userId })
  if (state?.url) assertBrowserAppUrlAccess({ userId, url: state.url })
  return state
}

export async function connectBrowserApp({ userId, provider, connectImpl = browserConnectApp } = {}) {
  assertBrowserEnabled(userId)
  const connector = browserApp(provider)
  const previous = getIntegrationByProvider({ userId, provider: connector.provider })
  const browser = await connectImpl({ userId, url: connector.webUrl })
  const integration = upsertIntegration({
    userId,
    provider: connector.provider,
    name: connector.label,
    enabled: true,
    config: {
      ...(previous?.config || {}),
      connectionMode: 'persistent_browser',
      connectedAt: previous?.config?.connectedAt || Date.now(),
      lastOpenedAt: Date.now(),
    },
    secret: {},
  })
  return { app: publicBrowserApp(connector, integration), integration, browser }
}

export async function openConnectedBrowserApp({ userId, provider, openImpl = browserConnectApp } = {}) {
  assertBrowserEnabled(userId)
  const { connector, integration } = connectedBrowserApp(userId, provider)
  const browser = await openImpl({ userId, url: connector.webUrl })
  const refreshed = rememberBrowserAppUse({ userId, connector, integration })
  return { app: publicBrowserApp(connector, refreshed), integration: refreshed, browser }
}

export async function ensureConnectedBrowserAppSession({
  userId,
  stateImpl = browserState,
  resumeImpl = browserConnectApp,
} = {}) {
  assertBrowserEnabled(userId)
  let current
  try {
    current = await stateImpl({ userId })
  } catch {
    current = { connected: false }
  }
  const preferred = preferredConnectedBrowserApp(userId)
  if (current?.connected && /^https?:/i.test(String(current.url || '')) && (!preferred || current.headless === false)) {
    assertBrowserAppUrlAccess({ userId, url: current.url })
    return current
  }
  if (!preferred) return current || { connected: false }
  const browser = await resumeImpl({ userId, url: preferred.connector.webUrl })
  rememberBrowserAppUse({ userId, ...preferred })
  return { ...browser, resumed: true, provider: preferred.connector.provider }
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

function slackHeaders(token) {
  return { Authorization: `Bearer ${token}` }
}

function assertSlackResponse(data) {
  if (data?.ok !== true) throw connectorError(`Slack: ${data?.error || 'request failed'}`, 502)
  return data
}

export async function listSlackChannels({ userId, limit = 100, fetchImpl = fetch }) {
  const { secret } = credentials(userId, 'slack')
  const pageSize = Math.max(1, Math.min(Number(limit) || 100, 200))
  const url = new URL('https://slack.com/api/conversations.list')
  url.searchParams.set('types', 'public_channel,private_channel')
  url.searchParams.set('exclude_archived', 'true')
  url.searchParams.set('limit', String(pageSize))
  const data = assertSlackResponse(await apiJson(url.toString(), {
    headers: slackHeaders(secret.botToken),
  }, fetchImpl))
  return {
    channels: (data.channels || []).map((channel) => ({
      id: channel.id,
      name: channel.name || '',
      topic: channel.topic?.value || '',
      purpose: channel.purpose?.value || '',
      private: !!channel.is_private,
      member: !!channel.is_member,
    })),
    nextCursor: data.response_metadata?.next_cursor || '',
  }
}

function slackChannelId(value) {
  const id = clean(value, 32)
  if (!/^[A-Z0-9]{8,32}$/i.test(id)) throw connectorError('Invalid Slack channel ID')
  return id
}

export async function readSlackChannel({ userId, channelId, limit = 50, fetchImpl = fetch }) {
  const { secret } = credentials(userId, 'slack')
  const pageSize = Math.max(1, Math.min(Number(limit) || 50, 100))
  const url = new URL('https://slack.com/api/conversations.history')
  url.searchParams.set('channel', slackChannelId(channelId))
  url.searchParams.set('limit', String(pageSize))
  const data = assertSlackResponse(await apiJson(url.toString(), {
    headers: slackHeaders(secret.botToken),
  }, fetchImpl))
  return {
    messages: (data.messages || []).map((message) => ({
      ts: message.ts || '',
      user: message.user || message.bot_id || '',
      text: clean(message.text, 20_000),
      threadTs: message.thread_ts || null,
      replyCount: Number(message.reply_count) || 0,
    })),
    hasMore: !!data.has_more,
    nextCursor: data.response_metadata?.next_cursor || '',
  }
}

function driveHeaders(token) {
  return { Authorization: `Bearer ${token}` }
}

function driveQuery(value) {
  return clean(value, 200).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function publicDriveFile(file) {
  return {
    id: file.id,
    name: file.name || '',
    mimeType: file.mimeType || '',
    modifiedTime: file.modifiedTime || null,
    size: Number(file.size) || null,
    webViewLink: file.webViewLink || '',
  }
}

export async function searchGoogleDrive({ userId, query = '', limit = 25, fetchImpl = fetch, env = process.env }) {
  const token = await getOAuthAccessToken({ userId, provider: 'google_drive', fetchImpl, env })
  const pageSize = Math.max(1, Math.min(Number(limit) || 25, 100))
  const term = driveQuery(query)
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('q', `${term ? `name contains '${term}' and ` : ''}trashed = false`)
  url.searchParams.set('pageSize', String(pageSize))
  url.searchParams.set('orderBy', 'modifiedTime desc')
  url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)')
  const data = await apiJson(url.toString(), { headers: driveHeaders(token) }, fetchImpl)
  return {
    files: (data?.files || []).map(publicDriveFile),
    nextPageToken: data?.nextPageToken || '',
  }
}

function driveFileId(value) {
  const id = clean(value, 200)
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) throw connectorError('Invalid Google Drive file ID')
  return id
}

async function apiText(url, init, fetchImpl, maxChars = 500_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const text = await response.text()
      let message = `HTTP ${response.status}`
      try { message = JSON.parse(text)?.error?.message || message } catch { /* keep status */ }
      throw connectorError(message, response.status)
    }
    if (!response.body?.getReader) {
      const text = await response.text()
      return { content: text.slice(0, maxChars), truncated: text.length > maxChars }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let content = ''
    let truncated = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      const remaining = maxChars - content.length
      if (chunk.length > remaining) {
        content += chunk.slice(0, Math.max(0, remaining))
        truncated = true
        await reader.cancel()
        break
      }
      content += chunk
    }
    if (!truncated) content += decoder.decode()
    return { content, truncated }
  } finally {
    clearTimeout(timer)
  }
}

const DRIVE_EXPORT_TYPES = Object.freeze({
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
})

export async function getGoogleDriveFile({ userId, fileId, fetchImpl = fetch, env = process.env }) {
  const token = await getOAuthAccessToken({ userId, provider: 'google_drive', fetchImpl, env })
  const id = driveFileId(fileId)
  const headers = driveHeaders(token)
  const metadata = await apiJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,size,webViewLink`,
    { headers },
    fetchImpl,
  )
  const file = publicDriveFile(metadata)
  const exportType = DRIVE_EXPORT_TYPES[file.mimeType]
  if (exportType) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportType)}`
    return { file, ...(await apiText(url, { headers }, fetchImpl)) }
  }
  if (file.mimeType.startsWith('text/') || /(?:json|xml|javascript|csv)/i.test(file.mimeType)) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`
    return { file, ...(await apiText(url, { headers }, fetchImpl)) }
  }
  return { file, content: '', truncated: false, binary: true }
}

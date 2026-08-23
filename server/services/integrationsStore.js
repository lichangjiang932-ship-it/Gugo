/**
 * 第三方集成（社交平台 / IM）配置存储 + 测试连接
 *
 * 设计原则：
 *  - 凭据落 DB 不落 .env：每用户每平台一条记录，可随时启停（enabled）
 *  - secret_json 与 config_json 拆开：返回前端时 secret_json 永远脱敏（只暴露存在性）
 *  - testConnection 不做真实推送，只做最低成本的鉴权/连通性探测（如读 bot info）
 *
 * 当前内置 provider 清单：
 *   IM / 社交：feishu / wechat_official / wechat_personal / dingtalk / qq /
 *              discord / telegram / slack / lark_bot / webhook
 *   视觉辅助：vision_assist（kind='vision_assist'，复用同一张表方便统一管理）
 */

import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { WEB_CONNECTOR_CATALOG } from '../../shared/webConnectorCatalog.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'
import { testMailCredentials, testQqMailCredentials } from './mailProtocolClient.js'

const INTEGRATION_SECRET_PURPOSE = 'integration-secret'
const NATIVE_CONNECTOR_TOOLS = Object.freeze({
  notion: Object.freeze(['notion_search', 'notion_fetch_page', 'notion_append_paragraphs']),
  github: Object.freeze(['github_search_repositories', 'github_get_file', 'github_create_issue']),
  google_drive: Object.freeze(['google_drive_search', 'google_drive_get_file', 'google_drive_create_text_file', 'google_sheets_read_range', 'google_sheets_append_rows', 'google_sheets_update_range']),
  slack: Object.freeze(['slack_list_channels', 'slack_read_channel', 'slack_send_message']),
  jira: Object.freeze(['jira_search_issues', 'jira_create_issue', 'jira_update_issue']),
  linear: Object.freeze(['linear_search_issues', 'linear_create_issue', 'linear_update_issue']),
  trello: Object.freeze(['trello_list_cards', 'trello_create_card', 'trello_update_card']),
  google_calendar: Object.freeze(['google_calendar_list_events', 'google_calendar_create_event', 'google_calendar_update_event']),
  gitlab: Object.freeze(['gitlab_list_issues', 'gitlab_create_issue', 'gitlab_update_issue']),
  asana: Object.freeze(['asana_list_project_tasks', 'asana_create_task', 'asana_update_task']),
  clickup: Object.freeze(['clickup_list_tasks', 'clickup_create_task', 'clickup_update_task']),
  airtable: Object.freeze(['airtable_list_records', 'airtable_create_record', 'airtable_update_record']),
  monday: Object.freeze(['monday_list_items', 'monday_create_item', 'monday_update_item']),
  hubspot: Object.freeze(['hubspot_list_tickets', 'hubspot_create_ticket', 'hubspot_update_ticket']),
  zendesk: Object.freeze(['zendesk_search_tickets', 'zendesk_create_ticket', 'zendesk_update_ticket']),
  todoist: Object.freeze(['todoist_list_tasks', 'todoist_create_task', 'todoist_update_task']),
  dropbox: Object.freeze(['dropbox_list_files', 'dropbox_create_text_file', 'dropbox_update_text_file']),
  onedrive: Object.freeze(['onedrive_list_files', 'onedrive_create_text_file', 'onedrive_update_text_file', 'microsoft_teams_list_channels', 'microsoft_teams_read_channel_messages', 'microsoft_teams_send_channel_message']),
  confluence: Object.freeze(['confluence_search_pages', 'confluence_create_page', 'confluence_update_page']),
  salesforce: Object.freeze(['salesforce_query_records', 'salesforce_create_record', 'salesforce_update_record']),
  qq_mail: Object.freeze(['qq_mail_list_recent', 'qq_mail_read', 'qq_mail_send']),
  gmail: Object.freeze(['mail_list_recent', 'mail_read', 'mail_send']),
  outlook: Object.freeze(['mail_list_recent', 'mail_read', 'mail_send']),
  exchange: Object.freeze(['mail_list_recent', 'mail_read', 'mail_send']),
  custom_mail: Object.freeze(['mail_list_recent', 'mail_read', 'mail_send']),
  discord: Object.freeze(['discord_list_channels', 'discord_read_messages', 'discord_send_message']),
})
const BROWSER_CONNECTOR_TOOLS = Object.freeze(['connected_app_list', 'connected_app_open'])

function newId() {
  return crypto.randomUUID?.() || `integration-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const WEB_PROVIDER_REGISTRY = Object.fromEntries(WEB_CONNECTOR_CATALOG.map((connector) => [
  connector.provider,
  {
    kind: 'browser_app',
    label: connector.label,
    fields: [],
    test: testBrowserApp,
  },
]))

const PROVIDER_REGISTRY = {
  // Access connectors
  browser: {
    kind: 'connector',
    label: 'Browser',
    fields: [],
    test: testBrowser,
  },
  notion: {
    kind: 'connector',
    label: 'Notion',
    fields: [
      { key: 'workspace', label: 'Workspace name', location: 'config', optional: true },
      { key: 'token', label: 'Integration token', location: 'secret', type: 'password' },
    ],
    test: testNotion,
  },
  github: {
    kind: 'connector',
    label: 'GitHub',
    fields: [
      { key: 'account', label: 'Account', location: 'config', optional: true },
      { key: 'token', label: 'Fine-grained personal access token', location: 'secret', type: 'password' },
    ],
    test: testGithub,
  },
  google_drive: {
    kind: 'connector',
    label: 'Google Drive',
    fields: [
      { key: 'account', label: 'Account', location: 'config', optional: true },
      { key: 'token', label: 'OAuth access token', location: 'secret', type: 'password' },
      { key: 'refreshToken', label: 'OAuth refresh token', location: 'secret', type: 'password', optional: true },
    ],
    test: testGoogleDrive,
  },
  google_calendar: {
    kind: 'connector',
    label: 'Google Calendar',
    fields: [
      { key: 'account', label: 'Account', location: 'config', optional: true },
      { key: 'token', label: 'OAuth access token', location: 'secret', type: 'password' },
    ],
    test: testGoogleCalendar,
  },
  jira: {
    kind: 'connector',
    label: 'Jira Cloud',
    fields: [
      { key: 'siteUrl', label: 'Jira site URL', location: 'config' },
      { key: 'email', label: 'Atlassian account email', location: 'config' },
      { key: 'token', label: 'Jira API token', location: 'secret', type: 'password' },
    ],
    test: testJira,
  },
  linear: {
    kind: 'connector',
    label: 'Linear',
    fields: [{ key: 'token', label: 'Personal API key', location: 'secret', type: 'password' }],
    test: testLinear,
  },
  trello: {
    kind: 'connector',
    label: 'Trello',
    fields: [
      { key: 'apiKey', label: 'API key', location: 'config' },
      { key: 'token', label: 'User token', location: 'secret', type: 'password' },
    ],
    test: testTrello,
  },
  gitlab: {
    kind: 'connector', label: 'GitLab',
    fields: [{ key: 'baseUrl', label: 'API URL', location: 'config', optional: true }, { key: 'token', label: 'Personal access token', location: 'secret', type: 'password' }],
    test: testGitlab,
  },
  asana: {
    kind: 'connector', label: 'Asana', fields: [{ key: 'token', label: 'Personal access token', location: 'secret', type: 'password' }], test: testAsana,
  },
  clickup: {
    kind: 'connector', label: 'ClickUp', fields: [{ key: 'token', label: 'Personal API token', location: 'secret', type: 'password' }], test: testClickup,
  },
  airtable: {
    kind: 'connector', label: 'Airtable', fields: [{ key: 'token', label: 'Personal access token', location: 'secret', type: 'password' }], test: testAirtable,
  },
  monday: {
    kind: 'connector', label: 'monday.com', fields: [{ key: 'token', label: 'Personal API token', location: 'secret', type: 'password' }], test: testMonday,
  },
  hubspot: {
    kind: 'connector', label: 'HubSpot', fields: [{ key: 'token', label: 'Private app access token', location: 'secret', type: 'password' }], test: testHubspot,
  },
  zendesk: {
    kind: 'connector', label: 'Zendesk', fields: [
      { key: 'subdomain', label: 'Zendesk subdomain', location: 'config' },
      { key: 'email', label: 'Agent email', location: 'config' },
      { key: 'token', label: 'API token', location: 'secret', type: 'password' },
    ], test: testZendesk,
  },
  todoist: {
    kind: 'connector', label: 'Todoist', fields: [{ key: 'token', label: 'API token', location: 'secret', type: 'password' }], test: testTodoist,
  },
  dropbox: {
    kind: 'connector', label: 'Dropbox', fields: [{ key: 'token', label: 'OAuth access token', location: 'secret', type: 'password' }], test: testDropbox,
  },
  onedrive: {
    kind: 'connector', label: 'OneDrive', fields: [{ key: 'token', label: 'Microsoft Graph access token', location: 'secret', type: 'password' }], test: testOneDrive,
  },
  confluence: {
    kind: 'connector', label: 'Confluence Cloud', fields: [
      { key: 'siteUrl', label: 'Atlassian site URL', location: 'config' },
      { key: 'email', label: 'Atlassian account email', location: 'config' },
      { key: 'token', label: 'API token', location: 'secret', type: 'password' },
    ], test: testConfluence,
  },
  salesforce: {
    kind: 'connector', label: 'Salesforce', fields: [
      { key: 'instanceUrl', label: 'Instance URL', location: 'config' },
      { key: 'token', label: 'OAuth access token', location: 'secret', type: 'password' },
    ], test: testSalesforce,
  },
  qq_mail: {
    kind: 'connector',
    label: 'QQ Mail',
    fields: [
      { key: 'user', label: 'QQ email address', location: 'config', optional: true },
      { key: 'from', label: 'Sender address', location: 'config', optional: true },
      { key: 'smtpHost', label: 'SMTP host', location: 'config', optional: true, defaultValue: 'smtp.qq.com' },
      { key: 'smtpPort', label: 'SMTP port', location: 'config', optional: true, type: 'number', defaultValue: 465 },
      { key: 'imapHost', label: 'IMAP host', location: 'config', optional: true, defaultValue: 'imap.qq.com' },
      { key: 'imapPort', label: 'IMAP port', location: 'config', optional: true, type: 'number', defaultValue: 993 },
      { key: 'password', label: 'QQ Mail authorization code', location: 'secret', type: 'password', optional: true },
    ],
    test: testQqMailCredentials,
  },
  ...Object.fromEntries([
    ['gmail', 'Gmail'],
    ['outlook', 'Outlook'],
    ['exchange', 'Exchange'],
    ['custom_mail', 'Custom Mail'],
  ].map(([provider, label]) => [provider, {
    kind: 'connector',
    label,
    fields: [
      { key: 'user', label: 'Email address', location: 'config' },
      { key: 'from', label: 'Sender address', location: 'config', optional: true },
      { key: 'smtpHost', label: 'SMTP host', location: 'config', optional: provider !== 'custom_mail' },
      { key: 'smtpPort', label: 'SMTP port', location: 'config', optional: true, type: 'number' },
      { key: 'imapHost', label: 'IMAP host', location: 'config', optional: provider !== 'custom_mail' },
      { key: 'imapPort', label: 'IMAP port', location: 'config', optional: true, type: 'number' },
      { key: 'password', label: 'App password', location: 'secret', type: 'password' },
    ],
    test: (options) => testMailCredentials({ provider, ...options }),
  }])),
  // === IM / 社交（kind='social'）===
  feishu: {
    kind: 'social',
    label: '飞书 / Lark',
    fields: {
      config: ['appId'],
      secret: ['appSecret'],
      optional: {
        config: ['botName', 'defaultAgentId'],
        secret: ['verificationToken', 'encryptKey'],
      },
    },
    test: testFeishu,
  },
  wechat_official: {
    kind: 'social',
    label: '微信公众号',
    fields: { config: ['appId'], secret: ['appSecret', 'token', 'encodingAesKey'] },
    test: testWechatOfficial,
  },
  wechat_personal: {
    kind: 'social',
    label: '企业微信 / Work',
    fields: { config: ['botId', 'baseUrl', 'defaultAgentId'], secret: ['botToken'] },
    test: testWechatPersonal,
  },
  wechat_work: {
    kind: 'social',
    label: '企业微信 (Work API)',
    fields: { config: ['corpId'], secret: ['corpSecret'] },
    test: testWechatWork,
  },
  dingtalk: {
    kind: 'social',
    label: '钉钉',
    fields: { config: ['appKey'], secret: ['appSecret'] },
    test: testDingtalk,
  },
  qq: {
    kind: 'social',
    label: 'QQ 开放平台',
    fields: { config: ['appId', 'defaultAgentId'], secret: ['appSecret', 'token'] },
    test: testQQ,
  },
  discord: {
    kind: 'social',
    label: 'Discord',
    fields: { config: ['applicationId'], secret: ['botToken'] },
    test: testDiscord,
  },
  telegram: {
    kind: 'social',
    label: 'Telegram',
    fields: {
      config: ['botUsername', 'mode', 'defaultAgentId'],
      secret: ['botToken'],
      optional: { secret: ['webhookSecret'] },
    },
    test: testTelegram,
  },
  slack: {
    kind: 'social',
    label: 'Slack',
    fields: { config: ['workspace'], secret: ['botToken', 'signingSecret'] },
    test: testSlack,
  },
  webhook: {
    kind: 'social',
    label: '自定义 Webhook',
    fields: { config: ['url', 'method'], secret: ['signingSecret'] },
    test: testWebhook,
  },

  // === 视觉辅助副驾（kind='vision_assist'）===
  vision_assist: {
    kind: 'vision_assist',
    label: '视觉辅助副驾（多模态描述模型）',
    fields: {
      config: ['baseUrl', 'modelName', 'language', 'maxImages'],
      secret: ['apiKey'],
    },
    test: testVisionAssist,
  },
  ...WEB_PROVIDER_REGISTRY,
}

export function listProviderRegistry() {
  return Object.entries(PROVIDER_REGISTRY).map(([provider, meta]) => {
    const nativeTools = NATIVE_CONNECTOR_TOOLS[provider]
    const browserShortcut = meta.kind === 'browser_app' || provider === 'browser'
    const capabilityLevel = nativeTools
      ? 'native_api'
      : (browserShortcut ? 'browser_shortcut' : (meta.kind === 'social' ? 'social_bridge' : null))
    return {
      provider,
      kind: meta.kind,
      label: meta.label,
      fields: meta.fields,
      capabilityLevel,
      integrationDepth: nativeTools
        ? 'provider_api'
        : (browserShortcut ? 'browser_navigation_only' : (meta.kind === 'social' ? 'provider_bridge' : null)),
      providerSpecificTools: nativeTools ? [...nativeTools] : [],
      availableTools: nativeTools
        ? [...nativeTools]
        : (meta.kind === 'browser_app'
            ? ['connected_app_open']
            : (provider === 'browser' ? [...BROWSER_CONNECTOR_TOOLS] : [])),
    }
  })
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function readIntegrationSecret(row) {
  if (!row) return {}
  const decoded = openCredentialObject(row.secret_json, {
    purpose: INTEGRATION_SECRET_PURPOSE,
    legacyDecoder: (raw) => parseJson(raw, {}),
  })
  if (decoded.legacy && row.id && Object.keys(decoded.value).length) {
    getDb().prepare('UPDATE integrations SET secret_json = ? WHERE id = ?')
      .run(sealCredentialObject(decoded.value, { purpose: INTEGRATION_SECRET_PURPOSE }), row.id)
  }
  return decoded.value
}

function writeIntegrationSecret(secret) {
  return sealCredentialObject(secret || {}, { purpose: INTEGRATION_SECRET_PURPOSE })
}

function maskSecret(secret) {
  const out = {}
  for (const [key, val] of Object.entries(secret || {})) {
    if (val == null || val === '') { out[key] = { present: false }; continue }
    const str = String(val)
    if (/password|authorization.?code/i.test(key)) {
      out[key] = { present: true }
      continue
    }
    out[key] = {
      present: true,
      preview: str.length <= 6 ? '*'.repeat(str.length) : `${str.slice(0, 2)}***${str.slice(-2)}`,
    }
  }
  return out
}

function row2integration(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    provider: row.provider,
    name: row.name || '',
    enabled: row.enabled === 1,
    config: parseJson(row.config_json, {}),
    // 仅返回脱敏视图；如需读取真实值请用 getIntegrationSecret
    secret: maskSecret(readIntegrationSecret(row)),
    lastTest: row.last_test_at ? {
      at: row.last_test_at,
      ok: row.last_test_ok === 1,
      message: row.last_test_message || '',
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function row2integrationCredentials(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    provider: row.provider,
    name: row.name || '',
    enabled: row.enabled === 1,
    config: parseJson(row.config_json, {}),
    secret: readIntegrationSecret(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listIntegrations({ userId, kind = null } = {}) {
  if (!userId) return []
  const db = getDb()
  const rows = kind
    ? db.prepare('SELECT * FROM integrations WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC').all(userId, kind)
    : db.prepare('SELECT * FROM integrations WHERE user_id = ? ORDER BY kind, updated_at DESC').all(userId)
  return rows.map(row2integration)
}

/**
 * Return only connector tools backed by an enabled integration for this user.
 * Keeping this lookup next to the provider registry prevents the turn runtime
 * from advertising credentials/capabilities that do not actually exist.
 */
export function listEnabledIntegrationToolNames({ userId } = {}) {
  if (!userId) return []
  const names = new Set()
  for (const integration of listIntegrations({ userId })) {
    if (!integration.enabled) continue
    const nativeTools = NATIVE_CONNECTOR_TOOLS[integration.provider]
    if (nativeTools) {
      for (const name of nativeTools) names.add(name)
      continue
    }
    const meta = PROVIDER_REGISTRY[integration.provider]
    if (integration.provider === 'browser') {
      for (const name of BROWSER_CONNECTOR_TOOLS) names.add(name)
    } else if (meta?.kind === 'browser_app') {
      names.add('connected_app_open')
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'en'))
}

export function listEnabledIntegrationCredentials({ kind = 'social' } = {}) {
  const rows = getDb().prepare(`
    SELECT * FROM integrations
    WHERE enabled = 1 AND kind = ?
    ORDER BY updated_at DESC
  `).all(kind)
  return rows.map(row2integrationCredentials)
}

export function getIntegrationCredentialsById({ userId, id }) {
  if (!userId || !id) return null
  const row = getDb().prepare('SELECT * FROM integrations WHERE user_id = ? AND id = ?').get(userId, id)
  return row2integrationCredentials(row)
}

export function getIntegration({ userId, id }) {
  if (!userId || !id) return null
  const row = getDb().prepare('SELECT * FROM integrations WHERE user_id = ? AND id = ?').get(userId, id)
  return row2integration(row)
}

function findByProvider({ userId, provider }) {
  return getDb().prepare('SELECT * FROM integrations WHERE user_id = ? AND provider = ?').get(userId, provider)
}

function getIntegrationSecretInternal({ userId, id }) {
  const row = getDb().prepare('SELECT id, secret_json, config_json FROM integrations WHERE user_id = ? AND id = ?').get(userId, id)
  if (!row) return null
  return {
    config: parseJson(row.config_json, {}),
    secret: readIntegrationSecret(row),
  }
}

export function getIntegrationByProvider({ userId, provider }) {
  const row = findByProvider({ userId, provider })
  return row2integration(row)
}

export function isIntegrationEnabled({ userId, provider, defaultEnabled = false }) {
  const row = findByProvider({ userId, provider })
  return row ? row.enabled === 1 : !!defaultEnabled
}

// 给后端服务（不通过 API）读真实凭据：例：调度器拉 enabled=true 的 IM 配置
export function getEnabledIntegrationCredentials({ userId, provider }) {
  const row = findByProvider({ userId, provider })
  if (!row || row.enabled !== 1) return null
  return {
    config: parseJson(row.config_json, {}),
    secret: readIntegrationSecret(row),
  }
}

function mergeSecret(existing = {}, incoming = {}) {
  // 只在 incoming 提供了非空值时覆盖；空字符串 = 用户清空；undefined = 不动
  const merged = { ...existing }
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined) continue
    if (value === '' || value === null) {
      delete merged[key]
    } else {
      merged[key] = String(value)
    }
  }
  return merged
}

export function upsertIntegration({ userId, id, provider, name, enabled, config, secret }) {
  if (!userId) throw badRequest('userId required')
  if (!provider || !PROVIDER_REGISTRY[provider]) throw badRequest(`unknown provider: ${provider}`)

  const meta = PROVIDER_REGISTRY[provider]
  const now = Date.now()
  const db = getDb()

  let row = id ? db.prepare('SELECT * FROM integrations WHERE user_id = ? AND id = ?').get(userId, id) : null
  if (!row) {
    row = findByProvider({ userId, provider })
  }

  const nextEnabled = enabled === undefined ? (row ? row.enabled === 1 : true) : !!enabled
  const nextConfig = config === undefined ? parseJson(row?.config_json, {}) : (config || {})
  const existingSecret = readIntegrationSecret(row)
  const nextSecret = mergeSecret(existingSecret, secret || {})
  const nextName = name === undefined ? (row?.name || meta.label) : (name || meta.label)

  if (row) {
    db.prepare(`UPDATE integrations
      SET name = ?, enabled = ?, config_json = ?, secret_json = ?, updated_at = ?
      WHERE id = ?`).run(
      nextName, nextEnabled ? 1 : 0, JSON.stringify(nextConfig), writeIntegrationSecret(nextSecret), now, row.id,
    )
    return getIntegration({ userId, id: row.id })
  }

  const newRowId = id || newId()
  db.prepare(`INSERT INTO integrations
    (id, user_id, kind, provider, name, enabled, config_json, secret_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newRowId, userId, meta.kind, provider, nextName, nextEnabled ? 1 : 0,
    JSON.stringify(nextConfig), writeIntegrationSecret(nextSecret), now, now,
  )
  return getIntegration({ userId, id: newRowId })
}

export function setIntegrationEnabled({ userId, id, enabled }) {
  const integration = getIntegration({ userId, id })
  if (!integration) throw notFound('integration not found')
  getDb().prepare('UPDATE integrations SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id)
  return getIntegration({ userId, id })
}

export function deleteIntegration({ userId, id }) {
  const integration = getIntegration({ userId, id })
  if (!integration) return false
  getDb().prepare('DELETE FROM integrations WHERE user_id = ? AND id = ?').run(userId, id)
  return true
}

export async function testProviderCredentials({
  provider,
  config = {},
  secret = {},
  fetchImpl = fetch,
  env = process.env,
  mailClient,
}) {
  const meta = PROVIDER_REGISTRY[provider]
  if (!meta) throw badRequest(`unknown provider: ${provider}`)
  return meta.test({ config, secret, fetchImpl, env, mailClient })
}

export async function testIntegration({ userId, id, fetchImpl = fetch, env = process.env, mailClient }) {
  const integration = getIntegration({ userId, id })
  if (!integration) throw notFound('integration not found')
  const meta = PROVIDER_REGISTRY[integration.provider]
  if (!meta) throw badRequest(`unknown provider: ${integration.provider}`)

  const creds = getIntegrationSecretInternal({ userId, id })
  let result
  try {
    result = await testProviderCredentials({
      provider: integration.provider,
      config: creds.config,
      secret: creds.secret,
      fetchImpl,
      env,
      mailClient,
    })
  } catch (err) {
    result = { ok: false, message: err?.message || '未知错误' }
  }
  const now = Date.now()
  getDb().prepare(`UPDATE integrations
    SET last_test_at = ?, last_test_ok = ?, last_test_message = ?, updated_at = ?
    WHERE id = ?`).run(now, result.ok ? 1 : 0, String(result.message || '').slice(0, 500), now, id)
  return { ...result, at: now }
}

// ============ provider 测试器（最小成本探测，绝不发推送） ============

async function jsonFetch({ fetchImpl, url, init = {}, timeoutMs = 8000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { ok: response.ok, status: response.status, data }
  } finally {
    clearTimeout(timer)
  }
}

async function testBrowser() {
  return { ok: true, message: 'Browser automation is available locally' }
}

async function testBrowserApp() {
  return { ok: true, message: 'Browser app connection is ready for local task assistance' }
}

async function testNotion({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing Notion Integration Token' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://api.notion.com/v1/users/me',
    init: {
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
      },
    },
  })
  if (!ok || !data?.id) return { ok: false, message: `Notion ${status}: ${data?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to Notion ${data.name || data.type || 'integration'}` }
}

async function testGithub({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing GitHub fine-grained PAT' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://api.github.com/user',
    init: {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Gugo',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  })
  if (!ok || !data?.login) return { ok: false, message: `GitHub ${status}: ${data?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to GitHub @${data.login}` }
}

async function testGoogleDrive({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing Google Drive access token' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)',
    init: { headers: { Authorization: `Bearer ${token}` } },
  })
  if (!ok || !data?.user) {
    return { ok: false, message: `Google Drive ${status}: ${data?.error?.message || 'authentication failed'}` }
  }
  return {
    ok: true,
    message: `Connected to Google Drive ${data.user.emailAddress || data.user.displayName || ''}`.trim(),
  }
}

async function testGoogleCalendar({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing Google Calendar access token' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
    init: { headers: { Authorization: `Bearer ${token}` } },
  })
  if (!ok) return { ok: false, message: `Google Calendar ${status}: ${data?.error?.message || 'authentication failed'}` }
  return { ok: true, message: 'Connected to Google Calendar' }
}

async function testJira({ config, secret, fetchImpl }) {
  const siteUrl = config?.siteUrl?.trim().replace(/\/+$/, '')
  const email = config?.email?.trim()
  const token = secret?.token?.trim()
  if (!siteUrl || !email || !token) return { ok: false, message: 'Missing Jira site URL, email, or API token' }
  if (!/^https:\/\//i.test(siteUrl)) return { ok: false, message: 'Jira site URL must use HTTPS' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: `${siteUrl}/rest/api/3/myself`,
    init: { headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, Accept: 'application/json' } },
  })
  if (!ok || !data?.accountId) return { ok: false, message: `Jira ${status}: ${data?.errorMessages?.join?.('; ') || data?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to Jira as ${data.displayName || email}` }
}

async function testLinear({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing Linear API key' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://api.linear.app/graphql',
    init: { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { id name email } }' }) },
  })
  if (!ok || data?.errors?.length || !data?.data?.viewer?.id) return { ok: false, message: `Linear ${status}: ${data?.errors?.[0]?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to Linear as ${data.data.viewer.name || data.data.viewer.email || 'user'}` }
}

async function testTrello({ config, secret, fetchImpl }) {
  const apiKey = config?.apiKey?.trim()
  const token = secret?.token?.trim()
  if (!apiKey || !token) return { ok: false, message: 'Missing Trello API key or token' }
  const url = new URL('https://api.trello.com/1/members/me')
  url.searchParams.set('key', apiKey)
  url.searchParams.set('token', token)
  url.searchParams.set('fields', 'id,username,fullName')
  const { ok, status, data } = await jsonFetch({ fetchImpl, url })
  if (!ok || !data?.id) return { ok: false, message: `Trello ${status}: ${data?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to Trello as ${data.fullName || data.username}` }
}

async function testGitlab({ config, secret, fetchImpl }) {
  const token = secret?.token?.trim()
  const baseUrl = (config?.baseUrl?.trim() || 'https://gitlab.com/api/v4').replace(/\/+$/, '')
  if (!token) return { ok: false, message: 'Missing GitLab personal access token' }
  if (!/^https:\/\//i.test(baseUrl)) return { ok: false, message: 'GitLab API URL must use HTTPS' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: `${baseUrl}/user`, init: { headers: { 'PRIVATE-TOKEN': token } } })
  if (!ok || !data?.id) return { ok: false, message: `GitLab ${status}: ${data?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to GitLab as ${data.username || data.name}` }
}

async function testAsana({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing Asana personal access token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: 'https://app.asana.com/api/1.0/users/me', init: { headers: { Authorization: `Bearer ${token}` } } })
  if (!ok || !data?.data?.gid) return { ok: false, message: `Asana ${status}: ${data?.errors?.[0]?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to Asana as ${data.data.name || data.data.email}` }
}

async function testClickup({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing ClickUp API token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: 'https://api.clickup.com/api/v2/user', init: { headers: { Authorization: token } } })
  if (!ok || !data?.user?.id) return { ok: false, message: `ClickUp ${status}: ${data?.err || 'authentication failed'}` }
  return { ok: true, message: `Connected to ClickUp as ${data.user.username || data.user.email}` }
}

async function testAirtable({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing Airtable personal access token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: 'https://api.airtable.com/v0/meta/whoami', init: { headers: { Authorization: `Bearer ${token}` } } })
  if (!ok || !data?.id) return { ok: false, message: `Airtable ${status}: ${data?.error?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to Airtable as ${data.email || data.id}` }
}

async function testMonday({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing monday.com API token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: 'https://api.monday.com/v2', init: { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json', 'API-Version': '2025-04' }, body: JSON.stringify({ query: '{ me { id name email } }' }) } })
  if (!ok || data?.errors?.length || !data?.data?.me?.id) return { ok: false, message: `monday.com ${status}: ${data?.errors?.[0]?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to monday.com as ${data.data.me.name || data.data.me.email}` }
}

async function testBearerEndpoint({ provider, secret, fetchImpl, url, validate, label = provider, method = 'GET', body }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: `Missing ${label} access token` }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url, init: { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) } })
  if (!ok || !validate(data)) return { ok: false, message: `${label} ${status}: ${data?.error?.message || data?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to ${label}` }
}

function testHubspot({ secret, fetchImpl }) {
  return testBearerEndpoint({ provider: 'hubspot', secret, fetchImpl, url: 'https://api.hubapi.com/account-info/v3/details', validate: (data) => !!(data?.portalId || data?.accountType), label: 'HubSpot' })
}

async function testZendesk({ config, secret, fetchImpl }) {
  const subdomain = config?.subdomain?.trim()?.replace(/[^a-z0-9-]/gi, '')
  const email = config?.email?.trim()
  const token = secret?.token?.trim()
  if (!subdomain || !email || !token) return { ok: false, message: 'Missing Zendesk subdomain, email, or API token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: `https://${subdomain}.zendesk.com/api/v2/users/me.json`, init: { headers: { Authorization: `Basic ${Buffer.from(`${email}/token:${token}`).toString('base64')}` } } })
  if (!ok || !data?.user?.id) return { ok: false, message: `Zendesk ${status}: ${data?.error || 'authentication failed'}` }
  return { ok: true, message: `Connected to Zendesk as ${data.user.name || email}` }
}

function testTodoist({ secret, fetchImpl }) {
  return testBearerEndpoint({ provider: 'todoist', secret, fetchImpl, url: 'https://api.todoist.com/rest/v2/projects', validate: Array.isArray, label: 'Todoist' })
}

function testDropbox({ secret, fetchImpl }) {
  return testBearerEndpoint({ provider: 'dropbox', secret, fetchImpl, url: 'https://api.dropboxapi.com/2/users/get_current_account', validate: (data) => !!data?.account_id, label: 'Dropbox', method: 'POST' })
}

function testOneDrive({ secret, fetchImpl }) {
  return testBearerEndpoint({ provider: 'onedrive', secret, fetchImpl, url: 'https://graph.microsoft.com/v1.0/me/drive', validate: (data) => !!data?.id, label: 'OneDrive' })
}

async function testConfluence({ config, secret, fetchImpl }) {
  const siteUrl = config?.siteUrl?.trim()?.replace(/\/+$/, '')
  const email = config?.email?.trim()
  const token = secret?.token?.trim()
  if (!siteUrl || !email || !token) return { ok: false, message: 'Missing Confluence site URL, email, or API token' }
  if (!/^https:\/\//i.test(siteUrl)) return { ok: false, message: 'Confluence site URL must use HTTPS' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: `${siteUrl}/wiki/api/v2/spaces?limit=1`, init: { headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } } })
  if (!ok || !Array.isArray(data?.results)) return { ok: false, message: `Confluence ${status}: ${data?.message || 'authentication failed'}` }
  return { ok: true, message: 'Connected to Confluence Cloud' }
}

async function testSalesforce({ config, secret, fetchImpl }) {
  const instanceUrl = config?.instanceUrl?.trim()?.replace(/\/+$/, '')
  const token = secret?.token?.trim()
  if (!instanceUrl || !token) return { ok: false, message: 'Missing Salesforce instance URL or access token' }
  if (!/^https:\/\//i.test(instanceUrl)) return { ok: false, message: 'Salesforce instance URL must use HTTPS' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: `${instanceUrl}/services/data/v61.0/limits`, init: { headers: { Authorization: `Bearer ${token}` } } })
  if (!ok || typeof data !== 'object') return { ok: false, message: `Salesforce ${status}: ${data?.[0]?.message || 'authentication failed'}` }
  return { ok: true, message: 'Connected to Salesforce' }
}

async function testFeishu({ config, secret, fetchImpl }) {
  const appId = config?.appId?.trim()
  const appSecret = secret?.appSecret?.trim()
  if (!appId || !appSecret) return { ok: false, message: '缺少 appId 或 appSecret' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) },
  })
  if (!ok || (data && data.code && data.code !== 0)) {
    return { ok: false, message: `Feishu ${status}: ${data?.msg || data?.message || '鉴权失败'}` }
  }
  return { ok: true, message: 'tenant_access_token 获取成功' }
}

async function testWechatOfficial({ config, secret, fetchImpl }) {
  const appId = config?.appId?.trim()
  const appSecret = secret?.appSecret?.trim()
  if (!appId || !appSecret) return { ok: false, message: '缺少 appId 或 appSecret' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`,
  })
  if (!ok || !data?.access_token) {
    return { ok: false, message: `WeChat ${status}: ${data?.errmsg || '鉴权失败'}` }
  }
  return { ok: true, message: `access_token 获取成功（有效期 ${data.expires_in}s）` }
}

async function testWechatWork({ config, secret, fetchImpl }) {
  const corpId = config?.corpId?.trim()
  const corpSecret = secret?.corpSecret?.trim()
  if (!corpId || !corpSecret) return { ok: false, message: '缺少 corpId 或 corpSecret' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`,
  })
  if (!ok || !data?.access_token) {
    return { ok: false, message: `企业微信 ${status}: ${data?.errmsg || '鉴权失败'}` }
  }
  return { ok: true, message: `access_token 获取成功（有效期 ${data.expires_in}s）` }
}

async function testWechatPersonal({ secret }) {
  const botToken = secret?.botToken?.trim()
  if (!botToken) return { ok: false, message: '缺少 botToken；请先扫码登录个人微信机器人' }
  return { ok: true, message: 'botToken 已保存。启用后会通过 iLink 长轮询接收个人微信消息。' }
}

async function testDingtalk({ config, secret, fetchImpl }) {
  const appKey = config?.appKey?.trim()
  const appSecret = secret?.appSecret?.trim()
  if (!appKey || !appSecret) return { ok: false, message: '缺少 appKey 或 appSecret' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appKey, appSecret }) },
  })
  if (!ok || !data?.accessToken) {
    return { ok: false, message: `钉钉 ${status}: ${data?.message || data?.errmsg || '鉴权失败'}` }
  }
  return { ok: true, message: `accessToken 获取成功（有效期 ${data.expireIn}s）` }
}

async function testQQ({ config, secret }) {
  // QQ 开放平台无统一公开 token 端点，做字段完整性校验即可
  const appId = config?.appId?.trim()
  const appSecret = secret?.appSecret?.trim()
  const token = secret?.token?.trim()
  if (!appId || !appSecret || !token) {
    return { ok: false, message: '缺少 appId / appSecret / token，请补全后再测试' }
  }
  return { ok: true, message: '字段完整。QQ 开放平台无公开探测端点，请通过实际机器人事件验证' }
}

async function testDiscord({ secret, fetchImpl }) {
  const botToken = secret?.botToken?.trim()
  if (!botToken) return { ok: false, message: '缺少 botToken' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://discord.com/api/v10/users/@me',
    init: { headers: { Authorization: `Bot ${botToken}` } },
  })
  if (!ok || !data?.id) {
    return { ok: false, message: `Discord ${status}: ${data?.message || '鉴权失败'}` }
  }
  return { ok: true, message: `已识别 Bot ${data.username}#${data.discriminator || '0'} (id=${data.id})` }
}

async function testTelegram({ secret, fetchImpl }) {
  const botToken = secret?.botToken?.trim()
  if (!botToken) return { ok: false, message: '缺少 botToken' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`,
  })
  if (!ok || !data?.ok) {
    return { ok: false, message: `Telegram ${status}: ${data?.description || '鉴权失败'}` }
  }
  return { ok: true, message: `已识别 Bot @${data.result?.username}` }
}

async function testSlack({ secret, fetchImpl }) {
  const botToken = secret?.botToken?.trim()
  if (!botToken) return { ok: false, message: '缺少 botToken' }
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url: 'https://slack.com/api/auth.test',
    init: { method: 'POST', headers: { Authorization: `Bearer ${botToken}` } },
  })
  if (!ok || !data?.ok) {
    return { ok: false, message: `Slack ${status}: ${data?.error || '鉴权失败'}` }
  }
  return { ok: true, message: `已识别 ${data.team} / ${data.user}` }
}

async function testWebhook({ config, fetchImpl }) {
  const url = config?.url?.trim()
  if (!url) return { ok: false, message: '缺少 url' }
  try {
    const { ok, status } = await jsonFetch({
      fetchImpl,
      url,
      init: { method: 'OPTIONS' },
      timeoutMs: 5000,
    })
    if (ok || (status >= 200 && status < 500)) {
      return { ok: true, message: `Webhook 可达（HTTP ${status}）` }
    }
    return { ok: false, message: `Webhook 不可达（HTTP ${status}）` }
  } catch (err) {
    return { ok: false, message: `Webhook 探测失败: ${err.message || err}` }
  }
}

async function testVisionAssist({ config, secret, fetchImpl }) {
  const baseUrl = (config?.baseUrl || '').trim().replace(/\/+$/, '')
  const modelName = (config?.modelName || '').trim()
  const apiKey = (secret?.apiKey || '').trim()
  if (!baseUrl || !modelName) {
    return { ok: false, message: '缺少 baseUrl / modelName' }
  }
  const url = `${baseUrl}/models`
  const headers = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url,
    init: { headers },
  })
  if (!ok) return { ok: false, message: `视觉副驾 ${status}: ${data?.error?.message || '鉴权失败'}` }
  const models = Array.isArray(data?.data) ? data.data.map((item) => item.id || item.name) : []
  if (models.length && !models.includes(modelName)) {
    return { ok: true, message: `端点可达，但未在 /models 列表中找到 ${modelName}（仍可尝试调用）` }
  }
  return { ok: true, message: `视觉副驾可达${models.length ? `，发现 ${models.length} 个模型` : ''}` }
}

// ============ helpers ============

function badRequest(message) { const e = new Error(message); e.statusCode = 400; return e }
function notFound(message)   { const e = new Error(message); e.statusCode = 404; return e }

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

function newId() {
  return crypto.randomUUID?.() || `integration-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const PROVIDER_REGISTRY = {
  // === IM / 社交（kind='social'）===
  feishu: {
    kind: 'social',
    label: '飞书 / Lark',
    fields: {
      config: ['appId', 'botName', 'defaultAgentId'],
      secret: ['appSecret', 'verificationToken', 'encryptKey'],
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
    fields: { config: ['botUsername', 'mode', 'defaultAgentId'], secret: ['botToken'] },
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
}

export function listProviderRegistry() {
  return Object.entries(PROVIDER_REGISTRY).map(([provider, meta]) => ({
    provider,
    kind: meta.kind,
    label: meta.label,
    fields: meta.fields,
  }))
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function maskSecret(secret) {
  const out = {}
  for (const [key, val] of Object.entries(secret || {})) {
    if (val == null || val === '') { out[key] = { present: false }; continue }
    const str = String(val)
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
    secret: maskSecret(parseJson(row.secret_json, {})),
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
    secret: parseJson(row.secret_json, {}),
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

export function listEnabledIntegrationCredentials({ kind = 'social' } = {}) {
  const rows = getDb().prepare(`
    SELECT * FROM integrations
    WHERE enabled = 1 AND kind = ?
    ORDER BY updated_at DESC
  `).all(kind)
  return rows.map(row2integrationCredentials)
}

export function getIntegrationCredentialsById({ id }) {
  if (!id) return null
  const row = getDb().prepare('SELECT * FROM integrations WHERE id = ?').get(id)
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
  const row = getDb().prepare('SELECT secret_json, config_json FROM integrations WHERE user_id = ? AND id = ?').get(userId, id)
  if (!row) return null
  return {
    config: parseJson(row.config_json, {}),
    secret: parseJson(row.secret_json, {}),
  }
}

export function getIntegrationByProvider({ userId, provider }) {
  const row = findByProvider({ userId, provider })
  return row2integration(row)
}

// 给后端服务（不通过 API）读真实凭据：例：调度器拉 enabled=true 的 IM 配置
export function getEnabledIntegrationCredentials({ userId, provider }) {
  const row = findByProvider({ userId, provider })
  if (!row || row.enabled !== 1) return null
  return {
    config: parseJson(row.config_json, {}),
    secret: parseJson(row.secret_json, {}),
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
  const existingSecret = parseJson(row?.secret_json, {})
  const nextSecret = mergeSecret(existingSecret, secret || {})
  const nextName = name === undefined ? (row?.name || meta.label) : (name || meta.label)

  if (row) {
    db.prepare(`UPDATE integrations
      SET name = ?, enabled = ?, config_json = ?, secret_json = ?, updated_at = ?
      WHERE id = ?`).run(
      nextName, nextEnabled ? 1 : 0, JSON.stringify(nextConfig), JSON.stringify(nextSecret), now, row.id,
    )
    return getIntegration({ userId, id: row.id })
  }

  const newRowId = id || newId()
  db.prepare(`INSERT INTO integrations
    (id, user_id, kind, provider, name, enabled, config_json, secret_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newRowId, userId, meta.kind, provider, nextName, nextEnabled ? 1 : 0,
    JSON.stringify(nextConfig), JSON.stringify(nextSecret), now, now,
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

export async function testIntegration({ userId, id, fetchImpl = fetch }) {
  const integration = getIntegration({ userId, id })
  if (!integration) throw notFound('integration not found')
  const meta = PROVIDER_REGISTRY[integration.provider]
  if (!meta) throw badRequest(`unknown provider: ${integration.provider}`)

  const creds = getIntegrationSecretInternal({ userId, id })
  let result
  try {
    result = await meta.test({ config: creds.config, secret: creds.secret, fetchImpl })
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
  if (!baseUrl || !modelName || !apiKey) {
    return { ok: false, message: '缺少 baseUrl / modelName / apiKey' }
  }
  const url = `${baseUrl}/models`
  const { ok, status, data } = await jsonFetch({
    fetchImpl,
    url,
    init: { headers: { Authorization: `Bearer ${apiKey}` } },
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

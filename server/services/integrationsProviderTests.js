import { isLocalEndpoint } from '../utils/endpointProfile.js'
import { fetchSafeOutbound } from '../utils/outboundNetworkGuard.js'

async function jsonFetch({ fetchImpl = fetch, url, init = {}, timeoutMs = 8000, lookup }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resolveDns = typeof lookup === 'function' || fetchImpl === globalThis.fetch
    const response = await fetchSafeOutbound(url, {
      ...init,
      signal: controller.signal,
    }, {
      fetchImpl,
      allowLocal: isLocalEndpoint(url),
      resolveDns,
      ...(typeof lookup === 'function' ? { lookup } : {}),
    })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { ok: response.ok, status: response.status, data }
  } finally {
    clearTimeout(timer)
  }
}

export async function testBrowser() {
  return { ok: true, message: 'Browser automation is available locally' }
}

export async function testBrowserApp() {
  return { ok: true, message: 'Browser app connection is ready for local task assistance' }
}

export async function testNotion({ secret, fetchImpl }) {
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

export async function testGithub({ secret, fetchImpl }) {
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

export async function testGoogleDrive({ secret, fetchImpl }) {
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

export async function testGoogleCalendar({ secret, fetchImpl }) {
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

export async function testJira({ config, secret, fetchImpl }) {
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

export async function testLinear({ secret, fetchImpl }) {
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

export async function testTrello({ config, secret, fetchImpl }) {
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

export async function testGitlab({ config, secret, fetchImpl }) {
  const token = secret?.token?.trim()
  const baseUrl = (config?.baseUrl?.trim() || 'https://gitlab.com/api/v4').replace(/\/+$/, '')
  if (!token) return { ok: false, message: 'Missing GitLab personal access token' }
  if (!/^https:\/\//i.test(baseUrl)) return { ok: false, message: 'GitLab API URL must use HTTPS' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: `${baseUrl}/user`, init: { headers: { 'PRIVATE-TOKEN': token } } })
  if (!ok || !data?.id) return { ok: false, message: `GitLab ${status}: ${data?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to GitLab as ${data.username || data.name}` }
}

export async function testAsana({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing Asana personal access token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: 'https://app.asana.com/api/1.0/users/me', init: { headers: { Authorization: `Bearer ${token}` } } })
  if (!ok || !data?.data?.gid) return { ok: false, message: `Asana ${status}: ${data?.errors?.[0]?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to Asana as ${data.data.name || data.data.email}` }
}

export async function testClickup({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing ClickUp API token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: 'https://api.clickup.com/api/v2/user', init: { headers: { Authorization: token } } })
  if (!ok || !data?.user?.id) return { ok: false, message: `ClickUp ${status}: ${data?.err || 'authentication failed'}` }
  return { ok: true, message: `Connected to ClickUp as ${data.user.username || data.user.email}` }
}

export async function testAirtable({ secret, fetchImpl }) {
  const token = secret?.token?.trim()
  if (!token) return { ok: false, message: 'Missing Airtable personal access token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: 'https://api.airtable.com/v0/meta/whoami', init: { headers: { Authorization: `Bearer ${token}` } } })
  if (!ok || !data?.id) return { ok: false, message: `Airtable ${status}: ${data?.error?.message || 'authentication failed'}` }
  return { ok: true, message: `Connected to Airtable as ${data.email || data.id}` }
}

export async function testMonday({ secret, fetchImpl }) {
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

export function testHubspot({ secret, fetchImpl }) {
  return testBearerEndpoint({ provider: 'hubspot', secret, fetchImpl, url: 'https://api.hubapi.com/account-info/v3/details', validate: (data) => !!(data?.portalId || data?.accountType), label: 'HubSpot' })
}

export async function testZendesk({ config, secret, fetchImpl }) {
  const subdomain = config?.subdomain?.trim()?.replace(/[^a-z0-9-]/gi, '')
  const email = config?.email?.trim()
  const token = secret?.token?.trim()
  if (!subdomain || !email || !token) return { ok: false, message: 'Missing Zendesk subdomain, email, or API token' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: `https://${subdomain}.zendesk.com/api/v2/users/me.json`, init: { headers: { Authorization: `Basic ${Buffer.from(`${email}/token:${token}`).toString('base64')}` } } })
  if (!ok || !data?.user?.id) return { ok: false, message: `Zendesk ${status}: ${data?.error || 'authentication failed'}` }
  return { ok: true, message: `Connected to Zendesk as ${data.user.name || email}` }
}

export function testTodoist({ secret, fetchImpl }) {
  return testBearerEndpoint({ provider: 'todoist', secret, fetchImpl, url: 'https://api.todoist.com/rest/v2/projects', validate: Array.isArray, label: 'Todoist' })
}

export function testDropbox({ secret, fetchImpl }) {
  return testBearerEndpoint({ provider: 'dropbox', secret, fetchImpl, url: 'https://api.dropboxapi.com/2/users/get_current_account', validate: (data) => !!data?.account_id, label: 'Dropbox', method: 'POST' })
}

export function testOneDrive({ secret, fetchImpl }) {
  return testBearerEndpoint({ provider: 'onedrive', secret, fetchImpl, url: 'https://graph.microsoft.com/v1.0/me/drive', validate: (data) => !!data?.id, label: 'OneDrive' })
}

export async function testConfluence({ config, secret, fetchImpl }) {
  const siteUrl = config?.siteUrl?.trim()?.replace(/\/+$/, '')
  const email = config?.email?.trim()
  const token = secret?.token?.trim()
  if (!siteUrl || !email || !token) return { ok: false, message: 'Missing Confluence site URL, email, or API token' }
  if (!/^https:\/\//i.test(siteUrl)) return { ok: false, message: 'Confluence site URL must use HTTPS' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: `${siteUrl}/wiki/api/v2/spaces?limit=1`, init: { headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } } })
  if (!ok || !Array.isArray(data?.results)) return { ok: false, message: `Confluence ${status}: ${data?.message || 'authentication failed'}` }
  return { ok: true, message: 'Connected to Confluence Cloud' }
}

export async function testSalesforce({ config, secret, fetchImpl }) {
  const instanceUrl = config?.instanceUrl?.trim()?.replace(/\/+$/, '')
  const token = secret?.token?.trim()
  if (!instanceUrl || !token) return { ok: false, message: 'Missing Salesforce instance URL or access token' }
  if (!/^https:\/\//i.test(instanceUrl)) return { ok: false, message: 'Salesforce instance URL must use HTTPS' }
  const { ok, status, data } = await jsonFetch({ fetchImpl, url: `${instanceUrl}/services/data/v61.0/limits`, init: { headers: { Authorization: `Bearer ${token}` } } })
  if (!ok || typeof data !== 'object') return { ok: false, message: `Salesforce ${status}: ${data?.[0]?.message || 'authentication failed'}` }
  return { ok: true, message: 'Connected to Salesforce' }
}

export async function testFeishu({ config, secret, fetchImpl }) {
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

export async function testWechatOfficial({ config, secret, fetchImpl }) {
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

export async function testWechatWork({ config, secret, fetchImpl }) {
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

export async function testWechatPersonal({ secret }) {
  const botToken = secret?.botToken?.trim()
  if (!botToken) return { ok: false, message: '缺少 botToken；请先扫码登录个人微信机器人' }
  return { ok: true, message: 'botToken 已保存。启用后会通过 iLink 长轮询接收个人微信消息。' }
}

export async function testDingtalk({ config, secret, fetchImpl }) {
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

export async function testQQ({ config, secret }) {
  // QQ 开放平台无统一公开 token 端点，做字段完整性校验即可
  const appId = config?.appId?.trim()
  const appSecret = secret?.appSecret?.trim()
  const token = secret?.token?.trim()
  if (!appId || !appSecret || !token) {
    return { ok: false, message: '缺少 appId / appSecret / token，请补全后再测试' }
  }
  return { ok: true, message: '字段完整。QQ 开放平台无公开探测端点，请通过实际机器人事件验证' }
}

export async function testDiscord({ secret, fetchImpl }) {
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

export async function testTelegram({ secret, fetchImpl }) {
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

export async function testSlack({ secret, fetchImpl }) {
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

export async function testWebhook({ config, fetchImpl }) {
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

export async function testVisionAssist({ config, secret, fetchImpl, lookup }) {
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
    lookup,
  })
  if (!ok) return { ok: false, message: `视觉副驾 ${status}: ${data?.error?.message || '鉴权失败'}` }
  const models = Array.isArray(data?.data) ? data.data.map((item) => item.id || item.name) : []
  if (models.length && !models.includes(modelName)) {
    return { ok: true, message: `端点可达，但未在 /models 列表中找到 ${modelName}（仍可尝试调用）` }
  }
  return { ok: true, message: `视觉副驾可达${models.length ? `，发现 ${models.length} 个模型` : ''}` }
}

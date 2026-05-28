const QQ_BASE = 'https://api.sgroup.qq.com'

function clean(value) {
  return String(value ?? '').trim()
}

function credentials(integration) {
  return {
    appId: clean(integration?.config?.appId || integration?.config?.appID),
    appSecret: clean(integration?.secret?.appSecret || integration?.secret?.clientSecret),
    token: clean(integration?.secret?.botToken || integration?.secret?.token),
  }
}

export function createQQBridgeAdapter({ integration, fetchImpl = fetch } = {}) {
  const creds = credentials(integration)
  let tokenCache = creds.token ? { token: creds.token, expiresAt: Number.MAX_SAFE_INTEGER } : null
  if (!creds.token && (!creds.appId || !creds.appSecret)) throw new Error('QQ appId/appSecret or bot token is required')

  async function accessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token
    const response = await fetchImpl(`${QQ_BASE}/app/getAppAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: creds.appId,
        clientSecret: creds.appSecret,
      }),
    })
    const data = await response.json().catch(() => null)
    const token = data?.access_token || data?.accessToken
    if (!response.ok || !token) throw new Error(data?.message || data?.error || `QQ HTTP ${response.status}`)
    tokenCache = {
      token,
      expiresAt: Date.now() + Math.max(60, Number(data.expires_in || data.expiresIn || 7200)) * 1000,
    }
    return token
  }

  async function qqPost(path, body) {
    const token = await accessToken()
    const response = await fetchImpl(`${QQ_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.message || data?.error || `QQ HTTP ${response.status}`)
    return data
  }

  return {
    async start() {},
    async stop() {},
    async sendMessage({ chatId, text, context = {} }) {
      const body = {
        content: clean(text),
      }
      if (context.messageId) body.msg_id = context.messageId
      const path = context.isGroup
        ? `/v2/groups/${encodeURIComponent(chatId)}/messages`
        : `/v2/users/${encodeURIComponent(chatId)}/messages`
      await qqPost(path, body)
    },
  }
}

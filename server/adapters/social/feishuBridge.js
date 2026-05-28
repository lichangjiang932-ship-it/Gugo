const FEISHU_BASE = 'https://open.feishu.cn/open-apis'

function clean(value) {
  return String(value ?? '').trim()
}

function credentials(integration) {
  return {
    appId: clean(integration?.config?.appId || integration?.secret?.appId),
    appSecret: clean(integration?.secret?.appSecret || integration?.config?.appSecret),
  }
}

export function createFeishuBridgeAdapter({ integration, fetchImpl = fetch } = {}) {
  const { appId, appSecret } = credentials(integration)
  if (!appId || !appSecret) throw new Error('Feishu appId and appSecret are required')
  let tokenCache = null

  async function tenantToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token
    const response = await fetchImpl(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || data?.code !== 0 || !data?.tenant_access_token) {
      throw new Error(data?.msg || data?.message || `Feishu HTTP ${response.status}`)
    }
    tokenCache = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, Number(data.expire || data.expires_in || 7200)) * 1000,
    }
    return tokenCache.token
  }

  async function feishuPost(path, body) {
    const token = await tenantToken()
    const response = await fetchImpl(`${FEISHU_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || (data?.code != null && data.code !== 0)) {
      throw new Error(data?.msg || data?.message || `Feishu HTTP ${response.status}`)
    }
    return data
  }

  return {
    async start() {},
    async stop() {},
    async sendMessage({ chatId, text, context = {} }) {
      const content = JSON.stringify({ text: clean(text) })
      if (context.messageId) {
        await feishuPost(`/im/v1/messages/${encodeURIComponent(context.messageId)}/reply`, {
          msg_type: 'text',
          content,
        })
        return
      }
      await feishuPost('/im/v1/messages?receive_id_type=chat_id', {
        receive_id: chatId,
        msg_type: 'text',
        content,
      })
    },
  }
}

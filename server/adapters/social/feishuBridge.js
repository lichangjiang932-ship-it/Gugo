import { fetchSafeOutbound } from '../../utils/outboundNetworkGuard.js'

const FEISHU_BASE = 'https://open.feishu.cn/open-apis'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

function clean(value) {
  return String(value ?? '').trim()
}

function credentials(integration) {
  return {
    appId: clean(integration?.config?.appId || integration?.secret?.appId),
    appSecret: clean(integration?.secret?.appSecret || integration?.config?.appSecret),
  }
}

function feishuUnavailable(error) {
  return Object.assign(new Error('Feishu bridge service is unavailable'), {
    code: 'FEISHU_BRIDGE_UNAVAILABLE',
    statusCode: 503,
    cause: error,
  })
}

function feishuFailure(message, code, {
  statusCode = 502,
  cause,
  upstreamStatus,
  retryable = false,
} = {}) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    retryable,
    ...(cause ? { cause } : {}),
    ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {}),
  })
}

function feishuTimeout(error) {
  return feishuFailure('Feishu bridge request timed out', 'FEISHU_BRIDGE_TIMEOUT', {
    statusCode: 504,
    cause: error,
    retryable: true,
  })
}

async function feishuJsonResponse(response) {
  if (!response.ok) {
    try { await response?.body?.cancel?.() } catch { /* best effort */ }
    throw feishuFailure('Feishu bridge upstream returned a non-success status', 'FEISHU_BRIDGE_HTTP_ERROR', {
      upstreamStatus: response.status,
      retryable: response.status === 429 || response.status >= 500,
    })
  }
  let data = null
  let parseError = null
  try { data = await response.json() } catch (error) { parseError = error }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw feishuFailure('Feishu bridge upstream returned invalid JSON', 'FEISHU_BRIDGE_RESPONSE_INVALID', {
      cause: parseError,
    })
  }
  return data
}

async function fetchFeishuOutbound(url, init, {
  fetchImpl = fetch,
  lookup,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const resolveDns = typeof lookup === 'function' || fetchImpl === globalThis.fetch
  const controller = new AbortController()
  const upstream = init?.signal
  const abortFromUpstream = () => controller.abort(upstream?.reason)
  if (upstream?.aborted) abortFromUpstream()
  else upstream?.addEventListener?.('abort', abortFromUpstream, { once: true })
  let timedOut = false
  let timeoutError = null
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      timeoutError = new Error('Feishu bridge request exceeded its deadline')
      controller.abort(timeoutError)
      reject(timeoutError)
    }, Math.max(1, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS))
  })
  try {
    return await Promise.race([
      fetchSafeOutbound(url, { ...init, signal: controller.signal }, {
        fetchImpl,
        allowLocal: false,
        resolveDns,
        ...(typeof lookup === 'function' ? { lookup } : {}),
      }).then(feishuJsonResponse),
      timeout,
    ])
  } catch (error) {
    if (timedOut) throw feishuTimeout(timeoutError || error)
    if (String(error?.code || '').startsWith('FEISHU_BRIDGE_')) throw error
    throw feishuUnavailable(error)
  } finally {
    clearTimeout(timer)
    upstream?.removeEventListener?.('abort', abortFromUpstream)
  }
}

export function createFeishuBridgeAdapter({
  integration,
  fetchImpl = fetch,
  lookup,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const { appId, appSecret } = credentials(integration)
  if (!appId || !appSecret) throw new Error('Feishu appId and appSecret are required')
  let tokenCache = null

  async function tenantToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token
    const data = await fetchFeishuOutbound(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }, { fetchImpl, lookup, timeoutMs })
    if (data.code !== 0) {
      throw feishuFailure('Feishu bridge token request was rejected', 'FEISHU_BRIDGE_API_ERROR')
    }
    if (!data.tenant_access_token) {
      throw feishuFailure('Feishu bridge token response is missing an access token', 'FEISHU_BRIDGE_RESPONSE_INVALID')
    }
    tokenCache = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, Number(data.expire || data.expires_in || 7200)) * 1000,
    }
    return tokenCache.token
  }

  async function feishuPost(path, body) {
    const token = await tenantToken()
    const data = await fetchFeishuOutbound(`${FEISHU_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }, { fetchImpl, lookup, timeoutMs })
    if (data.code != null && data.code !== 0) {
      throw feishuFailure('Feishu bridge message request was rejected', 'FEISHU_BRIDGE_API_ERROR')
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

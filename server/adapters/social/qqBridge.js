import { fetchSafeOutbound } from '../../utils/outboundNetworkGuard.js'

const QQ_BASE = 'https://api.sgroup.qq.com'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

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

function qqUnavailable(error) {
  return Object.assign(new Error('QQ bridge service is unavailable'), {
    code: 'QQ_BRIDGE_UNAVAILABLE',
    statusCode: 503,
    cause: error,
  })
}

function qqFailure(message, code, {
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

function qqTimeout(error) {
  return qqFailure('QQ bridge request timed out', 'QQ_BRIDGE_TIMEOUT', {
    statusCode: 504,
    cause: error,
    retryable: true,
  })
}

async function qqJsonResponse(response) {
  if (!response.ok) {
    try { await response?.body?.cancel?.() } catch { /* best effort */ }
    throw qqFailure('QQ bridge upstream returned a non-success status', 'QQ_BRIDGE_HTTP_ERROR', {
      upstreamStatus: response.status,
      retryable: response.status === 429 || response.status >= 500,
    })
  }
  let data = null
  let parseError = null
  try { data = await response.json() } catch (error) { parseError = error }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw qqFailure('QQ bridge upstream returned invalid JSON', 'QQ_BRIDGE_RESPONSE_INVALID', {
      cause: parseError,
    })
  }
  return data
}

async function fetchQQOutbound(url, init, {
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
      timeoutError = new Error('QQ bridge request exceeded its deadline')
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
      }).then(qqJsonResponse),
      timeout,
    ])
  } catch (error) {
    if (timedOut) throw qqTimeout(timeoutError || error)
    if (String(error?.code || '').startsWith('QQ_BRIDGE_')) throw error
    throw qqUnavailable(error)
  } finally {
    clearTimeout(timer)
    upstream?.removeEventListener?.('abort', abortFromUpstream)
  }
}

export function createQQBridgeAdapter({
  integration,
  fetchImpl = fetch,
  lookup,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const creds = credentials(integration)
  let tokenCache = creds.token ? { token: creds.token, expiresAt: Number.MAX_SAFE_INTEGER } : null
  if (!creds.token && (!creds.appId || !creds.appSecret)) throw new Error('QQ appId/appSecret or bot token is required')

  async function accessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token
    const data = await fetchQQOutbound(`${QQ_BASE}/app/getAppAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: creds.appId,
        clientSecret: creds.appSecret,
      }),
    }, { fetchImpl, lookup, timeoutMs })
    const token = data?.access_token || data?.accessToken
    if (!token) {
      throw qqFailure('QQ bridge token response is missing an access token', 'QQ_BRIDGE_RESPONSE_INVALID')
    }
    tokenCache = {
      token,
      expiresAt: Date.now() + Math.max(60, Number(data.expires_in || data.expiresIn || 7200)) * 1000,
    }
    return token
  }

  async function qqPost(path, body) {
    const token = await accessToken()
    return fetchQQOutbound(`${QQ_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(body),
    }, { fetchImpl, lookup, timeoutMs })
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

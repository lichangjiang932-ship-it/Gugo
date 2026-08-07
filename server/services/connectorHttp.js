import { Agent } from 'undici'
import { assertSafeOutboundUrl, pinnedLookup } from '../utils/outboundNetworkGuard.js'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export class ConnectorHttpError extends Error {
  constructor(message, { code, statusCode = 502, retryable = false } = {}) {
    super(message)
    this.name = 'ConnectorHttpError'
    this.code = code
    this.statusCode = statusCode
    this.retryable = retryable
  }
}

export async function readBoundedResponseText(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const declared = Number(response?.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ConnectorHttpError(`Connector response exceeds the ${maxBytes} byte limit.`, { code: 'connector_response_too_large' })
  }
  if (!response?.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ConnectorHttpError(`Connector response exceeds the ${maxBytes} byte limit.`, { code: 'connector_response_too_large' })
    }
    return text
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ConnectorHttpError(`Connector response exceeds the ${maxBytes} byte limit.`, { code: 'connector_response_too_large' })
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export async function fetchConnectorJson(url, init = {}, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const controller = new AbortController()
  const upstream = init.signal
  let timedOut = false
  const abortFromUpstream = () => controller.abort(upstream?.reason)
  if (upstream?.aborted) abortFromUpstream()
  else upstream?.addEventListener?.('abort', abortFromUpstream, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
  let dispatcher = null
  try {
    if (fetchImpl === globalThis.fetch) {
      const target = await assertSafeOutboundUrl(String(url))
      dispatcher = new Agent({ connect: { lookup: pinnedLookup(target.lockedIp) } })
    }
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
      ...(dispatcher ? { dispatcher } : {}),
    })
    const text = await readBoundedResponseText(response, maxResponseBytes)
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    return { response, data, text }
  } catch (error) {
    if (timedOut) {
      throw new ConnectorHttpError('Connector request timed out.', { code: 'connector_request_timeout', statusCode: 504, retryable: true })
    }
    if (upstream?.aborted) {
      throw new ConnectorHttpError('Connector request was cancelled.', { code: 'connector_request_aborted', statusCode: 499, retryable: false })
    }
    throw error
  } finally {
    clearTimeout(timer)
    await dispatcher?.close().catch(() => {})
    upstream?.removeEventListener?.('abort', abortFromUpstream)
  }
}

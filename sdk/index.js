export const GUGO_SDK_CONTRACT_VERSION = 1

export const GUGO_TURN_TERMINAL_EVENTS = Object.freeze([
  'turn.completed',
  'turn.blocked',
  'turn.paused',
  'turn.cancelled',
  'turn.failed',
  'turn.interrupted',
])

const TERMINAL_EVENTS = new Set(GUGO_TURN_TERMINAL_EVENTS)
const START_FIELDS = Object.freeze([
  'sessionId', 'turnId', 'content', 'displayContent', 'workspacePath', 'locale',
  'modelName', 'modelProviderId', 'modelConfigRevision', 'modelMode', 'history',
  'agentId', 'skillIds', 'skillDefinitions', 'toolsConfig', 'intentMode', 'attachments',
])
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class GugoSdkError extends Error {
  constructor(code, message, { status = null, details = null } = {}) {
    super(message)
    this.name = 'GugoSdkError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function sdkError(code, message, options) {
  return new GugoSdkError(code, message, options)
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw sdkError('GUGO_SDK_INPUT_INVALID', `${label} must be an object`)
  }
  return value
}

function requiredId(value, label) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || id.length > 512) {
    throw sdkError('GUGO_SDK_INPUT_INVALID', `${label} must be a non-empty string of at most 512 characters`)
  }
  return id
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw sdkError('GUGO_SDK_INPUT_INVALID', `${label} must be an integer between ${min} and ${max}`)
  }
  return value
}

function projectStartInput(value) {
  const input = record(value, 'startTurn input')
  const projected = Object.fromEntries(START_FIELDS
    .filter((field) => Object.hasOwn(input, field) && input[field] !== undefined)
    .map((field) => [field, input[field]]))
  projected.sessionId = requiredId(input.sessionId, 'sessionId')
  if (typeof input.content !== 'string' || !input.content.trim()) {
    throw sdkError('GUGO_SDK_INPUT_INVALID', 'content must be a non-empty string')
  }
  projected.content = input.content
  return projected
}

function endpoint(baseUrl, pathname, search = null) {
  const url = new URL(pathname.replace(/^\//u, ''), baseUrl)
  if (search) {
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
  }
  return url
}

function advanceEventCursor(event, cursor) {
  const expected = cursor + 1
  const sequence = event?.sequence
  const compactedThrough = event?.compactedThrough
  const valid = Number.isSafeInteger(sequence) && (
    sequence === expected
    || (sequence > expected && Number.isSafeInteger(compactedThrough) && sequence <= compactedThrough)
  )
  if (!valid) {
    throw sdkError('GUGO_SDK_EVENT_SEQUENCE_INVALID', `expected event sequence ${expected}`)
  }
  return sequence
}

function parseSseFrame(value) {
  let type = 'message'
  const data = []
  for (const line of String(value || '').split(/\r?\n/u)) {
    if (line.startsWith('event:')) type = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  return data.length ? { type, data: data.join('\n') } : null
}

function turnEventPayload(value) {
  const parsed = JSON.parse(value)
  if (parsed?.v === GUGO_SDK_CONTRACT_VERSION
    && parsed?.type === 'turn.event'
    && parsed.event
    && typeof parsed.event === 'object'
    && !Array.isArray(parsed.event)) {
    return parsed.event
  }
  throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'Turn stream returned an invalid event envelope')
}

function errorPayload(body, status) {
  const nested = body?.error && typeof body.error === 'object' ? body.error : null
  const code = String(nested?.code || body?.code || `HTTP_${status}`).trim() || `HTTP_${status}`
  const message = String(nested?.message || (typeof body?.error === 'string' ? body.error : code))
  return sdkError(code, message, { status, details: nested || body || null })
}

function responseLimitError(response) {
  return sdkError('GUGO_SDK_RESPONSE_INVALID', 'Gugo response exceeded 8 MiB', {
    status: Number.isInteger(response?.status) ? response.status : null,
  })
}

async function readBoundedJson(response) {
  const declaredLength = Number(response?.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw responseLimitError(response)
  }
  const reader = response?.body?.getReader?.()
  let text = null
  if (reader) {
    const chunks = []
    let total = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const value = chunk.value || new Uint8Array()
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw responseLimitError(response)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
  } else if (typeof response?.text === 'function') {
    text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw responseLimitError(response)
    }
  } else if (typeof response?.json === 'function') {
    try { return await response.json() } catch { return null }
  }
  try { return JSON.parse(text) } catch { return null }
}

async function responseJson(response) {
  const body = await readBoundedJson(response)
  if (!response.ok || body?.ok === false) throw errorPayload(body, response.status)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'Gugo returned a non-object response', {
      status: response.status,
    })
  }
  return body
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || sdkError('GUGO_SDK_ABORTED', 'Operation aborted'))
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason || sdkError('GUGO_SDK_ABORTED', 'Operation aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function boundedRequestTimeoutMs(value) {
  return safeInteger(value, 'requestTimeoutMs', { min: 100, max: 10 * 60 * 1_000 })
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : sdkError('GUGO_SDK_ABORTED', 'Operation aborted')
}

async function withOperationTimeout(signal, timeoutMs, timeoutError, operation) {
  if (signal?.aborted) throw abortReason(signal)
  const controller = new AbortController()
  const aborted = new Promise((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(abortReason(controller.signal)), { once: true })
  })
  const onExternalAbort = () => controller.abort(abortReason(signal))
  signal?.addEventListener?.('abort', onExternalAbort, { once: true })
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      aborted,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onExternalAbort)
  }
}

function requestTimeoutError(timeoutMs) {
  return sdkError(
    'GUGO_SDK_REQUEST_TIMEOUT',
    `Gugo request did not complete within ${timeoutMs} ms`,
  )
}

async function consumeTurnEventStream(response, { cursor, onEvent, onActivity }) {
  const reader = response.body?.getReader?.()
  if (!reader) throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'Turn stream has no readable body')
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  while (true) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
    if (encoder.encode(buffer).byteLength > MAX_RESPONSE_BYTES) {
      throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'Turn stream frame buffer exceeded 8 MiB')
    }
    const frames = buffer.split(/\r?\n\r?\n/u)
    buffer = frames.pop() || ''
    if (chunk.done && buffer.trim()) { frames.push(buffer); buffer = '' }
    for (const rawFrame of frames) {
      const frame = parseSseFrame(rawFrame)
      if (!frame || frame.type === 'ready') continue
      if (frame.type === 'error') {
        let body = null
        try { body = JSON.parse(frame.data) } catch { /* stable fallback below */ }
        throw errorPayload(body, response.status || 500)
      }
      if (frame.type === 'turn_activity') {
        let activity = null
        try { activity = JSON.parse(frame.data) } catch { /* validated below */ }
        if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
          throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'Turn activity must be an object')
        }
        await onActivity?.(activity)
        continue
      }
      if (frame.type !== 'turn_event') continue
      let event
      try { event = turnEventPayload(frame.data) } catch (error) {
        if (error instanceof GugoSdkError) throw error
        throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'Turn stream returned invalid JSON')
      }
      cursor = advanceEventCursor(event, cursor)
      await onEvent?.(event)
      if (TERMINAL_EVENTS.has(event.type)) return event
    }
    if (chunk.done) break
  }
  throw sdkError('GUGO_SDK_STREAM_TRUNCATED', 'Turn stream ended before a terminal event')
}

export function createGugoClient({
  baseUrl,
  token = '',
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  let normalizedBase
  try { normalizedBase = new URL(String(baseUrl || '')) } catch {
    throw sdkError('GUGO_SDK_INPUT_INVALID', 'baseUrl must be an absolute http/https URL')
  }
  if (!['http:', 'https:'].includes(normalizedBase.protocol)
    || normalizedBase.username
    || normalizedBase.password) {
    throw sdkError('GUGO_SDK_INPUT_INVALID', 'baseUrl must be an absolute http/https URL without credentials')
  }
  if (typeof fetchImpl !== 'function') throw sdkError('GUGO_SDK_INPUT_INVALID', 'fetchImpl must be a function')
  normalizedBase.pathname = normalizedBase.pathname.replace(/\/?$/u, '/')
  const authToken = String(token || '').trim()
  const configuredRequestTimeoutMs = boundedRequestTimeoutMs(requestTimeoutMs)

  const requestHeaders = (body = false, accept = 'application/json') => ({
    Accept: accept,
    'X-Gugo-SDK-Contract': String(GUGO_SDK_CONTRACT_VERSION),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  })
  const request = async (pathname, {
    method = 'GET', body, search, signal,
  } = {}) => withOperationTimeout(
    signal,
    configuredRequestTimeoutMs,
    requestTimeoutError(configuredRequestTimeoutMs),
    async (requestSignal) => {
      const response = await fetchImpl(endpoint(normalizedBase, pathname, search), {
        method,
        headers: requestHeaders(body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      })
      return responseJson(response)
    },
  )

  const listTurnEvents = async ({ sessionId, turnId, after = -1, limit = 500, signal } = {}) => {
    const body = await request('/api/turns/events', {
      search: {
        sessionId: requiredId(sessionId, 'sessionId'),
        turnId: requiredId(turnId, 'turnId'),
        after: safeInteger(after, 'after', { min: -1 }),
        limit: safeInteger(limit, 'limit', { min: 1, max: 2_000 }),
      },
      signal,
    })
    if (!Array.isArray(body.events)) throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'events must be an array')
    return body.events
  }

  const client = {
    contractVersion: GUGO_SDK_CONTRACT_VERSION,
    async startTurn(input, { signal } = {}) {
      const body = await request('/api/turns/run', {
        method: 'POST', body: projectStartInput(input), signal,
      })
      if (!body.turn?.id && !body.turn?.turnId) {
        throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'startTurn response is missing a Turn identity')
      }
      return body.turn
    },
    async getTurn({ sessionId, turnId, signal } = {}) {
      const body = await request(`/api/turns/${encodeURIComponent(requiredId(turnId, 'turnId'))}`, {
        search: { sessionId: requiredId(sessionId, 'sessionId') }, signal,
      })
      if (!body.turn || typeof body.turn !== 'object') throw sdkError('GUGO_SDK_RESPONSE_INVALID', 'turn is missing')
      return body.turn
    },
    listTurnEvents,
    async streamTurnEvents({ sessionId, turnId, after = -1, signal, onEvent, onActivity } = {}) {
      const cursor = safeInteger(after, 'after', { min: -1 })
      return withOperationTimeout(
        signal,
        configuredRequestTimeoutMs,
        requestTimeoutError(configuredRequestTimeoutMs),
        async (requestSignal) => {
          const response = await fetchImpl(endpoint(normalizedBase, '/api/turns/stream', {
            sessionId: requiredId(sessionId, 'sessionId'),
            turnId: requiredId(turnId, 'turnId'),
            after: cursor,
            turnEventVersion: GUGO_SDK_CONTRACT_VERSION,
          }), { headers: requestHeaders(false, 'text/event-stream'), signal: requestSignal })
          if (!response.ok) await responseJson(response)
          return consumeTurnEventStream(response, { cursor, onEvent, onActivity })
        },
      )
    },
    async cancelTurn({ sessionId, turnId, signal } = {}) {
      const body = await request(`/api/turns/${encodeURIComponent(requiredId(turnId, 'turnId'))}/cancel`, {
        method: 'POST', body: { sessionId: requiredId(sessionId, 'sessionId') }, signal,
      })
      return body.turn
    },
    async resumeTurn({ sessionId, turnId, resolution = null, retryFailed = false, retryRecovery = false, signal } = {}) {
      const body = await request(`/api/turns/${encodeURIComponent(requiredId(turnId, 'turnId'))}/resume`, {
        method: 'POST',
        body: {
          sessionId: requiredId(sessionId, 'sessionId'), resolution,
          retryFailed: retryFailed === true, retryRecovery: retryRecovery === true,
        },
        signal,
      })
      return body.turn
    },
    async steerTurn({ sessionId, turnId, content, clientRequestId, signal } = {}) {
      if (typeof content !== 'string' || !content.trim()) throw sdkError('GUGO_SDK_INPUT_INVALID', 'content must be non-empty')
      const body = await request(`/api/turns/${encodeURIComponent(requiredId(turnId, 'turnId'))}/steer`, {
        method: 'POST',
        body: {
          sessionId: requiredId(sessionId, 'sessionId'), content,
          clientRequestId: requiredId(clientRequestId, 'clientRequestId'),
        },
        signal,
      })
      return body.steering
    },
    async waitForTerminal({
      sessionId, turnId, after = -1, pollIntervalMs = 500, timeoutMs = 20 * 60 * 1_000,
      signal, onEvent,
    } = {}) {
      const interval = safeInteger(pollIntervalMs, 'pollIntervalMs', { min: 10, max: 60_000 })
      const timeout = safeInteger(timeoutMs, 'timeoutMs', { min: 1_000, max: 6 * 60 * 60 * 1_000 })
      let cursor = safeInteger(after, 'after', { min: -1 })
      const timeoutError = sdkError(
        'GUGO_SDK_TIMEOUT',
        `Turn did not reach a terminal event within ${timeout} ms`,
      )
      return withOperationTimeout(signal, timeout, timeoutError, async (waitSignal) => {
        while (true) {
          const events = await listTurnEvents({
            sessionId, turnId, after: cursor, limit: 2_000, signal: waitSignal,
          })
          for (const event of events) {
            cursor = advanceEventCursor(event, cursor)
            await onEvent?.(event)
            if (TERMINAL_EVENTS.has(event.type)) return event
          }
          await delay(interval, waitSignal)
        }
      })
    },
  }
  return Object.freeze(client)
}

import { parseTurnEvent } from '../../../shared/turnEvents.js'
import { getAuthToken } from '../accountClient.js'

export const TERMINAL_EVENTS = new Set(['turn.completed', 'turn.cancelled', 'turn.failed'])
export const DEFAULT_RECONNECT_MAX_ATTEMPTS = 8
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000
export const DEFAULT_SNAPSHOT_PAGE_SIZE = 500
export const DEFAULT_SNAPSHOT_REVISION_ATTEMPTS = 3

export function headers(json = false) {
  const token = getAuthToken()
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export async function parseResponse(response) {
  let body
  try { body = await response.json() } catch { body = null }
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Turn request failed: HTTP ${response.status}`)
    error.code = body?.error?.code || 'TURN_REQUEST_FAILED'
    error.status = response.status
    throw error
  }
  return body || {}
}

export function abortError() {
  const error = new Error('Generation stopped')
  error.name = 'AbortError'
  error.code = 'USER_STOPPED'
  return error
}

export function waitForReconnect(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const finish = () => {
      cleanup()
      resolve()
    }
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(finish, ms)
  })
}

export function reconnectDelayForAttempt(attempt, baseMs = 500, maxMs = DEFAULT_RECONNECT_MAX_DELAY_MS) {
  const safeAttempt = Math.max(1, Number(attempt) || 1)
  const safeBase = Math.max(0, Number(baseMs) || 0)
  const safeMax = Math.max(safeBase, Number(maxMs) || DEFAULT_RECONNECT_MAX_DELAY_MS)
  return Math.min(safeMax, safeBase * (2 ** (safeAttempt - 1)))
}

export function reconnectExhaustedError(attempts, cause) {
  const error = new Error(`Turn connection could not be restored after ${attempts} attempts`)
  error.code = 'TURN_RECONNECT_EXHAUSTED'
  error.cause = cause
  return error
}

export function streamTruncatedError() {
  const error = new Error('Turn event stream ended before a terminal event')
  error.code = 'TURN_STREAM_TRUNCATED'
  return error
}

function normalizeToolNames(names) {
  if (!Array.isArray(names)) return []
  return [...new Set(names
    .filter((name) => typeof name === 'string')
    .map((name) => name.trim())
    .filter(Boolean))]
    .sort()
}

export function normalizeToolsConfig(toolsConfig) {
  const disabled = normalizeToolNames(toolsConfig?.disabled)
  const disabledSet = new Set(disabled)
  const enabled = normalizeToolNames(toolsConfig?.enabled)
    .filter((name) => !disabledSet.has(name))
  return { enabled, disabled }
}

export function normalizeContextIds(values, limit = 32) {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))]
    .slice(0, limit)
}

function parseSseFrame(frame) {
  let eventType = 'message'
  const data = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  return { eventType, data: data.join('\n') }
}

export async function streamServerTurnEvents({ sessionId, turnId, after = -1, signal, onEvent, fetchImpl = fetch }) {
  const query = new URLSearchParams({ sessionId, turnId, after: String(after) })
  const response = await fetchImpl(`/api/turns/stream?${query}`, { headers: headers(), signal })
  if (!response.ok) await parseResponse(response)
  const reader = response.body?.getReader?.()
  if (!reader) throw streamTruncatedError()
  const decoder = new TextDecoder()
  let buffer = ''
  let terminal = null
  while (!terminal) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const rawFrame of frames) {
      const frame = parseSseFrame(rawFrame)
      if (frame?.eventType !== 'turn_event') continue
      const event = parseTurnEvent(JSON.parse(frame.data))
      await onEvent?.(event)
      if (TERMINAL_EVENTS.has(event.type)) terminal = event
    }
    if (chunk.done) break
  }
  if (!terminal) throw streamTruncatedError()
  return terminal
}

export function defaultWebSocketFactory(url, protocols) {
  if (typeof window === 'undefined' || typeof window.WebSocket !== 'function') return null
  return new window.WebSocket(url, protocols)
}

export function streamServerTurnEventsWebSocket({
  sessionId,
  turnId,
  after = -1,
  signal,
  onEvent,
  webSocketFactory = defaultWebSocketFactory,
}) {
  const token = getAuthToken()
  if (!token || typeof webSocketFactory !== 'function') return Promise.reject(new Error('WebSocket unavailable'))
  const locationValue = globalThis.location
  const protocol = locationValue?.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = locationValue?.host || '127.0.0.1'
  const socket = webSocketFactory(`${protocol}//${host}/api/realtime`, ['gugo.realtime', `bearer.${token}`])
  if (!socket) return Promise.reject(new Error('WebSocket unavailable'))
  return new Promise((resolve, reject) => {
    let settled = false
    let chain = Promise.resolve()
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const finish = (error, terminal) => {
      if (settled) return
      settled = true
      cleanup()
      try { socket.close() } catch { /* already closed */ }
      if (error) reject(error)
      else resolve(terminal)
    }
    const onAbort = () => finish(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe.turn', sessionId, turnId, after }))
    })
    socket.addEventListener('message', (message) => {
      chain = chain.then(async () => {
        const frame = JSON.parse(String(message.data || '{}'))
        if (frame.type !== 'turn.event') return
        const event = parseTurnEvent(frame.event)
        await onEvent?.(event)
        if (TERMINAL_EVENTS.has(event.type)) finish(null, event)
      }).catch(finish)
    })
    socket.addEventListener('error', () => finish(new Error('WebSocket connection failed')))
    socket.addEventListener('close', () => {
      if (!settled) finish(streamTruncatedError())
    })
  })
}

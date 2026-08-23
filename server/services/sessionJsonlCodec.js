import crypto from 'node:crypto'
import path from 'node:path'

export const SESSION_JSONL_SCHEMA_VERSION = 1
export const SESSION_CONTENT_EVENT_TYPES = Object.freeze([
  'message.upsert',
  'message.delete',
  'session.replace',
  'session.delete',
])

const EVENT_TYPE_SET = new Set(SESSION_CONTENT_EVENT_TYPES)
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool'])
const MAX_IDENTIFIER_LENGTH = 512
const MAX_REPLACEMENT_MESSAGES = 50_000

function codecError(code, message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    name: 'SessionJsonlCodecError',
    code,
    retryable: false,
  })
}

function requiredIdentifier(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label} must contain 1-${MAX_IDENTIFIER_LENGTH} characters`)
  }
  return normalized
}

function finiteTimestamp(value, label, { nonNegative = false } = {}) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || !Number.isSafeInteger(normalized)
    || (nonNegative && normalized < 0)) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label} must be a safe integer timestamp`)
  }
  return normalized
}

function finiteStoredTimestamp(value, label) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label} must be a finite timestamp`)
  }
  return normalized
}

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label} must be an object`)
  }
  return value
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label} contains unsupported field ${unknown[0]}`)
  }
}

function canonicalJsonValue(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw codecError('SESSION_JSONL_EVENT_INVALID', `${label} contains a non-finite number`)
    }
    return value
  }
  if (typeof value !== 'object') {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label} is not JSON-serializable`)
  }
  if (ancestors.has(value)) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label} contains a circular reference`)
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalJsonValue(item, `${label}[${index}]`, ancestors))
    }
    const normalized = {}
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      if (item === undefined) continue
      normalized[key] = canonicalJsonValue(item, `${label}.${key}`, ancestors)
    }
    return normalized
  } finally {
    ancestors.delete(value)
  }
}

function normalizeMessage(value, label = 'payload.message') {
  const source = plainRecord(value, label)
  assertOnlyKeys(
    source,
    new Set(['id', 'role', 'content', 'modelContext', 'createdAt', 'updatedAt']),
    label,
  )
  const role = String(source.role || '').trim()
  if (!MESSAGE_ROLES.has(role)) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label}.role is invalid`)
  }
  if (typeof source.content !== 'string') {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `${label}.content must be a string`)
  }
  return {
    id: requiredIdentifier(source.id, `${label}.id`),
    role,
    content: source.content,
    modelContext: source.modelContext == null
      ? null
      : canonicalJsonValue(source.modelContext, `${label}.modelContext`),
    createdAt: finiteStoredTimestamp(source.createdAt, `${label}.createdAt`),
    updatedAt: finiteStoredTimestamp(source.updatedAt, `${label}.updatedAt`),
  }
}

function normalizePayload(eventType, value) {
  const source = value == null ? {} : plainRecord(value, 'payload')
  if (eventType === 'message.upsert') {
    assertOnlyKeys(source, new Set(['message']), 'payload')
    return { message: normalizeMessage(source.message) }
  }
  if (eventType === 'message.delete') {
    assertOnlyKeys(source, new Set(['messageId']), 'payload')
    return { messageId: requiredIdentifier(source.messageId, 'payload.messageId') }
  }
  if (eventType === 'session.replace') {
    assertOnlyKeys(source, new Set(['messages']), 'payload')
    if (!Array.isArray(source.messages)) {
      throw codecError('SESSION_JSONL_EVENT_INVALID', 'payload.messages must be an array')
    }
    if (source.messages.length > MAX_REPLACEMENT_MESSAGES) {
      throw codecError(
        'SESSION_JSONL_EVENT_INVALID',
        `payload.messages exceeds the ${MAX_REPLACEMENT_MESSAGES} item limit`,
      )
    }
    const ids = new Set()
    const messages = source.messages.map((message, index) => {
      const normalized = normalizeMessage(message, `payload.messages[${index}]`)
      if (ids.has(normalized.id)) {
        throw codecError('SESSION_JSONL_EVENT_INVALID', `payload.messages contains duplicate id ${normalized.id}`)
      }
      ids.add(normalized.id)
      return normalized
    })
    return { messages }
  }
  assertOnlyKeys(source, new Set(), 'payload')
  return {}
}

function parsePayload(input) {
  const raw = input?.payload ?? input?.payload_json ?? input?.payloadJson ?? {}
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', 'payload is not valid JSON', cause)
  }
}

export function normalizeSessionContentEvent(input = {}) {
  const source = plainRecord(input, 'event')
  const id = Number(source.id ?? source.sequence)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', 'event id must be a positive safe integer')
  }
  const eventType = String(source.eventType ?? source.event_type ?? '').trim()
  if (!EVENT_TYPE_SET.has(eventType)) {
    throw codecError('SESSION_JSONL_EVENT_INVALID', `unsupported event type ${eventType || '<empty>'}`)
  }
  const normalized = {
    id,
    eventId: requiredIdentifier(source.eventId ?? source.event_id, 'eventId'),
    userId: requiredIdentifier(source.userId ?? source.user_id, 'userId'),
    sessionId: requiredIdentifier(source.sessionId ?? source.session_id, 'sessionId'),
    eventType,
    payload: normalizePayload(eventType, parsePayload(source)),
    createdAt: finiteTimestamp(
      source.createdAt ?? source.created_at,
      'createdAt',
      { nonNegative: true },
    ),
  }
  return Object.freeze(normalized)
}

function recordForEvent(input) {
  const event = normalizeSessionContentEvent(input)
  return {
    schemaVersion: SESSION_JSONL_SCHEMA_VERSION,
    sequence: event.id,
    eventId: event.eventId,
    userId: event.userId,
    sessionId: event.sessionId,
    eventType: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt,
  }
}

export function encodeSessionContentRecord(input) {
  return `${JSON.stringify(canonicalJsonValue(recordForEvent(input), 'record'))}\n`
}

export function decodeSessionContentRecord(line) {
  const source = String(line ?? '').trim()
  if (!source) throw codecError('SESSION_JSONL_RECORD_INVALID', 'JSONL record is empty')
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (cause) {
    throw codecError('SESSION_JSONL_RECORD_INVALID', 'JSONL record is not valid JSON', cause)
  }
  if (parsed?.schemaVersion !== SESSION_JSONL_SCHEMA_VERSION) {
    throw codecError('SESSION_JSONL_RECORD_UNSUPPORTED', 'JSONL record schema version is unsupported')
  }
  assertOnlyKeys(
    parsed,
    new Set(['schemaVersion', 'sequence', 'eventId', 'userId', 'sessionId', 'eventType', 'payload', 'createdAt']),
    'record',
  )
  return normalizeSessionContentEvent(parsed)
}

export function projectSessionContentEvents(inputs = []) {
  if (!Array.isArray(inputs)) throw new TypeError('events must be an array')
  const seen = new Set()
  let deleted = false
  let messages = []
  for (const input of inputs) {
    const event = normalizeSessionContentEvent(input)
    if (seen.has(event.eventId)) continue
    seen.add(event.eventId)
    if (event.eventType === 'session.delete') {
      deleted = true
      messages = []
      continue
    }
    deleted = false
    if (event.eventType === 'session.replace') {
      messages = event.payload.messages.map((message) => ({ ...message }))
      continue
    }
    if (event.eventType === 'message.delete') {
      messages = messages.filter((message) => message.id !== event.payload.messageId)
      continue
    }
    const index = messages.findIndex((message) => message.id === event.payload.message.id)
    if (index >= 0) messages[index] = { ...event.payload.message }
    else messages.push({ ...event.payload.message })
  }
  return Object.freeze({
    deleted,
    messages: Object.freeze(messages.map((message) => Object.freeze(message))),
    appliedEventIds: Object.freeze([...seen]),
  })
}

export function sessionContentStorageToken(value, length = 64) {
  const safeLength = Math.max(16, Math.min(64, Math.floor(Number(length) || 64)))
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, safeLength)
}

export function resolveSessionContentPath({
  userId,
  sessionId,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const safeUserId = requiredIdentifier(userId, 'userId')
  const safeSessionId = requiredIdentifier(sessionId, 'sessionId')
  const dataRoot = env?.APP_DATA_DIR
    ? path.resolve(cwd, String(env.APP_DATA_DIR))
    : path.resolve(cwd, 'server-data')
  const root = path.join(dataRoot, 'session-content', `v${SESSION_JSONL_SCHEMA_VERSION}`)
  const userDirectory = path.join(root, sessionContentStorageToken(safeUserId, 32))
  const filePath = path.join(userDirectory, `${sessionContentStorageToken(safeSessionId)}.jsonl`)
  return Object.freeze({ dataRoot, root, userDirectory, filePath })
}

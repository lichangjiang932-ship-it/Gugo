import path from 'node:path'

const TERMINAL_TYPES = new Set(['turn.completed', 'turn.cancelled', 'turn.failed'])
const STREAM_DELTA_TYPES = new Set(['assistant.delta', 'reasoning.delta'])

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeResolutionPath(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const normalized = path.resolve(raw).replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function replayPersistedTurnEvents(replayEvents, scope) {
  if (typeof replayEvents !== 'function') return []
  const events = []
  let after = -1
  while (true) {
    const page = await replayEvents({ ...scope, after, limit: 2000 })
    if (!Array.isArray(page) || page.length === 0) break
    const fresh = page
      .filter((event) => Number.isInteger(event?.sequence) && event.sequence > after)
      .sort((left, right) => left.sequence - right.sequence)
    if (fresh.length === 0) break
    events.push(...fresh)
    const nextAfter = fresh.at(-1).sequence
    if (nextAfter <= after) break
    after = nextAfter
    if (page.length < 2000) break
  }
  return events
}

function confirmedStreamPrefix(events, checkpointSequence) {
  let assistantText = ''
  let reasoningText = ''
  for (const event of events) {
    if (event.sequence > checkpointSequence) break
    if (event.type === 'turn.attempt' && event.payload?.resetStreaming) {
      assistantText = String(event.payload.assistantText || '')
      reasoningText = String(event.payload.reasoningText || '')
    } else if (event.type === 'assistant.delta') {
      assistantText += String(event.payload?.text || '')
    } else if (event.type === 'reasoning.delta') {
      reasoningText += String(event.payload?.text || '')
    }
  }
  return { assistantText, reasoningText }
}

export function failedRetryAttemptPayload(events, failureEvent, checkpoint) {
  const ordered = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isInteger(event?.sequence))
    .sort((left, right) => left.sequence - right.sequence)
  const failureSequence = Number(failureEvent?.sequence)
  if (failureEvent?.type !== 'turn.failed' || !Number.isInteger(failureSequence)) return null
  const previousAttempt = ordered
    .filter((event) => event.type === 'turn.attempt' && event.sequence < failureSequence)
    .at(-1)
  const previousAttemptNumber = Number(previousAttempt?.payload?.attempt)
  const previousStream = ordered
    .filter((event) => STREAM_DELTA_TYPES.has(event.type) && event.sequence < failureSequence)
    .at(-1)
  const streamed = confirmedStreamPrefix(ordered, failureSequence)
  const partialText = String(failureEvent.payload?.partialText || '')
  return {
    attempt: Number.isInteger(previousAttemptNumber) && previousAttemptNumber > 0
      ? previousAttemptNumber + 1
      : 2,
    reason: 'failed_retry',
    ...(failureEvent.payload?.error?.manualRetryable === true ? { manualRetry: true } : {}),
    resetStreaming: true,
    checkpointSequence: Number.isInteger(checkpoint?.eventSequence)
      ? checkpoint.eventSequence
      : null,
    previousStreamSequence: previousStream?.sequence ?? failureSequence,
    assistantText: partialText || streamed.assistantText,
    reasoningText: streamed.reasoningText,
  }
}

export async function recoveryAttemptAfterCheckpoint(replayEvents, scope, checkpoint) {
  const events = await replayPersistedTurnEvents(replayEvents, scope)
  const checkpointSequence = Number.isInteger(checkpoint?.sequence) ? checkpoint.sequence : -1
  const terminalAfterCheckpoint = events.some((event) => (
    TERMINAL_TYPES.has(event.type) && event.sequence > checkpointSequence
  ))
  if (terminalAfterCheckpoint) return null

  const previousStream = events
    .filter((event) => STREAM_DELTA_TYPES.has(event.type) && event.sequence > checkpointSequence)
    .at(-1)
  if (!previousStream) return null

  const previousAttempt = events.filter((event) => event.type === 'turn.attempt').at(-1)
  const previousAttemptNumber = Number(previousAttempt?.payload?.attempt)
  const prefix = confirmedStreamPrefix(events, checkpointSequence)
  return {
    attempt: Number.isInteger(previousAttemptNumber) && previousAttemptNumber > 0
      ? previousAttemptNumber + 1
      : 2,
    reason: checkpoint ? 'checkpoint_resume' : 'turn_resume',
    resetStreaming: true,
    checkpointSequence: checkpoint?.sequence ?? null,
    previousStreamSequence: previousStream.sequence,
    ...prefix,
  }
}

export async function latestVerifiedLocalFiles(replayEvents, scope) {
  return (await replayPersistedTurnEvents(replayEvents, scope))
    .map((event) => event?.payload?.verifiedLocalFiles)
    .filter(Array.isArray)
    .at(-1) || []
}

export async function latestRetainedLocalFiles(replayEvents, scope) {
  return (await replayPersistedTurnEvents(replayEvents, scope))
    .map((event) => event?.payload?.retainedLocalFiles)
    .filter(Array.isArray)
    .at(-1) || []
}

function normalizeMessageContent(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

export function checkpointMessagesForTurn(state, {
  content = '',
  fallback = [],
} = {}) {
  if (Array.isArray(state?.turnMessages)) return state.turnMessages
  const messages = Array.isArray(state?.messages) ? state.messages : []
  if (messages.length === 0) return Array.isArray(fallback) ? fallback : []

  const objective = String(content || '')
  // Exact match first — cheapest and unambiguous when the snapshot preserved
  // the original user text verbatim.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || String(message.content || '') !== objective) continue
    return messages.slice(index + 1)
  }
  // Normalized rematch: display transforms or whitespace drift between the
  // turn-start event and the checkpointed model context used to send recovery
  // to the empty fallback and silently drop the assistant partials.
  const normalizedObjective = normalizeMessageContent(objective)
  if (normalizedObjective) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'user') continue
      if (normalizeMessageContent(message.content) !== normalizedObjective) continue
      return messages.slice(index + 1)
    }
  }

  if (!messages.some((message) => message?.role === 'user')) return messages
  return Array.isArray(fallback) ? fallback : []
}

export function mergeLocalFileReceipts(...groups) {
  const receipts = []
  const seen = new Set()
  for (const value of groups.flatMap((group) => (Array.isArray(group) ? group : []))) {
    if (!isRecord(value)) continue
    const fullPath = String(value.path || '').trim()
    const id = String(value.id || '').trim()
    const key = fullPath ? `path:${normalizeResolutionPath(fullPath)}` : (id ? `id:${id}` : '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    receipts.push(value)
    if (receipts.length >= 64) break
  }
  return receipts
}

export function excludeVerifiedLocalFiles(retainedLocalFiles, verifiedLocalFiles) {
  const verifiedPaths = new Set((Array.isArray(verifiedLocalFiles) ? verifiedLocalFiles : [])
    .map((file) => normalizeResolutionPath(file?.path))
    .filter(Boolean))
  const verifiedIds = new Set((Array.isArray(verifiedLocalFiles) ? verifiedLocalFiles : [])
    .map((file) => String(file?.id || '').trim())
    .filter(Boolean))
  return (Array.isArray(retainedLocalFiles) ? retainedLocalFiles : []).filter((file) => {
    const fullPath = normalizeResolutionPath(file?.path)
    const id = String(file?.id || '').trim()
    return !(fullPath && verifiedPaths.has(fullPath)) && !(id && verifiedIds.has(id))
  })
}

export function storedCheckpointEvent(checkpoint) {
  if (!checkpoint?.state || !Number.isInteger(checkpoint.eventSequence)) return null
  return {
    sessionId: checkpoint.sessionId,
    turnId: checkpoint.turnId,
    sequence: checkpoint.eventSequence,
    type: 'turn.checkpoint',
    payload: { state: checkpoint.state },
    createdAt: checkpoint.updatedAt,
  }
}

export async function latestLegacyCheckpoint(replayEvents, scope) {
  return (await replayPersistedTurnEvents(replayEvents, scope))
    .filter((event) => event.type === 'turn.checkpoint' && isRecord(event.payload?.state))
    .at(-1) || null
}

const PHASES = new Set(['started', 'waiting_first_token', 'streaming', 'tool_arguments', 'completed', 'failed'])
const time = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
const duration = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** One signal travels with its existing fenced message action, never a second cursor update. */
export function withModelTimingSignal(action, event) {
  if (!time(event.createdAt)) return action
  let phase
  if (event.type === 'model.phase' && PHASES.has(event.payload?.phase)) phase = event.payload.phase
  else if (event.type === 'assistant.delta' && event.payload?.text) phase = 'public'
  else if (event.type === 'reasoning.delta') phase = 'progress'
  if (!phase) return action
  const field = action.type === 'UPDATE_LAST_MESSAGE_META' ? 'payload' : 'meta'
  return { ...action, [field]: { ...action[field], modelTimingSignal: {
    phase, at: event.createdAt, elapsedMs: duration(event.payload?.elapsedMs),
  } } }
}

export function applyModelTimingSignal(previousMeta, nextMeta) {
  if (!Object.hasOwn(nextMeta, 'modelTimingSignal')) return nextMeta
  const { modelTimingSignal: signal, ...clean } = nextMeta
  if (!signal || !time(signal.at)) return clean
  const empty = { version: 1, startedAt: null, firstProgressAt: null, firstPublicAt: null, completedAt: null }
  const old = previousMeta.modelTiming?.version === 1 ? previousMeta.modelTiming : empty
  const result = { ...empty, ...Object.fromEntries(['startedAt', 'firstProgressAt', 'firstPublicAt', 'completedAt']
    .map((key) => [key, time(old[key])])) }
  if (signal.phase === 'started' || (signal.phase === 'waiting_first_token' && result.completedAt !== null)) Object.assign(result, empty)
  const elapsed = duration(signal.elapsedMs)
  const candidate = elapsed !== null ? time(signal.at - elapsed) : null
  if (signal.phase === 'started' || signal.phase === 'waiting_first_token') {
    if (result.firstProgressAt === null) result.startedAt = candidate ?? signal.at
  }
  if (['streaming', 'tool_arguments', 'progress'].includes(signal.phase) && result.firstProgressAt === null) {
    if (candidate !== null) result.startedAt = candidate
    result.firstProgressAt = signal.at
  }
  if (signal.phase === 'public' && result.firstPublicAt === null) result.firstPublicAt = signal.at
  if (signal.phase === 'completed' || signal.phase === 'failed') result.completedAt = signal.at
  return { ...clean, modelTiming: result }
}

/** Host-event observations, not provider tokenization or browser paint timestamps. */
export function requestTimingSummary(timing) {
  if (timing?.version !== 1) return { firstProgressMs: null, firstPublicMs: null, bufferedMs: null }
  const since = (end, start) => time(end) !== null && time(start) !== null && end >= start ? end - start : null
  return {
    firstProgressMs: since(timing?.firstProgressAt, timing?.startedAt),
    firstPublicMs: since(timing?.firstPublicAt, timing?.startedAt),
    bufferedMs: since(timing?.firstPublicAt, timing?.firstProgressAt),
  }
}

import { normalizeModelPhaseProgress } from '../../shared/modelPhaseProgress.js'

export const DEFAULT_MODEL_PHASE_HEARTBEAT_MS = 15_000
const TOOL_PROGRESS_INTERVAL_MS = 1000

function normalizedInterval(value) {
  const interval = Number(value)
  return Number.isFinite(interval) && interval > 0
    ? Math.max(1, Math.floor(interval))
    : 0
}

/**
 * Keeps a durable, user-facing model activity signal alive while a provider is
 * loading or pauses between streamed chunks. It intentionally adds no request
 * timeout: slow local inference remains allowed to run for as long as it keeps
 * making progress.
 */
export function createModelPhaseHeartbeat({
  onPhase,
  iteration = 0,
  intervalMs = DEFAULT_MODEL_PHASE_HEARTBEAT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  const interval = normalizedInterval(intervalMs)
  let timer = null
  let stopped = false
  let sawDelta = false
  let currentPhase = null
  let emissions = Promise.resolve()
  let requestStartedAt = now()
  let lastProgressAt = requestStartedAt
  let lastToolEmissionAt = 0
  let toolProgress = null

  const emit = (phase, timestamp = now()) => {
    if (stopped || typeof onPhase !== 'function') return Promise.resolve()
    const metadata = normalizeModelPhaseProgress({
      ...(toolProgress || {}), elapsedMs: Math.max(0, timestamp - requestStartedAt),
      idleMs: Math.max(0, timestamp - lastProgressAt),
    })
    emissions = emissions.then(() => onPhase({ phase, iteration, ...metadata }))
    // Timer callbacks are deliberately detached. Attach a rejection handler so
    // an emitter failure is observed later by stop() without becoming an
    // unhandled rejection in the meantime.
    emissions.catch(() => {})
    return emissions
  }

  const cancelTimer = () => {
    if (timer == null) return
    clearTimer(timer)
    timer = null
  }

  const schedule = () => {
    cancelTimer()
    if (stopped || interval === 0 || typeof onPhase !== 'function') return
    timer = setTimer(() => {
      timer = null
      if (stopped) return
      currentPhase = sawDelta ? 'idle' : 'waiting_first_token'
      void emit(currentPhase).then(schedule, () => {})
    }, interval)
    timer?.unref?.()
  }

  return {
    async beginRequest() {
      if (stopped) return
      sawDelta = false
      requestStartedAt = now()
      lastProgressAt = requestStartedAt
      lastToolEmissionAt = 0
      toolProgress = null
      currentPhase = 'waiting_first_token'
      cancelTimer()
      await emit(currentPhase, requestStartedAt)
      schedule()
    },

    async recordDelta() {
      if (stopped) return
      sawDelta = true
      lastProgressAt = now()
      toolProgress = null
      cancelTimer()
      if (currentPhase !== 'streaming') {
        currentPhase = 'streaming'
        await emit(currentPhase, lastProgressAt)
      }
      schedule()
    },

    async recordToolProgress(progress) {
      if (stopped) return
      const safe = normalizeModelPhaseProgress(progress)
      if (!Number.isSafeInteger(safe.toolArgumentsChars)) return
      const timestamp = now()
      const switched = toolProgress?.toolCallId !== safe.toolCallId || toolProgress?.toolName !== safe.toolName
      sawDelta = true
      lastProgressAt = timestamp
      toolProgress = safe
      cancelTimer()
      if (currentPhase !== 'tool_arguments' || switched || timestamp - lastToolEmissionAt >= TOOL_PROGRESS_INTERVAL_MS) {
        currentPhase = 'tool_arguments'
        lastToolEmissionAt = timestamp
        await emit(currentPhase, timestamp)
      }
      schedule()
    },

    async stop() {
      if (!stopped) {
        stopped = true
        cancelTimer()
      }
      await emissions
    },
  }
}

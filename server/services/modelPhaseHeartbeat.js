export const DEFAULT_MODEL_PHASE_HEARTBEAT_MS = 15_000

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
} = {}) {
  const interval = normalizedInterval(intervalMs)
  let timer = null
  let stopped = false
  let sawDelta = false
  let currentPhase = null
  let emissions = Promise.resolve()

  const emit = (phase) => {
    if (stopped || typeof onPhase !== 'function') return Promise.resolve()
    emissions = emissions.then(() => onPhase({ phase, iteration }))
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
      currentPhase = 'waiting_first_token'
      cancelTimer()
      await emit(currentPhase)
      schedule()
    },

    async recordDelta() {
      if (stopped) return
      sawDelta = true
      cancelTimer()
      if (currentPhase !== 'streaming') {
        currentPhase = 'streaming'
        await emit(currentPhase)
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

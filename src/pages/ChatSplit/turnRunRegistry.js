function normalizeId(value) {
  return String(value || '').trim()
}

export function createTurnRunRegistry() {
  const runs = new Map()
  const listeners = new Set()

  const notify = () => {
    for (const listener of listeners) {
      try { listener() } catch { /* one view must not break background turn delivery */ }
    }
  }

  return {
    register({ sessionId, turnId, controller }) {
      const normalizedSessionId = normalizeId(sessionId)
      const normalizedTurnId = normalizeId(turnId)
      if (!normalizedSessionId || !normalizedTurnId || !controller?.signal) {
        throw new TypeError('sessionId, turnId, and controller are required')
      }
      const existing = runs.get(normalizedSessionId)
      if (existing) {
        if (existing.turnId === normalizedTurnId && existing.controller === controller) return existing
        const error = new Error('A turn is already running for this session')
        error.code = 'SESSION_TURN_ALREADY_RUNNING'
        throw error
      }
      const run = Object.freeze({
        sessionId: normalizedSessionId,
        turnId: normalizedTurnId,
        controller,
      })
      runs.set(normalizedSessionId, run)
      notify()
      return run
    },

    unregister({ sessionId, turnId, controller }) {
      const existing = runs.get(normalizeId(sessionId))
      if (!existing || existing.turnId !== normalizeId(turnId) || existing.controller !== controller) return false
      runs.delete(existing.sessionId)
      notify()
      return true
    },

    get(sessionId) {
      return runs.get(normalizeId(sessionId)) || null
    },

    has(sessionId, turnId) {
      const existing = runs.get(normalizeId(sessionId))
      return !!existing && (!turnId || existing.turnId === normalizeId(turnId))
    },

    cancel(sessionId) {
      const existing = runs.get(normalizeId(sessionId))
      if (!existing) return false
      existing.controller.abort()
      return true
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const turnRuns = createTurnRunRegistry()

export const registerTurnRun = (run) => turnRuns.register(run)
export const unregisterTurnRun = (run) => turnRuns.unregister(run)
export const getTurnRun = (sessionId) => turnRuns.get(sessionId)
export const hasTurnRun = (sessionId, turnId) => turnRuns.has(sessionId, turnId)
export const cancelTurnRun = (sessionId) => turnRuns.cancel(sessionId)
export const subscribeTurnRuns = (listener) => turnRuns.subscribe(listener)

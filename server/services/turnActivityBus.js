import { parseTurnActivity } from '../../shared/turnEvents.js'

const subscribers = new Map()

function subscriptionKey(userId, sessionId, turnId) {
  return `${userId}\u0000${sessionId}\u0000${turnId}`
}

/**
 * Publishes best-effort live activity. Activities are deliberately process-local:
 * they are not written to turn_events, do not have a sequence, and are never replayed.
 */
export function publishTurnActivity({ userId, activity }) {
  if (!userId) throw new Error('user id is required')
  const value = parseTurnActivity(activity)
  const listeners = subscribers.get(subscriptionKey(userId, value.sessionId, value.turnId))
  if (!listeners) return value
  for (const listener of [...listeners]) {
    try { listener(value) } catch { /* A disconnected live stream must not stop the turn. */ }
  }
  return value
}

export function subscribeTurnActivities({ userId, sessionId, turnId }, listener) {
  if (!userId || !sessionId || !turnId || typeof listener !== 'function') return () => {}
  const key = subscriptionKey(userId, sessionId, turnId)
  const listeners = subscribers.get(key) || new Set()
  listeners.add(listener)
  subscribers.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) subscribers.delete(key)
  }
}

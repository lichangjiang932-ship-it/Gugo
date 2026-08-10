import { getTurnEngine } from './TurnEngine.js'
import { listUnfinishedTurnExecutions } from './turnExecutionLeaseStore.js'
import { logger } from '../utils/logger.js'

const MIN_RECHECK_MS = 25
const FAILED_RECHECK_MS = 1_000
const DISCOVERY_RECHECK_MS = 1_000
const HANDLED_RETENTION_MS = 5 * 60_000

export class TurnRecoveryRuntime {
  constructor({
    engine = getTurnEngine(),
    listUnfinished = listUnfinishedTurnExecutions,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    discoveryIntervalMs = DISCOVERY_RECHECK_MS,
  } = {}) {
    this.engine = engine
    this.listUnfinished = listUnfinished
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.discoveryIntervalMs = Math.max(MIN_RECHECK_MS, Number(discoveryIntervalMs) || DISCOVERY_RECHECK_MS)
    this.startedAt = null
    this.pending = new Map()
    this.handled = new Map()
    this.timer = null
    this.closed = false
    this.scanPromise = null
  }

  start() {
    if (this.startedAt !== null || this.closed) return this
    this.startedAt = this.now()
    this.#schedule(0)
    return this
  }

  stop() {
    this.closed = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.pending.clear()
    this.handled.clear()
  }

  async scan() {
    if (this.closed) return { resumed: 0, waiting: 0 }
    if (this.scanPromise) return this.scanPromise
    this.scanPromise = this.#scanPending().finally(() => { this.scanPromise = null })
    return this.scanPromise
  }

  #key(scope) {
    return `${scope.userId}\u0000${scope.sessionId}\u0000${scope.turnId}`
  }

  #version(candidate) {
    return [
      Number.isInteger(candidate?.lastSequence) ? candidate.lastSequence : '',
      String(candidate?.lastEventType || ''),
      Number(candidate?.lastEventAt) || 0,
    ].join(':')
  }

  #schedule(delayMs) {
    if (this.closed || this.timer !== null || this.startedAt === null) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.scan().catch((error) => logger.warn('[turn-recovery] scan failed:', error?.message || error))
    }, Math.max(0, delayMs))
    this.timer?.unref?.()
  }

  async #scanPending() {
    const now = this.now()
    const current = new Map(this.listUnfinished({ before: now }).map((item) => [this.#key(item), item]))
    for (const [key, handled] of this.handled) {
      if (now - handled.observedAt > HANDLED_RETENTION_MS) this.handled.delete(key)
    }
    for (const [key, candidate] of current) {
      const version = this.#version(candidate)
      const handled = this.handled.get(key)
      const retryHandledCandidate = handled?.version === version
        && Number(handled.retryAt) <= now
      if (!this.pending.has(key) && (handled?.version !== version || retryHandledCandidate)) {
        this.pending.set(key, candidate)
      }
    }
    let resumed = 0
    let nextExpiry = now + this.discoveryIntervalMs
    for (const [key, original] of [...this.pending]) {
      if (this.closed) break
      const candidate = current.get(key)
      if (!candidate) {
        this.pending.delete(key)
        this.handled.set(key, {
          version: this.#version(original),
          observedAt: now,
        })
        continue
      }
      // A clarification/directory pause is a stable wait state, not a crashed
      // execution. Re-running it without the user's resolution would only
      // rediscover the same pause and create a tight recovery loop. A later
      // turn.resumed event changes the version and makes the turn eligible
      // again, even when both events share the same millisecond timestamp.
      if (candidate.lastEventType === 'turn.paused') {
        this.pending.delete(key)
        this.handled.set(key, {
          version: this.#version(candidate),
          observedAt: now,
        })
        continue
      }
      const expiresAt = Number(candidate.lease?.expiresAt) || 0
      if (expiresAt > now) {
        nextExpiry = Math.min(nextExpiry, expiresAt)
        continue
      }
      try {
        const scope = {
          userId: original.userId,
          sessionId: original.sessionId,
          turnId: original.turnId,
        }
        const outcome = typeof this.engine.recoverTurn === 'function'
          ? await this.engine.recoverTurn(scope)
          : { turn: await this.engine.resumeTurn(scope), scheduled: true, locallyActive: true }
        if (outcome?.terminal || outcome?.scheduled || outcome?.locallyActive) {
          this.pending.delete(key)
          this.handled.set(key, {
            version: this.#version(candidate),
            observedAt: this.now(),
            retryAt: this.now() + this.discoveryIntervalMs,
          })
          if (outcome?.scheduled || outcome?.locallyActive) resumed += 1
        } else {
          // A competing process won the atomic claim after our lease snapshot.
          // Keep observing this startup candidate: a terminal event removes it,
          // while an expired lease makes it eligible for another claim.
          nextExpiry = Math.min(nextExpiry, this.now() + MIN_RECHECK_MS)
        }
      } catch (error) {
        logger.warn('[turn-recovery] turn resume failed:', error?.message || error)
        nextExpiry = Math.min(nextExpiry, this.now() + FAILED_RECHECK_MS)
      }
    }
    if (!this.closed) {
      const delay = Number.isFinite(nextExpiry)
        ? Math.max(MIN_RECHECK_MS, nextExpiry - this.now() + MIN_RECHECK_MS)
        : this.discoveryIntervalMs
      this.#schedule(delay)
    }
    return { resumed, waiting: this.pending.size }
  }
}

let singleton = null

export function startTurnRecoveryRuntime(options = {}) {
  if (!singleton) singleton = new TurnRecoveryRuntime(options)
  singleton.start()
  return singleton
}

export function closeTurnRecoveryRuntime() {
  singleton?.stop()
  singleton = null
}

export function _resetTurnRecoveryRuntime() {
  closeTurnRecoveryRuntime()
}

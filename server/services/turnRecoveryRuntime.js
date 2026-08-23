import { getTurnEngine } from './turnEngineHost.js'
import { logger } from '../utils/logger.js'
import { getActiveTurnPersistenceAdapter } from '../core/turnPersistenceAdapter.js'

const MIN_RECHECK_MS = 25
const DISCOVERY_RECHECK_MS = 1_000
const HANDLED_RETENTION_MS = 5 * 60_000
const DEFAULT_FAILURE_MAX_ATTEMPTS = 5
const DEFAULT_FAILURE_BASE_DELAY_MS = 1_000
const DEFAULT_FAILURE_MAX_DELAY_MS = 60_000

const NON_RETRYABLE_RECOVERY_CODES = new Set([
  'MODEL_CONFIG_MISSING',
  'MODEL_PROVIDER_UNVERIFIED',
  'MODEL_PROVIDER_CHAT_ONLY',
  'MODEL_PROVIDER_UNAVAILABLE',
  'MODEL_PROVIDER_CONFIG_CHANGED',
  'MODEL_PROVIDER_BINDING_MISSING',
  'MODEL_REQUEST_CONTEXT_DRIFT',
  'MODEL_REQUEST_OUTCOME_UNKNOWN',
  'TURN_ATOMIC_CHECKPOINT_UNSUPPORTED',
  'TURN_ATOMIC_CHECKPOINT_COMMIT_MISMATCH',
  'REASONING_RUNAWAY',
  'TURN_NOT_FOUND',
  'TURN_DIRECTORY_GRANT_NOT_FOUND',
  'UNAUTHORIZED',
])

function normalizedPositiveInteger(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

function recoveryErrorRetryable(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable
  if (error?.name === 'AbortError' || NON_RETRYABLE_RECOVERY_CODES.has(error?.code)) return false
  const status = Number(error?.status ?? error?.statusCode)
  if (Number.isFinite(status)) {
    if ([408, 409, 425, 429].includes(status) || status >= 500) return true
    if (status >= 400) return false
  }
  // Unknown infrastructure errors are retried within the finite budget. This
  // covers transient SQLite/filesystem failures without replaying explicitly
  // unsafe model outcomes, which are denied by code above.
  return true
}

function recoveryErrorCode(error) {
  return error?.code ? String(error.code) : null
}

function recoveryErrorMessage(error) {
  return String(error?.message || error || 'turn recovery failed').slice(0, 2_000)
}

function requirePersistenceFunction(override, section, name) {
  const implementation = override === null || override === undefined
    ? section?.[name]
    : override
  if (typeof implementation === 'function') return implementation
  const error = new TypeError(`active turn persistence adapter must implement ${name}`)
  error.code = 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED'
  error.retryable = false
  throw error
}

export class TurnRecoveryRuntime {
  constructor({
    engine = getTurnEngine(),
    listUnfinished = null,
    readRecoveryState = null,
    writeRecoveryFailure = null,
    clearRecovery = null,
    listRecoveryStates = null,
    pruneResolvedRecovery = null,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,
    discoveryIntervalMs = DISCOVERY_RECHECK_MS,
    failureMaxAttempts = DEFAULT_FAILURE_MAX_ATTEMPTS,
    failureBaseDelayMs = DEFAULT_FAILURE_BASE_DELAY_MS,
    failureMaxDelayMs = DEFAULT_FAILURE_MAX_DELAY_MS,
  } = {}) {
    const activePersistence = getActiveTurnPersistenceAdapter()
    const executionBackend = activePersistence?.execution
    const recoveryBackend = activePersistence?.recovery
    this.engine = engine
    this.listUnfinished = requirePersistenceFunction(
      listUnfinished,
      executionBackend,
      'listUnfinishedTurnExecutions',
    )
    this.readRecoveryState = requirePersistenceFunction(
      readRecoveryState,
      recoveryBackend,
      'getTurnRecoveryState',
    )
    this.writeRecoveryFailure = requirePersistenceFunction(
      writeRecoveryFailure,
      recoveryBackend,
      'recordTurnRecoveryFailure',
    )
    this.clearRecovery = requirePersistenceFunction(
      clearRecovery,
      recoveryBackend,
      'clearTurnRecoveryState',
    )
    this.listRecoveryStates = requirePersistenceFunction(
      listRecoveryStates,
      recoveryBackend,
      'listTurnRecoveryStates',
    )
    this.pruneResolvedRecovery = requirePersistenceFunction(
      pruneResolvedRecovery,
      recoveryBackend,
      'pruneResolvedTurnRecoveryStates',
    )
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.random = random
    this.discoveryIntervalMs = Math.max(MIN_RECHECK_MS, Number(discoveryIntervalMs) || DISCOVERY_RECHECK_MS)
    this.failureMaxAttempts = normalizedPositiveInteger(failureMaxAttempts, DEFAULT_FAILURE_MAX_ATTEMPTS)
    this.failureBaseDelayMs = normalizedPositiveInteger(
      failureBaseDelayMs,
      DEFAULT_FAILURE_BASE_DELAY_MS,
      MIN_RECHECK_MS,
    )
    this.failureMaxDelayMs = Math.max(
      this.failureBaseDelayMs,
      normalizedPositiveInteger(failureMaxDelayMs, DEFAULT_FAILURE_MAX_DELAY_MS, MIN_RECHECK_MS),
    )
    this.startedAt = null
    this.pending = new Map()
    this.handled = new Map()
    this.volatileFailures = new Map()
    this.timer = null
    this.closed = false
    this.scanPromise = null
    this.lastScanAt = null
    this.lastScanError = null
    this.discoveryFailureCount = 0
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
    this.volatileFailures.clear()
  }

  async scan() {
    if (this.closed) return { resumed: 0, waiting: 0 }
    if (this.scanPromise) return this.scanPromise
    this.scanPromise = this.#scanPending().finally(() => { this.scanPromise = null })
    return this.scanPromise
  }

  diagnostics() {
    const view = (durableStates = []) => ({
      startedAt: this.startedAt,
      closed: this.closed,
      pending: this.pending.size,
      lastScanAt: this.lastScanAt,
      lastScanError: this.lastScanError,
      discoveryFailureCount: this.discoveryFailureCount,
      retrying: durableStates.filter((state) => state.status === 'retrying'),
      deadLetters: durableStates.filter((state) => state.status === 'dead_letter'),
    })
    try {
      const durableStates = this.listRecoveryStates({ limit: 10_000 })
      return durableStates && typeof durableStates.then === 'function'
        ? Promise.resolve(durableStates).then(view, () => view())
        : view(durableStates)
    } catch {
      return view()
    }
  }

  async retryTurn(scope = {}) {
    const key = this.#key(scope)
    await this.clearRecovery(scope)
    this.pending.delete(key)
    this.handled.delete(key)
    this.volatileFailures.delete(key)
    return this.scan()
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

  #failureDelay(attempt) {
    const exponent = Math.min(
      this.failureMaxDelayMs,
      this.failureBaseDelayMs * 2 ** Math.max(0, Number(attempt) - 1),
    )
    const sample = Math.min(1, Math.max(0, Number(this.random?.()) || 0))
    return Math.max(MIN_RECHECK_MS, Math.floor(exponent * (0.5 + (sample * 0.5))))
  }

  async #clearRecovery(scope, candidateVersion = null) {
    const key = this.#key(scope)
    this.volatileFailures.delete(key)
    try {
      await this.clearRecovery(scope, candidateVersion == null ? {} : { candidateVersion })
    } catch (error) {
      logger.warn('[turn-recovery] failed to clear recovery state:', recoveryErrorMessage(error))
    }
  }

  async #recordFailure(candidate, version, error) {
    const scope = {
      userId: candidate.userId,
      sessionId: candidate.sessionId,
      turnId: candidate.turnId,
    }
    const key = this.#key(scope)
    const retryable = recoveryErrorRetryable(error)
    const failedAt = this.now()
    try {
      const state = await this.writeRecoveryFailure({
        ...scope,
        candidateVersion: version,
        retryable,
        errorCode: recoveryErrorCode(error),
        errorMessage: recoveryErrorMessage(error),
        now: failedAt,
        maxAttempts: this.failureMaxAttempts,
        baseDelayMs: this.failureBaseDelayMs,
        maxDelayMs: this.failureMaxDelayMs,
        random: this.random,
      })
      this.volatileFailures.delete(key)
      return state
    } catch (stateError) {
      logger.error('[turn-recovery] failed to persist recovery state:', recoveryErrorMessage(stateError))
      const previous = this.volatileFailures.get(key)
      const attemptCount = previous?.candidateVersion === version ? previous.attemptCount + 1 : 1
      const deadLetter = !retryable || attemptCount >= this.failureMaxAttempts
      const state = {
        ...scope,
        candidateVersion: version,
        status: deadLetter ? 'dead_letter' : 'retrying',
        attemptCount,
        retryable,
        firstFailedAt: previous?.candidateVersion === version ? previous.firstFailedAt : failedAt,
        lastFailedAt: failedAt,
        nextRetryAt: deadLetter ? null : failedAt + this.#failureDelay(attemptCount),
        errorCode: recoveryErrorCode(error),
        errorMessage: recoveryErrorMessage(error),
      }
      this.volatileFailures.set(key, state)
      return state
    }
  }

  async #readRecovery(candidate, version) {
    const key = this.#key(candidate)
    const volatile = this.volatileFailures.get(key)
    if (volatile?.candidateVersion === version) return volatile
    const durable = await this.readRecoveryState(candidate)
    if (durable && durable.candidateVersion !== version) {
      await this.#clearRecovery(candidate, durable.candidateVersion)
      return null
    }
    return durable
  }

  async #scanPending() {
    const now = this.now()
    let current
    try {
      const unfinished = await this.listUnfinished({ before: now })
      current = new Map(unfinished.map((item) => [this.#key(item), item]))
      this.lastScanAt = now
      this.lastScanError = null
      this.discoveryFailureCount = 0
      try { await this.pruneResolvedRecovery() }
      catch (error) { logger.warn('[turn-recovery] state pruning failed:', recoveryErrorMessage(error)) }
    } catch (error) {
      this.lastScanAt = now
      this.lastScanError = {
        code: recoveryErrorCode(error),
        message: recoveryErrorMessage(error),
        at: now,
      }
      this.discoveryFailureCount += 1
      this.#schedule(this.#failureDelay(this.discoveryFailureCount))
      throw error
    }
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
        await this.#clearRecovery(original, this.#version(original))
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
        await this.#clearRecovery(candidate, this.#version(candidate))
        this.handled.set(key, {
          version: this.#version(candidate),
          observedAt: now,
        })
        continue
      }
      // An execution-environment mismatch is a durable manual-repair state.
      // It remains unfinished so its checkpoint can be retried after repair,
      // but startup recovery must never loop over it automatically.
      if (candidate.lastEventType === 'turn.blocked') {
        this.pending.delete(key)
        this.handled.set(key, {
          version: this.#version(candidate),
          observedAt: now,
        })
        continue
      }
      const version = this.#version(candidate)
      let recoveryState
      try {
        recoveryState = await this.#readRecovery(candidate, version)
      } catch (error) {
        this.lastScanError = {
          code: recoveryErrorCode(error),
          message: recoveryErrorMessage(error),
          at: this.now(),
        }
        this.discoveryFailureCount += 1
        nextExpiry = Math.min(nextExpiry, this.now() + this.#failureDelay(this.discoveryFailureCount))
        logger.warn('[turn-recovery] recovery state read failed:', recoveryErrorMessage(error))
        continue
      }
      if (recoveryState?.status === 'dead_letter') {
        this.pending.delete(key)
        this.handled.set(key, { version, observedAt: now })
        continue
      }
      if (recoveryState?.status === 'retrying' && Number(recoveryState.nextRetryAt) > now) {
        nextExpiry = Math.min(nextExpiry, Number(recoveryState.nextRetryAt))
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
          await this.#clearRecovery(candidate, version)
          this.handled.set(key, {
            version,
            observedAt: this.now(),
            retryAt: this.now() + this.discoveryIntervalMs,
          })
          if (outcome?.scheduled || outcome?.locallyActive) resumed += 1
        } else {
          // A competing process won the atomic claim after our lease snapshot.
          // Keep observing this startup candidate: a terminal event removes it,
          // while an expired lease makes it eligible for another claim.
          await this.#clearRecovery(candidate, version)
          nextExpiry = Math.min(nextExpiry, this.now() + MIN_RECHECK_MS)
        }
      } catch (error) {
        const state = await this.#recordFailure(candidate, version, error)
        logger.warn(
          `[turn-recovery] turn resume failed (${state.status}, attempt ${state.attemptCount}):`,
          recoveryErrorMessage(error),
        )
        if (state.status === 'dead_letter') {
          this.pending.delete(key)
          this.handled.set(key, { version, observedAt: this.now() })
        } else {
          nextExpiry = Math.min(nextExpiry, Number(state.nextRetryAt) || (this.now() + this.failureBaseDelayMs))
        }
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

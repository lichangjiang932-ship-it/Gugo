import crypto from 'node:crypto'

import { closeDb } from '../db.js'
import { logger } from '../utils/logger.js'
import * as hubDb from './hubDb.js'
import {
  DEFAULT_HUB_LEASE_MS,
  executeLeasedHubJob,
  hubLeaseDuration,
  hubLeaseLostError,
  hubRetryBackoffMs,
  hubRuntimeShutdownError,
} from './jobLeaseRuntime.js'
import * as jobRegistry from './jobRegistry.js'
import { createHubSessionDeletionRecoveryBarrier } from './sessionDeletionRecoveryBarrier.js'

const DEFAULT_TICK_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000
const DEFAULT_SHUTDOWN_POLL_MS = 100
const MAX_JOBS_PER_TICK = 20

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value))
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback
}

function createOwnerId() {
  return `hub-${process.pid}-${crypto.randomUUID()}`
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    const error = new Error(`Hub runtime dependency is unavailable: ${name}`)
    error.code = 'HUB_RUNTIME_DEPENDENCY_MISSING'
    throw error
  }
  return value
}

/**
 * Isolated Hub runtime factory. Production uses the singleton below; tests and
 * embedders can inject a queue, registry, clock, and timers without sharing
 * process-global runtime state.
 */
export function createHubRuntime(dependencies = {}) {
  const database = dependencies.db || hubDb
  const registry = dependencies.registry || jobRegistry
  const loggerImpl = dependencies.logger || logger
  const closeDatabase = dependencies.closeDb || closeDb
  const now = dependencies.now || Date.now
  const setTimeoutFn = dependencies.setTimeoutFn || setTimeout
  const clearTimeoutFn = dependencies.clearTimeoutFn || clearTimeout
  const makeOwnerId = dependencies.createOwnerId || createOwnerId
  const configuredShutdownTimeout = dependencies.shutdownTimeoutMs
  const configuredShutdownPoll = dependencies.shutdownPollMs
  const sessionDeletionRecoveryBarrier = dependencies.sessionDeletionRecoveryBarrier || null

  let tickTimer = null
  let shutdownTimer = null
  let running = false
  let started = false
  let shuttingDown = false
  let runtimeEnv = process.env
  let shutdownPromise = null
  let ownerId = null
  let activeExecution = null
  let sessionDeletionRecoveryReady = false

  const log = (...args) => loggerImpl.info('[hub]', ...args)
  const logErr = (...args) => loggerImpl.error('[hub]', ...args)
  const getTickMs = () => positiveInteger(runtimeEnv.HUB_TICK_MS, DEFAULT_TICK_MS, 100)
  const getLeaseMs = () => hubLeaseDuration(runtimeEnv.HUB_LEASE_MS || DEFAULT_HUB_LEASE_MS)
  const getShutdownTimeoutMs = () => positiveInteger(
    configuredShutdownTimeout ?? runtimeEnv.HUB_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
  )
  const getShutdownPollMs = () => positiveInteger(
    configuredShutdownPoll,
    DEFAULT_SHUTDOWN_POLL_MS,
  )
  const ensureOwnerId = () => {
    ownerId ||= String(makeOwnerId())
    if (!ownerId) {
      const error = new Error('Hub runtime owner identity is unavailable')
      error.code = 'HUB_RUNTIME_OWNER_UNAVAILABLE'
      throw error
    }
    return ownerId
  }
  const clearTickTimer = () => {
    if (tickTimer !== null) clearTimeoutFn(tickTimer)
    tickTimer = null
  }
  const ensureSessionDeletionRecovery = () => {
    if (!sessionDeletionRecoveryBarrier || sessionDeletionRecoveryReady) return false
    requireFunction(
      sessionDeletionRecoveryBarrier.start,
      'sessionDeletionRecoveryBarrier.start',
    )({ env: runtimeEnv })
    sessionDeletionRecoveryReady = true
    return true
  }
  const releaseSessionDeletionRecovery = () => {
    if (!sessionDeletionRecoveryBarrier || !sessionDeletionRecoveryReady) return false
    requireFunction(
      sessionDeletionRecoveryBarrier.stop,
      'sessionDeletionRecoveryBarrier.stop',
    )()
    sessionDeletionRecoveryReady = false
    return true
  }

  /** Run at most one claimed Hub job. */
  const runOnce = async () => {
    if (running || shuttingDown) return false
    running = true
    try {
      ensureSessionDeletionRecovery()
      const workerId = ensureOwnerId()
      const leaseMs = getLeaseMs()
      const claimNextPending = requireFunction(database.claimNextPending, 'claimNextPending')
      const job = claimNextPending({ ownerId: workerId, now, leaseMs })
      if (!job) return false

      const handler = requireFunction(registry.getHandler, 'getHandler')(job.name)
      if (!handler) {
        const error = new Error(`no handler registered for "${job.name}"`)
        try {
          requireFunction(database.recordJobFailure, 'recordJobFailure')(job.id, {
            ownerId: workerId,
            leaseToken: job.leaseToken,
            retryable: false,
            errorMessage: error.message,
            now,
          })
          logErr(`job ${job.id} (${job.name}) failed: no handler`)
        } catch (writeError) {
          if (writeError?.code !== 'HUB_JOB_LEASE_LOST') throw writeError
          logErr(`job ${job.id} (${job.name}) lost its lease before handler rejection`)
        }
        return true
      }

      const outcome = await executeLeasedHubJob({
        job,
        handler,
        ownerId: workerId,
        leaseMs,
        renewJobLease: requireFunction(database.renewJobLease, 'renewJobLease'),
        markDone: requireFunction(database.markDone, 'markDone'),
        recordJobFailure: requireFunction(database.recordJobFailure, 'recordJobFailure'),
        retryBackoffMs: hubRetryBackoffMs(job.attemptCount),
        now,
        setTimeoutFn,
        clearTimeoutFn,
        onActive(execution) {
          activeExecution = execution
        },
        onInactive(execution) {
          if (activeExecution === execution) activeExecution = null
        },
      })
      if (outcome.status === 'done') {
        log(`job ${job.id} (${job.name}) done`)
      } else if (outcome.status === 'failed') {
        logErr(`job ${job.id} (${job.name}) failed:`, outcome.error?.message || outcome.error)
      } else {
        logErr(`job ${job.id} (${job.name}) stopped:`, outcome.error?.message || outcome.error)
      }
      return true
    } finally {
      running = false
    }
  }

  const tick = async () => {
    tickTimer = null
    if (shuttingDown) return
    try {
      const recovery = requireFunction(database.recoverStaleJobs, 'recoverStaleJobs')({ now })
      if (recovery?.recovered > 0) {
        log(
          `recovered ${recovery.recovered} stale job(s), `
          + `requeued=${recovery.requeued || 0}, deadLettered=${recovery.deadLettered || 0}`,
        )
      }
      let processed = 0
      while (!shuttingDown && await runOnce()) {
        processed += 1
        if (processed >= MAX_JOBS_PER_TICK) break
      }
    } catch (error) {
      logErr('tick error:', error?.message || error)
    } finally {
      if (!shuttingDown) tickTimer = setTimeoutFn(tick, getTickMs())
    }
  }

  const startHub = ({ env = process.env } = {}) => {
    if (started || running || shuttingDown) {
      const error = new Error('Hub runtime is already started or shutting down')
      error.code = 'HUB_RUNTIME_STATE_CONFLICT'
      throw error
    }
    runtimeEnv = env
    ensureOwnerId()
    const handlers = requireFunction(registry.listHandlers, 'listHandlers')()
    let barrierActivated = false
    try {
      barrierActivated = ensureSessionDeletionRecovery()
      requireFunction(database.runHubMigrations, 'runHubMigrations')()
      const recovery = requireFunction(database.recoverStaleJobs, 'recoverStaleJobs')({ now })
      tickTimer = setTimeoutFn(tick, 0)
      log(
        `booted, owner=${ownerId}, handlers=[${handlers.join(', ')}], `
        + `tick=${getTickMs()}ms, lease=${getLeaseMs()}ms, recovered=${recovery?.recovered || 0}`,
      )
      started = true
      return true
    } catch (error) {
      clearTickTimer()
      if (barrierActivated) {
        try {
          releaseSessionDeletionRecovery()
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            'Hub startup failed and its session deletion recovery barrier could not be released',
            { cause: releaseError },
          )
        }
      }
      throw error
    }
  }

  const shutdownHub = () => {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    log('shutdown signal received')
    clearTickTimer()

    shutdownPromise = new Promise((resolve) => {
      const startedAt = now()
      let finished = false
      const finish = (exitCode) => {
        if (finished) return
        finished = true
        if (shutdownTimer !== null) clearTimeoutFn(shutdownTimer)
        shutdownTimer = null
        let resolvedExitCode = exitCode
        try {
          releaseSessionDeletionRecovery()
        } catch (error) {
          resolvedExitCode = 1
          logErr('session deletion recovery barrier release failed:', error?.message || error)
        }
        try {
          closeDatabase()
        } catch {
          // Best effort after the queue has stopped accepting work.
        }
        started = false
        log('shutdown complete')
        resolve(resolvedExitCode)
      }
      const waitForActiveJob = () => {
        shutdownTimer = null
        if (!running) {
          finish(0)
          return
        }
        if (now() - startedAt >= getShutdownTimeoutMs()) {
          logErr('forced shutdown (timeout)')
          const expiringExecution = activeExecution
          const leaseExpiresAt = Number(expiringExecution?.lease?.expiresAt)
          expiringExecution?.abort(hubRuntimeShutdownError())
          expiringExecution?.stop()

          // There is intentionally no unfenced "release" mutation. Once the
          // heartbeat stops, wait until the last authoritative proof expires
          // before closing the DB. A late handler then cannot reopen the DB
          // and commit with a token that was still valid at forced shutdown.
          const waitForFenceExpiry = () => {
            shutdownTimer = null
            const remaining = leaseExpiresAt - now()
            if (!Number.isFinite(remaining) || remaining <= 0) {
              finish(1)
              return
            }
            shutdownTimer = setTimeoutFn(waitForFenceExpiry, remaining)
          }
          waitForFenceExpiry()
          return
        }
        shutdownTimer = setTimeoutFn(waitForActiveJob, getShutdownPollMs())
      }
      waitForActiveJob()
    })
    return shutdownPromise
  }

  return Object.freeze({
    runOnce,
    startHub,
    shutdownHub,
    inspect() {
      return Object.freeze({
        activeJobId: activeExecution?.job?.id || null,
        ownerId,
        running,
        shuttingDown,
        started,
        sessionDeletionRecoveryReady,
      })
    },
  })
}

const defaultRuntime = createHubRuntime({
  sessionDeletionRecoveryBarrier: createHubSessionDeletionRecoveryBarrier(),
})

export function runOnce() {
  return defaultRuntime.runOnce()
}

export function startHub(options = {}) {
  return defaultRuntime.startHub(options)
}

export function shutdownHub() {
  return defaultRuntime.shutdownHub()
}

export { hubLeaseLostError }

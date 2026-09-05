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

function hubLog(runtime, ...args) {
  runtime.logger.info('[hub]', ...args)
}

function hubLogError(runtime, ...args) {
  runtime.logger.error('[hub]', ...args)
}

function hubTickMs(runtime) {
  return positiveInteger(runtime.state.env.HUB_TICK_MS, DEFAULT_TICK_MS, 100)
}

function hubLeaseMs(runtime) {
  return hubLeaseDuration(runtime.state.env.HUB_LEASE_MS || DEFAULT_HUB_LEASE_MS)
}

function hubShutdownTimeoutMs(runtime) {
  return positiveInteger(
    runtime.configuredShutdownTimeout ?? runtime.state.env.HUB_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
  )
}

function hubShutdownPollMs(runtime) {
  return positiveInteger(runtime.configuredShutdownPoll, DEFAULT_SHUTDOWN_POLL_MS)
}

function ensureHubOwnerId(runtime) {
  runtime.state.ownerId ||= String(runtime.makeOwnerId())
  if (!runtime.state.ownerId) {
    const error = new Error('Hub runtime owner identity is unavailable')
    error.code = 'HUB_RUNTIME_OWNER_UNAVAILABLE'
    throw error
  }
  return runtime.state.ownerId
}

function clearHubTickTimer(runtime) {
  if (runtime.state.tickTimer !== null) runtime.clearTimeoutFn(runtime.state.tickTimer)
  runtime.state.tickTimer = null
}

function ensureSessionDeletionRecovery(runtime) {
  if (!runtime.sessionDeletionRecoveryBarrier
    || runtime.state.sessionDeletionRecoveryReady) return false
  requireFunction(
    runtime.sessionDeletionRecoveryBarrier.start,
    'sessionDeletionRecoveryBarrier.start',
  )({ env: runtime.state.env })
  runtime.state.sessionDeletionRecoveryReady = true
  return true
}

function releaseSessionDeletionRecovery(runtime) {
  if (!runtime.sessionDeletionRecoveryBarrier
    || !runtime.state.sessionDeletionRecoveryReady) return false
  requireFunction(
    runtime.sessionDeletionRecoveryBarrier.stop,
    'sessionDeletionRecoveryBarrier.stop',
  )()
  runtime.state.sessionDeletionRecoveryReady = false
  return true
}

async function runHubJobOnce(runtime) {
  const { state, database, registry, now, setTimeoutFn, clearTimeoutFn } = runtime
  if (state.running || state.shuttingDown) return false
  state.running = true
  try {
    ensureSessionDeletionRecovery(runtime)
    const workerId = ensureHubOwnerId(runtime)
    const leaseMs = hubLeaseMs(runtime)
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
        hubLogError(runtime, `job ${job.id} (${job.name}) failed: no handler`)
      } catch (writeError) {
        if (writeError?.code !== 'HUB_JOB_LEASE_LOST') throw writeError
        hubLogError(runtime, `job ${job.id} (${job.name}) lost its lease before handler rejection`)
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
      onActive(execution) { state.activeExecution = execution },
      onInactive(execution) {
        if (state.activeExecution === execution) state.activeExecution = null
      },
    })
    if (outcome.status === 'done') {
      hubLog(runtime, `job ${job.id} (${job.name}) done`)
    } else if (outcome.status === 'failed') {
      hubLogError(runtime, `job ${job.id} (${job.name}) failed:`, outcome.error?.message || outcome.error)
    } else {
      hubLogError(runtime, `job ${job.id} (${job.name}) stopped:`, outcome.error?.message || outcome.error)
    }
    return true
  } finally {
    state.running = false
  }
}

async function tickHubRuntime(runtime) {
  const { state, database, now, setTimeoutFn } = runtime
  state.tickTimer = null
  if (state.shuttingDown) return
  try {
    const recovery = requireFunction(database.recoverStaleJobs, 'recoverStaleJobs')({ now })
    if (recovery?.recovered > 0) {
      hubLog(
        runtime,
        `recovered ${recovery.recovered} stale job(s), `
          + `requeued=${recovery.requeued || 0}, deadLettered=${recovery.deadLettered || 0}`,
      )
    }
    let processed = 0
    while (!state.shuttingDown && await runHubJobOnce(runtime)) {
      processed += 1
      if (processed >= MAX_JOBS_PER_TICK) break
    }
  } catch (error) {
    hubLogError(runtime, 'tick error:', error?.message || error)
  } finally {
    if (!state.shuttingDown) state.tickTimer = setTimeoutFn(runtime.tick, hubTickMs(runtime))
  }
}

function startHubRuntime(runtime, { env = process.env } = {}) {
  const { state, registry, database, now, setTimeoutFn } = runtime
  if (state.started || state.running || state.shuttingDown) {
    const error = new Error('Hub runtime is already started or shutting down')
    error.code = 'HUB_RUNTIME_STATE_CONFLICT'
    throw error
  }
  state.env = env
  ensureHubOwnerId(runtime)
  const handlers = requireFunction(registry.listHandlers, 'listHandlers')()
  let barrierActivated = false
  try {
    barrierActivated = ensureSessionDeletionRecovery(runtime)
    requireFunction(database.runHubMigrations, 'runHubMigrations')()
    const recovery = requireFunction(database.recoverStaleJobs, 'recoverStaleJobs')({ now })
    state.tickTimer = setTimeoutFn(runtime.tick, 0)
    hubLog(
      runtime,
      `booted, owner=${state.ownerId}, handlers=[${handlers.join(', ')}], `
        + `tick=${hubTickMs(runtime)}ms, lease=${hubLeaseMs(runtime)}ms, recovered=${recovery?.recovered || 0}`,
    )
    state.started = true
    return true
  } catch (error) {
    clearHubTickTimer(runtime)
    if (barrierActivated) {
      try {
        releaseSessionDeletionRecovery(runtime)
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

function finishHubShutdown(runtime, resolve, finishState, exitCode) {
  if (finishState.finished) return
  finishState.finished = true
  if (runtime.state.shutdownTimer !== null) runtime.clearTimeoutFn(runtime.state.shutdownTimer)
  runtime.state.shutdownTimer = null
  let resolvedExitCode = exitCode
  try {
    releaseSessionDeletionRecovery(runtime)
  } catch (error) {
    resolvedExitCode = 1
    hubLogError(runtime, 'session deletion recovery barrier release failed:', error?.message || error)
  }
  try { runtime.closeDatabase() } catch { /* best effort after queue stopped accepting work */ }
  runtime.state.started = false
  hubLog(runtime, 'shutdown complete')
  resolve(resolvedExitCode)
}

function waitForHubShutdown(runtime, resolve, finishState, startedAt) {
  const { state, now, setTimeoutFn } = runtime
  state.shutdownTimer = null
  if (!state.running) {
    finishHubShutdown(runtime, resolve, finishState, 0)
    return
  }
  if (now() - startedAt >= hubShutdownTimeoutMs(runtime)) {
    hubLogError(runtime, 'forced shutdown (timeout)')
    const expiringExecution = state.activeExecution
    const leaseExpiresAt = Number(expiringExecution?.lease?.expiresAt)
    expiringExecution?.abort(hubRuntimeShutdownError())
    expiringExecution?.stop()
    const waitForFenceExpiry = () => {
      state.shutdownTimer = null
      const remaining = leaseExpiresAt - now()
      if (!Number.isFinite(remaining) || remaining <= 0) {
        finishHubShutdown(runtime, resolve, finishState, 1)
        return
      }
      state.shutdownTimer = setTimeoutFn(waitForFenceExpiry, remaining)
    }
    waitForFenceExpiry()
    return
  }
  state.shutdownTimer = setTimeoutFn(
    () => waitForHubShutdown(runtime, resolve, finishState, startedAt),
    hubShutdownPollMs(runtime),
  )
}

function shutdownHubRuntime(runtime) {
  const { state, now } = runtime
  if (state.shutdownPromise) return state.shutdownPromise
  state.shuttingDown = true
  hubLog(runtime, 'shutdown signal received')
  clearHubTickTimer(runtime)
  state.shutdownPromise = new Promise((resolve) => {
    waitForHubShutdown(runtime, resolve, { finished: false }, now())
  })
  return state.shutdownPromise
}

/** Isolated Hub runtime factory with injectable queue, registry, clock, and timers. */
export function createHubRuntime(dependencies = {}) {
  const state = {
    tickTimer: null,
    shutdownTimer: null,
    running: false,
    started: false,
    shuttingDown: false,
    env: process.env,
    shutdownPromise: null,
    ownerId: null,
    activeExecution: null,
    sessionDeletionRecoveryReady: false,
  }
  const runtime = {
    database: dependencies.db || hubDb,
    registry: dependencies.registry || jobRegistry,
    logger: dependencies.logger || logger,
    closeDatabase: dependencies.closeDb || closeDb,
    now: dependencies.now || Date.now,
    setTimeoutFn: dependencies.setTimeoutFn || setTimeout,
    clearTimeoutFn: dependencies.clearTimeoutFn || clearTimeout,
    makeOwnerId: dependencies.createOwnerId || createOwnerId,
    configuredShutdownTimeout: dependencies.shutdownTimeoutMs,
    configuredShutdownPoll: dependencies.shutdownPollMs,
    sessionDeletionRecoveryBarrier: dependencies.sessionDeletionRecoveryBarrier || null,
    state,
    tick: null,
  }
  runtime.tick = () => tickHubRuntime(runtime)
  return Object.freeze({
    runOnce: () => runHubJobOnce(runtime),
    startHub: (options) => startHubRuntime(runtime, options),
    shutdownHub: () => shutdownHubRuntime(runtime),
    inspect() {
      return Object.freeze({
        activeJobId: state.activeExecution?.job?.id || null,
        ownerId: state.ownerId,
        running: state.running,
        shuttingDown: state.shuttingDown,
        started: state.started,
        sessionDeletionRecoveryReady: state.sessionDeletionRecoveryReady,
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

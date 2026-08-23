export const MIN_HUB_LEASE_MS = 300
export const DEFAULT_HUB_LEASE_MS = 30_000
const DEFAULT_HUB_RETRY_BACKOFF_MS = 1_000
const MAX_HUB_RETRY_BACKOFF_MS = 60_000

export function hubLeaseDuration(value) {
  const duration = Math.floor(Number(value))
  return Number.isSafeInteger(duration) && duration >= MIN_HUB_LEASE_MS
    ? duration
    : DEFAULT_HUB_LEASE_MS
}

export function hubRetryBackoffMs(attemptCount) {
  const parsedAttempt = Math.floor(Number(attemptCount))
  const attempt = Number.isSafeInteger(parsedAttempt) && parsedAttempt > 0 ? parsedAttempt : 1
  let backoff = DEFAULT_HUB_RETRY_BACKOFF_MS
  for (let index = 1; index < attempt && backoff < MAX_HUB_RETRY_BACKOFF_MS; index += 1) {
    backoff = Math.min(MAX_HUB_RETRY_BACKOFF_MS, backoff * 2)
  }
  return backoff
}

function leaseRuntimeError(code, message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    name: 'AbortError',
    code,
  })
}

export function hubLeaseLostError(cause = null) {
  return leaseRuntimeError(
    'HUB_JOB_LEASE_LOST',
    'Hub job lease was lost',
    cause,
  )
}

export function hubRuntimeShutdownError() {
  return leaseRuntimeError(
    'HUB_RUNTIME_SHUTDOWN',
    'Hub runtime stopped before the job completed',
  )
}

function leaseProofError(message) {
  return Object.assign(new Error(message), {
    code: 'HUB_JOB_LEASE_PROOF_UNAVAILABLE',
  })
}

function timestamp(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function hasLeaseToken(value) {
  return value !== null && value !== undefined && value !== ''
}

function isFencingFailure(error) {
  return error?.code === 'HUB_JOB_LEASE_LOST'
}

function isSqliteBusy(error) {
  const code = String(error?.code || '')
  if (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_')) return true
  if (code !== 'ERR_SQLITE_ERROR') return false
  const errcode = Number(error?.errcode)
  return Number.isInteger(errcode) && errcode >= 0 && (errcode & 0xff) === 5
}

function waitForTerminalRetry({
  signal,
  delayMs,
  setTimeoutFn,
  clearTimeoutFn,
}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || hubLeaseLostError())
      return
    }
    let timer = null
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      if (timer !== null) clearTimeoutFn(timer)
      timer = null
    }
    const onAbort = () => {
      cleanup()
      reject(signal.reason || hubLeaseLostError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeoutFn(() => {
      cleanup()
      resolve()
    }, delayMs)
    timer?.unref?.()
  })
}

async function retryFencedTerminalWrite({
  write,
  monitor,
  leaseMs,
  now,
  setTimeoutFn,
  clearTimeoutFn,
}) {
  const retryDelayMs = Math.max(25, Math.min(250, Math.floor(hubLeaseDuration(leaseMs) / 12)))
  while (true) {
    if (monitor.signal.aborted) throw monitor.signal.reason || hubLeaseLostError()
    try {
      return write()
    } catch (error) {
      if (isFencingFailure(error)) {
        monitor.abort(hubLeaseLostError(error))
        throw monitor.signal.reason || hubLeaseLostError(error)
      }
      if (!isSqliteBusy(error)) throw error
      const observedAt = timestamp(now())
      const expiresAt = timestamp(monitor.lease.expiresAt)
      if (observedAt === null || expiresAt === null || observedAt >= expiresAt) {
        monitor.abort(hubLeaseLostError(error))
        throw monitor.signal.reason || hubLeaseLostError(error)
      }
      await waitForTerminalRetry({
        signal: monitor.signal,
        delayMs: Math.max(1, Math.min(retryDelayMs, expiresAt - observedAt)),
        setTimeoutFn,
        clearTimeoutFn,
      })
    }
  }
}

/**
 * Hold one already-claimed Hub job lease. The monitor owns no queue state: it
 * only renews the exact owner/token proof and aborts the supplied controller
 * as soon as that proof can no longer be established.
 */
export function holdHubJobLease({
  job,
  ownerId,
  leaseMs = DEFAULT_HUB_LEASE_MS,
  controller = new AbortController(),
  renewJobLease,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const duration = hubLeaseDuration(leaseMs)
  const heartbeatMs = Math.max(1, Math.floor(duration / 3))
  const busyRetryMs = Math.max(25, Math.min(250, Math.floor(duration / 12)))
  const leaseToken = job?.leaseToken
  if (!ownerId || job?.leaseOwner !== ownerId || !hasLeaseToken(leaseToken)) {
    throw leaseProofError('claimed Hub job is missing its owner/token lease proof')
  }
  if (typeof renewJobLease !== 'function') {
    throw leaseProofError('Hub job lease renewal is unavailable')
  }

  let expiresAt = timestamp(job?.leaseExpiresAt)
  const startedAt = timestamp(now())
  if (startedAt === null || expiresAt === null || expiresAt <= startedAt) {
    throw leaseProofError('claimed Hub job has no active lease expiration')
  }

  let stopped = false
  let lost = false
  let heartbeatTimer = null
  let expiryTimer = null

  const clearTimer = (name) => {
    const timer = name === 'heartbeat' ? heartbeatTimer : expiryTimer
    if (timer !== null) clearTimeoutFn(timer)
    if (name === 'heartbeat') heartbeatTimer = null
    else expiryTimer = null
  }
  const clearTimers = () => {
    clearTimer('heartbeat')
    clearTimer('expiry')
  }
  const stopMonitoring = () => {
    if (stopped) return
    stopped = true
    clearTimers()
    controller.signal.removeEventListener('abort', onAbort)
  }
  const loseLease = (cause = null) => {
    if (lost || stopped) return
    lost = true
    clearTimers()
    if (!controller.signal.aborted) controller.abort(hubLeaseLostError(cause))
  }
  const observeNow = () => {
    const observedAt = timestamp(now())
    if (observedAt === null) {
      loseLease(leaseProofError('Hub lease clock returned an invalid timestamp'))
      return null
    }
    return observedAt
  }
  const scheduleExpiry = () => {
    clearTimer('expiry')
    if (stopped || controller.signal.aborted) return
    const observedAt = observeNow()
    if (observedAt === null) return
    const remaining = expiresAt - observedAt
    if (remaining <= 0) {
      loseLease()
      return
    }
    expiryTimer = setTimeoutFn(() => {
      expiryTimer = null
      if (stopped || controller.signal.aborted) return
      const current = observeNow()
      if (current === null) return
      if (current >= expiresAt) loseLease()
      else scheduleExpiry()
    }, remaining)
    expiryTimer?.unref?.()
  }
  const scheduleHeartbeat = (preferredDelay = heartbeatMs) => {
    clearTimer('heartbeat')
    if (stopped || controller.signal.aborted) return
    const scheduledAt = observeNow()
    if (scheduledAt === null) return
    const remaining = expiresAt - scheduledAt
    if (remaining <= 0) {
      loseLease()
      return
    }
    const delay = Math.max(
      1,
      Math.min(preferredDelay, Math.max(1, Math.floor(remaining / 2))),
    )
    heartbeatTimer = setTimeoutFn(() => {
      heartbeatTimer = null
      if (stopped || controller.signal.aborted) return
      const renewedAt = observeNow()
      if (renewedAt === null) return
      if (renewedAt >= expiresAt) {
        loseLease()
        return
      }
      let renewed
      try {
        renewed = renewJobLease(job.id, {
          ownerId,
          leaseToken,
          now,
          leaseMs: duration,
        })
      } catch (error) {
        if (isSqliteBusy(error)) {
          scheduleHeartbeat(busyRetryMs)
          return
        }
        loseLease(error)
        return
      }
      const completedAt = observeNow()
      if (completedAt === null) return
      if (completedAt >= expiresAt) {
        loseLease(leaseProofError('Hub lease renewal completed after the prior proof expired'))
        return
      }
      const renewedExpiry = timestamp(renewed?.leaseExpiresAt)
      if (
        renewed?.leaseOwner !== ownerId
        || renewed?.leaseToken !== leaseToken
        || renewedExpiry === null
        || renewedExpiry <= completedAt
      ) {
        loseLease(leaseProofError('Hub lease renewal returned an invalid proof'))
        return
      }
      expiresAt = renewedExpiry
      scheduleExpiry()
      scheduleHeartbeat()
    }, delay)
    heartbeatTimer?.unref?.()
  }
  const onAbort = () => stopMonitoring()

  controller.signal.addEventListener('abort', onAbort, { once: true })
  scheduleExpiry()
  scheduleHeartbeat()

  const lease = Object.freeze({
    ownerId,
    leaseToken,
    leaseMs: duration,
    get expiresAt() {
      return expiresAt
    },
  })

  return Object.freeze({
    signal: controller.signal,
    lease,
    get lost() {
      return lost
    },
    stop: stopMonitoring,
    abort(reason = hubRuntimeShutdownError()) {
      if (!controller.signal.aborted) controller.abort(reason)
      else stopMonitoring()
    },
  })
}

function abortedOutcome(job, signal) {
  return Object.freeze({
    status: 'aborted',
    job,
    error: signal.reason || hubLeaseLostError(),
  })
}

/** Execute a handler and fence every terminal queue mutation. */
export async function executeLeasedHubJob({
  job,
  handler,
  ownerId,
  leaseMs,
  renewJobLease,
  markDone,
  recordJobFailure,
  retryBackoffMs = null,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onActive = null,
  onInactive = null,
} = {}) {
  const controller = new AbortController()
  const monitor = holdHubJobLease({
    job,
    ownerId,
    leaseMs,
    controller,
    renewJobLease,
    now,
    setTimeoutFn,
    clearTimeoutFn,
  })
  const active = Object.freeze({
    job,
    signal: monitor.signal,
    lease: monitor.lease,
    stop: monitor.stop,
    abort: monitor.abort,
  })
  onActive?.(active)

  try {
    let result
    try {
      result = await handler(job, Object.freeze({
        signal: monitor.signal,
        lease: monitor.lease,
      }))
    } catch (error) {
      if (monitor.signal.aborted) return abortedOutcome(job, monitor.signal)
      try {
        const failedJob = await retryFencedTerminalWrite({
          monitor,
          leaseMs,
          now,
          setTimeoutFn,
          clearTimeoutFn,
          write: () => recordJobFailure(job.id, {
            ownerId,
            leaseToken: monitor.lease.leaseToken,
            retryable: true,
            backoffMs: retryBackoffMs == null
              ? hubRetryBackoffMs(job?.attemptCount)
              : Math.max(1, Math.floor(Number(retryBackoffMs)) || 1),
            errorMessage: error?.message || String(error),
            now,
          }),
        })
        return Object.freeze({ status: 'failed', job: failedJob, error })
      } catch (writeError) {
        if (monitor.signal.aborted || isFencingFailure(writeError)) {
          if (!monitor.signal.aborted) monitor.abort(hubLeaseLostError(writeError))
          return abortedOutcome(job, monitor.signal)
        }
        throw writeError
      }
    }

    if (monitor.signal.aborted) return abortedOutcome(job, monitor.signal)
    try {
      const doneJob = await retryFencedTerminalWrite({
        monitor,
        leaseMs,
        now,
        setTimeoutFn,
        clearTimeoutFn,
        write: () => markDone(job.id, {
          ownerId,
          leaseToken: monitor.lease.leaseToken,
          lastError: result == null ? null : String(result),
          now,
        }),
      })
      return Object.freeze({ status: 'done', job: doneJob, result })
    } catch (error) {
      if (monitor.signal.aborted || isFencingFailure(error)) {
        if (!monitor.signal.aborted) monitor.abort(hubLeaseLostError(error))
        return abortedOutcome(job, monitor.signal)
      }
      throw error
    }
  } finally {
    monitor.stop()
    onInactive?.(active)
  }
}

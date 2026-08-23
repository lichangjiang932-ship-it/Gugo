import crypto from 'node:crypto'
import {
  claimTurnExecutionLease,
  DEFAULT_TURN_EXECUTION_LEASE_MS,
  getTurnExecutionLease,
  hasActiveTurnExecutionLeaseForSession,
  isTurnExecutionLeaseActive,
  releaseTurnExecutionLease,
  renewTurnExecutionLease,
  requestTurnExecutionCancellation,
  tryCloseTurnSteeringInbox,
} from './turnExecutionLeaseStore.js'

function abortReason(code, message) {
  return Object.assign(new Error(message), { name: 'AbortError', code })
}

function scopeKey({ userId, sessionId, turnId } = {}) {
  return userId && sessionId && turnId
    ? `${userId}\u0000${sessionId}\u0000${turnId}`
    : null
}

const RENEWAL_WAIT_CANCELLED = Symbol('turn-lease-renewal-wait-cancelled')

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value))
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function createTurnExecutionLeaseCoordinator({
  ownerId = `turn-engine-${process.pid}-${crypto.randomUUID()}`,
  leaseMs = DEFAULT_TURN_EXECUTION_LEASE_MS,
  renewalTimeoutMs = null,
  claimLease = claimTurnExecutionLease,
  readLease = getTurnExecutionLease,
  renewLease = renewTurnExecutionLease,
  releaseLease = releaseTurnExecutionLease,
  isLeaseActive = isTurnExecutionLeaseActive,
  hasActiveSessionLease = hasActiveTurnExecutionLeaseForSession,
  requestCancellation = requestTurnExecutionCancellation,
  closeSteeringInbox = tryCloseTurnSteeringInbox,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const duration = Math.max(1_000, Number(leaseMs) || DEFAULT_TURN_EXECUTION_LEASE_MS)
  const heartbeatMs = Math.max(250, Math.floor(duration / 3))
  const renewalDeadlineMs = Math.min(
    duration - 1,
    positiveInteger(renewalTimeoutMs, Math.max(100, Math.floor(duration / 4))),
  )
  const proofs = new Map()

  const readProof = (scope) => {
    const key = scopeKey(scope)
    const proof = key ? proofs.get(key) : null
    return proof ? { ...proof } : null
  }

  const forgetProof = (scope, expected = null) => {
    const key = scopeKey(scope)
    if (!key) return
    const current = proofs.get(key)
    if (!expected || current?.fencingToken === expected.fencingToken) proofs.delete(key)
  }

  return {
    ownerId,
    async claim(scope) {
      const claimed = await claimLease({ ...scope, ownerId, leaseMs: duration })
      if (!claimed) {
        forgetProof(scope)
        return false
      }
      const lease = await readLease(scope)
      if (lease?.ownerId !== ownerId || !Number.isSafeInteger(lease?.fencingToken)) {
        forgetProof(scope)
        throw abortReason('TURN_LEASE_PROOF_UNAVAILABLE', 'Turn execution lease proof is unavailable')
      }
      const expiresAt = Number(lease.expiresAt)
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) {
        forgetProof(scope)
        throw abortReason('TURN_LEASE_PROOF_UNAVAILABLE', 'Turn execution lease expiry is unavailable')
      }
      proofs.set(scopeKey(scope), {
        ownerId,
        fencingToken: lease.fencingToken,
        expiresAt,
      })
      return true
    },
    proof(scope) {
      return readProof(scope)
    },
    isActive(scope) {
      return isLeaseActive(scope)
    },
    hasActiveSession(scope) {
      return hasActiveSessionLease(scope)
    },
    requestCancellation(scope) {
      return requestCancellation(scope)
    },
    closeSteeringInbox(scope) {
      const proof = readProof(scope)
      return closeSteeringInbox({ ...scope, ownerId, fencingToken: proof?.fencingToken })
    },
    hold(scope, controller) {
      let stopped = false
      let releasePromise = null
      let monitoringStopped = false
      let renewal = null
      let authoritativeProof = readProof(scope)
      let heartbeatTimer = null
      let expiryTimer = null
      let renewalDeadlineTimer = null
      let cancelRenewalWait = null

      const clearScheduledTimer = (name) => {
        const timer = name === 'heartbeat'
          ? heartbeatTimer
          : name === 'expiry'
            ? expiryTimer
            : renewalDeadlineTimer
        if (timer !== null) clearTimer(timer)
        if (name === 'heartbeat') heartbeatTimer = null
        else if (name === 'expiry') expiryTimer = null
        else renewalDeadlineTimer = null
      }
      const stopMonitoring = () => {
        if (monitoringStopped) return
        monitoringStopped = true
        clearScheduledTimer('heartbeat')
        clearScheduledTimer('expiry')
        clearScheduledTimer('renewal')
        cancelRenewalWait?.()
        cancelRenewalWait = null
      }
      const abortLease = (reason, { forget = true } = {}) => {
        if (stopped || controller?.signal?.aborted) {
          stopMonitoring()
          return
        }
        if (forget) forgetProof(scope, authoritativeProof)
        stopMonitoring()
        controller?.abort(reason)
      }
      const timer = (callback, delayMs) => {
        const handle = setTimer(callback, Math.max(0, Math.floor(delayMs)))
        handle?.unref?.()
        return handle
      }
      const scheduleExpiryWatchdog = () => {
        clearScheduledTimer('expiry')
        if (stopped || monitoringStopped || controller?.signal?.aborted) return
        const expiresAt = Number(authoritativeProof?.expiresAt)
        const remaining = expiresAt - now()
        if (!Number.isFinite(remaining) || remaining <= 0) {
          abortLease(abortReason('TURN_LEASE_LOST', 'Turn execution lease expired locally'))
          return
        }
        expiryTimer = timer(() => {
          expiryTimer = null
          if (stopped || monitoringStopped || controller?.signal?.aborted) return
          if (Number(authoritativeProof?.expiresAt) > now()) {
            scheduleExpiryWatchdog()
            return
          }
          abortLease(abortReason('TURN_LEASE_LOST', 'Turn execution lease expired locally'))
        }, remaining)
      }
      const waitForRenewalOperation = (operation, deadlineAt) => {
        let settleCancellation
        const cancellation = new Promise((resolve) => { settleCancellation = resolve })
        cancelRenewalWait = () => settleCancellation(RENEWAL_WAIT_CANCELLED)
        const operationPromise = Promise.resolve().then(operation)
        const remaining = Math.max(0, deadlineAt - now())
        const deadline = new Promise((_, reject) => {
          renewalDeadlineTimer = timer(() => {
            renewalDeadlineTimer = null
            reject(abortReason('TURN_LEASE_RENEWAL_TIMEOUT', 'Turn execution lease renewal timed out'))
          }, remaining)
        })
        return Promise.race([operationPromise, deadline, cancellation]).finally(() => {
          clearScheduledTimer('renewal')
          cancelRenewalWait = null
        })
      }
      const scheduleHeartbeat = (tick) => {
        clearScheduledTimer('heartbeat')
        if (stopped || monitoringStopped || controller?.signal?.aborted) return
        heartbeatTimer = timer(() => {
          heartbeatTimer = null
          tick()
        }, heartbeatMs)
      }
      const runRenewal = async () => {
        const renewalStartedAt = now()
        const deadlineAt = Math.min(
          renewalStartedAt + renewalDeadlineMs,
          Number(authoritativeProof?.expiresAt) || renewalStartedAt,
        )
        try {
          const state = await waitForRenewalOperation(() => renewLease({
            ...scope,
            ownerId,
            fencingToken: authoritativeProof?.fencingToken,
            leaseMs: duration,
          }), deadlineAt)
          if (state === RENEWAL_WAIT_CANCELLED || stopped || monitoringStopped) return
          if (!state?.renewed) {
            abortLease(abortReason('TURN_LEASE_LOST', 'Turn execution lease was lost'))
            return
          }
          if (state.cancelRequested) {
            abortLease(abortReason('TURN_CANCEL_REQUESTED', 'Cancelled by user'), { forget: false })
            return
          }
          const lease = await waitForRenewalOperation(() => readLease(scope), deadlineAt)
          if (lease === RENEWAL_WAIT_CANCELLED || stopped || monitoringStopped) return
          const expiresAt = Number(lease?.expiresAt)
          if (lease?.ownerId !== ownerId
            || lease?.fencingToken !== authoritativeProof?.fencingToken
            || !Number.isSafeInteger(expiresAt)
            || expiresAt <= now()) {
            abortLease(abortReason('TURN_LEASE_LOST', 'Renewed Turn execution lease proof is unavailable'))
            return
          }
          authoritativeProof = { ownerId, fencingToken: lease.fencingToken, expiresAt }
          proofs.set(scopeKey(scope), authoritativeProof)
          scheduleExpiryWatchdog()
        } catch {
          // Once ownership cannot be proven, continuing could duplicate side
          // effects on a different instance. Stop without writing a terminal
          // event so a later resume can recover from the last checkpoint.
          abortLease(abortReason('TURN_LEASE_LOST', 'Turn execution lease could not be renewed'))
        }
      }
      const tick = () => {
        if (stopped || monitoringStopped || controller?.signal?.aborted || renewal) return
        const currentRenewal = runRenewal()
        renewal = currentRenewal
        currentRenewal.finally(() => {
          if (renewal === currentRenewal) renewal = null
          scheduleHeartbeat(tick)
        })
      }

      const onAbort = () => stopMonitoring()
      controller?.signal?.addEventListener?.('abort', onAbort, { once: true })
      scheduleExpiryWatchdog()
      tick()
      return async () => {
        if (stopped) return false
        if (releasePromise) return await releasePromise
        stopMonitoring()
        controller?.signal?.removeEventListener?.('abort', onAbort)
        const proofAtRelease = authoritativeProof
        const attempt = (async () => {
          const result = await releaseLease({
            ...scope,
            ownerId,
            fencingToken: proofAtRelease?.fencingToken,
          })
          stopped = true
          forgetProof(scope, proofAtRelease)
          return result
        })()
        releasePromise = attempt
        try {
          return await attempt
        } finally {
          if (releasePromise === attempt) releasePromise = null
        }
      }
    },
  }
}

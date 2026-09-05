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
import { holdTurnExecutionLease } from './turnExecutionLeaseMonitor.js'

function abortReason(code, message) {
  return Object.assign(new Error(message), { name: 'AbortError', code })
}

function scopeKey({ userId, sessionId, turnId } = {}) {
  return userId && sessionId && turnId
    ? `${userId}\u0000${sessionId}\u0000${turnId}`
    : null
}

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
      return holdTurnExecutionLease({
        ownerId,
        duration,
        heartbeatMs,
        renewalDeadlineMs,
        proofs,
        scopeKey,
        readProof,
        forgetProof,
        renewLease,
        readLease,
        releaseLease,
        now,
        setTimer,
        clearTimer,
      }, scope, controller)
    },
  }
}

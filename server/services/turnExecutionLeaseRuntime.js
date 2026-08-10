import crypto from 'node:crypto'
import {
  claimTurnExecutionLease,
  DEFAULT_TURN_EXECUTION_LEASE_MS,
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

export function createTurnExecutionLeaseCoordinator({
  ownerId = `turn-engine-${process.pid}-${crypto.randomUUID()}`,
  leaseMs = DEFAULT_TURN_EXECUTION_LEASE_MS,
} = {}) {
  const duration = Math.max(1_000, Number(leaseMs) || DEFAULT_TURN_EXECUTION_LEASE_MS)
  const heartbeatMs = Math.max(250, Math.floor(duration / 3))

  return {
    ownerId,
    claim(scope) {
      return claimTurnExecutionLease({ ...scope, ownerId, leaseMs: duration })
    },
    isActive(scope) {
      return isTurnExecutionLeaseActive(scope)
    },
    hasActiveSession(scope) {
      return hasActiveTurnExecutionLeaseForSession(scope)
    },
    requestCancellation(scope) {
      return requestTurnExecutionCancellation(scope)
    },
    closeSteeringInbox(scope) {
      return tryCloseTurnSteeringInbox({ ...scope, ownerId })
    },
    hold(scope, controller) {
      let stopped = false
      const tick = () => {
        if (stopped || controller?.signal?.aborted) return
        try {
          const state = renewTurnExecutionLease({ ...scope, ownerId, leaseMs: duration })
          if (!state.renewed) {
            controller?.abort(abortReason('TURN_LEASE_LOST', 'Turn execution lease was lost'))
          } else if (state.cancelRequested) {
            controller?.abort(abortReason('TURN_CANCEL_REQUESTED', 'Cancelled by user'))
          }
        } catch {
          // Once ownership cannot be proven, continuing could duplicate side
          // effects on a different instance. Stop without writing a terminal
          // event so a later resume can recover from the last checkpoint.
          controller?.abort(abortReason('TURN_LEASE_LOST', 'Turn execution lease could not be renewed'))
        }
      }
      tick()
      const heartbeat = setInterval(tick, heartbeatMs)
      heartbeat.unref?.()
      return () => {
        if (stopped) return
        stopped = true
        clearInterval(heartbeat)
        releaseTurnExecutionLease({ ...scope, ownerId })
      }
    },
  }
}

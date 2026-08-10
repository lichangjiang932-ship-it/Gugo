import crypto from 'node:crypto'
import {
  claimJobExecutionLease,
  DEFAULT_JOB_EXECUTION_LEASE_MS,
  isJobExecutionLeaseActive,
  ownsJobExecutionLease,
  releaseJobExecutionLease,
  renewJobExecutionLease,
  runWithJobExecutionLease,
} from './jobExecutionLeaseStore.js'

function leaseLostError() {
  return Object.assign(new Error('Job execution lease was lost'), {
    name: 'AbortError',
    code: 'JOB_EXECUTION_LEASE_LOST',
  })
}

export function createJobExecutionLeaseCoordinator({
  ownerId = `job-runtime-${process.pid}-${crypto.randomUUID()}`,
  leaseMs = DEFAULT_JOB_EXECUTION_LEASE_MS,
} = {}) {
  const duration = Math.max(1_000, Number(leaseMs) || DEFAULT_JOB_EXECUTION_LEASE_MS)
  return {
    ownerId,
    claim(jobId) {
      return claimJobExecutionLease({ jobId, ownerId, leaseMs: duration })
    },
    isActive(jobId) {
      return isJobExecutionLeaseActive({ jobId })
    },
    owns(jobId) {
      return ownsJobExecutionLease({ jobId, ownerId })
    },
    runIfOwned(jobId, callback) {
      return runWithJobExecutionLease({ jobId, ownerId }, callback)
    },
    hold(jobId, controller) {
      let stopped = false
      const tick = () => {
        if (stopped || controller?.signal?.aborted) return
        try {
          if (!renewJobExecutionLease({ jobId, ownerId, leaseMs: duration })) {
            controller?.abort(leaseLostError())
          }
        } catch {
          controller?.abort(leaseLostError())
        }
      }
      const heartbeat = setInterval(tick, Math.max(250, Math.floor(duration / 3)))
      heartbeat.unref?.()
      return () => {
        if (stopped) return
        stopped = true
        clearInterval(heartbeat)
        releaseJobExecutionLease({ jobId, ownerId })
      }
    },
  }
}

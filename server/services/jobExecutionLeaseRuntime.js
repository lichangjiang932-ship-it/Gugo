import crypto from 'node:crypto'
import {
  claimJobExecutionLease,
  DEFAULT_JOB_EXECUTION_LEASE_MS,
  releaseJobExecutionLease,
  renewJobExecutionLease,
} from './jobExecutionLeaseStore.js'

export function createJobExecutionLeaseCoordinator({
  ownerId = `job-runtime-${process.pid}-${crypto.randomUUID()}`,
  leaseMs = DEFAULT_JOB_EXECUTION_LEASE_MS,
} = {}) {
  const duration = Math.max(1_000, Number(leaseMs) || DEFAULT_JOB_EXECUTION_LEASE_MS)
  return {
    claim(jobId) {
      return claimJobExecutionLease({ jobId, ownerId, leaseMs: duration })
    },
    hold(jobId) {
      const heartbeat = setInterval(() => {
        renewJobExecutionLease({ jobId, ownerId, leaseMs: duration })
      }, Math.max(500, Math.floor(duration / 3)))
      heartbeat.unref?.()
      return () => {
        clearInterval(heartbeat)
        releaseJobExecutionLease({ jobId, ownerId })
      }
    },
  }
}

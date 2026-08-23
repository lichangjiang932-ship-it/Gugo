import { performance } from 'node:perf_hooks'

import {
  DEFAULT_EVOLUTION_OPERATION_LEASE_MS,
  evolutionOperationLeaseDuration,
  renewEvolutionOperationLease,
} from './evolutionOperationService.js'

function leaseLostError() {
  return Object.assign(new Error('Evolution operation lease was lost'), {
    name: 'AbortError',
    code: 'EVOLUTION_OPERATION_LEASE_LOST',
    statusCode: 409,
  })
}

function leaseRuntimeInputError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 400 })
}

function clockTimestamp(value) {
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null
}

function monotonicClockNow() {
  return performance.now()
}

function monotonicTimestamp(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null
}

function isRetryableRenewalError(error) {
  const code = String(error?.code || '')
  return code.startsWith('SQLITE_BUSY') || code === 'EVOLUTION_OPERATION_IN_PROGRESS'
}

export function holdEvolutionOperationLease({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  leaseExpiresAt,
  leaseMs = DEFAULT_EVOLUTION_OPERATION_LEASE_MS,
  signal,
  now = Date.now,
  monotonicNow = monotonicClockNow,
  renewLease = renewEvolutionOperationLease,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const duration = evolutionOperationLeaseDuration(leaseMs)
  const heartbeatDelay = Math.max(250, Math.floor(duration / 3))
  const retryDelay = Math.max(25, Math.min(250, Math.floor(duration / 12)))
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener?.('abort', forwardAbort, { once: true })

  let stopped = false
  let timer = null
  const startedAt = clockTimestamp(now())
  if (startedAt === null) {
    throw leaseRuntimeInputError(
      'EVOLUTION_TIMESTAMP_INVALID',
      'lease clock must return a non-negative safe integer',
    )
  }
  const suppliedLeaseDeadline = leaseExpiresAt == null ? null : clockTimestamp(leaseExpiresAt)
  if (leaseExpiresAt != null && suppliedLeaseDeadline === null) {
    throw leaseRuntimeInputError(
      'EVOLUTION_OPERATION_LEASE_EXPIRATION_INVALID',
      'leaseExpiresAt must be a non-negative safe integer',
    )
  }
  const fallbackLeaseDeadline = startedAt + duration
  if (!Number.isSafeInteger(fallbackLeaseDeadline)) {
    throw leaseRuntimeInputError(
      'EVOLUTION_OPERATION_LEASE_EXPIRATION_INVALID',
      'lease duration would produce an invalid local deadline',
    )
  }
  const monotonicStartedAt = monotonicTimestamp(monotonicNow())
  if (monotonicStartedAt === null) {
    throw leaseRuntimeInputError(
      'EVOLUTION_OPERATION_MONOTONIC_CLOCK_INVALID',
      'monotonic lease clock must return a finite non-negative number',
    )
  }
  const wallLeaseDeadline = suppliedLeaseDeadline ?? fallbackLeaseDeadline
  const initialRemaining = Math.max(0, Math.min(duration, wallLeaseDeadline - startedAt))
  let localLeaseDeadline = monotonicStartedAt + initialRemaining
  let lastObservedAt = startedAt
  let lastMonotonicObservedAt = monotonicStartedAt

  const abortLease = (reason = leaseLostError()) => {
    if (timer !== null) {
      clearTimeoutFn(timer)
      timer = null
    }
    if (!controller.signal.aborted) controller.abort(reason)
  }

  const observeClocks = () => {
    const observedAt = clockTimestamp(now())
    const monotonicObservedAt = monotonicTimestamp(monotonicNow())
    if (
      observedAt === null
      || observedAt < lastObservedAt
      || monotonicObservedAt === null
      || monotonicObservedAt < lastMonotonicObservedAt
    ) return null
    lastObservedAt = observedAt
    lastMonotonicObservedAt = monotonicObservedAt
    return { observedAt, monotonicObservedAt }
  }

  const schedule = (preferredDelay) => {
    if (stopped || controller.signal.aborted) return
    const observed = observeClocks()
    if (observed === null) {
      abortLease()
      return
    }
    const remaining = localLeaseDeadline - observed.monotonicObservedAt
    if (remaining <= 0) {
      abortLease()
      return
    }
    const delay = Math.max(1, Math.min(preferredDelay, Math.max(1, Math.floor(remaining / 2))))
    timer = setTimeoutFn(tick, delay)
    timer?.unref?.()
  }

  const tick = () => {
    timer = null
    if (stopped || controller.signal.aborted) return
    const attempted = observeClocks()
    if (attempted === null) {
      abortLease()
      return
    }
    if (attempted.monotonicObservedAt >= localLeaseDeadline) {
      abortLease()
      return
    }
    try {
      const renewed = renewLease({
        userId,
        id,
        workerToken,
        leaseOwnerId,
        leaseMs: duration,
        now: attempted.observedAt,
        monotonicNow,
      })
      if (!renewed) {
        abortLease()
        return
      }
      const renewedAt = observeClocks()
      if (renewedAt === null) {
        abortLease()
        return
      }
      localLeaseDeadline = renewedAt.monotonicObservedAt + duration
      schedule(heartbeatDelay)
    } catch (error) {
      if (!isRetryableRenewalError(error)) {
        abortLease(error)
        return
      }
      schedule(retryDelay)
    }
  }
  schedule(heartbeatDelay)

  return {
    signal: controller.signal,
    stop() {
      if (stopped) return
      stopped = true
      if (timer !== null) clearTimeoutFn(timer)
      timer = null
      signal?.removeEventListener?.('abort', forwardAbort)
    },
  }
}

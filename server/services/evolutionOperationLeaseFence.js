import { performance } from 'node:perf_hooks'

import { operationError } from './evolutionOperationShared.js'

const LOCAL_LEASE_TOMBSTONE_RETENTION_MS = 24 * 60 * 60_000
const MAX_LOCAL_LEASE_TOMBSTONES = 4_096
const localLeaseFences = new Map()
let localLeaseSweepIterator = null

export function monotonicClockNow() {
  return performance.now()
}

export function monotonicTimestamp(source) {
  const timestamp = Number(typeof source === 'function' ? source() : source)
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw operationError(
      'EVOLUTION_OPERATION_MONOTONIC_CLOCK_INVALID',
      'monotonic clock must return a finite non-negative number',
    )
  }
  return timestamp
}

export function monotonicLeaseDeadline(startedAt, duration) {
  const deadline = startedAt + duration
  if (!Number.isFinite(deadline)) {
    throw operationError(
      'EVOLUTION_OPERATION_MONOTONIC_CLOCK_INVALID',
      'monotonic lease deadline is invalid',
    )
  }
  return deadline
}

function localLeaseFenceKey({ userId, id, workerToken, leaseOwnerId }) {
  return JSON.stringify([userId, id, workerToken, leaseOwnerId])
}

function pruneLocalLeaseTombstones(now = performance.now()) {
  const tombstones = []
  for (const [key, fence] of localLeaseFences) {
    if (!fence.lost) continue
    if (now - fence.lostAt >= LOCAL_LEASE_TOMBSTONE_RETENTION_MS) {
      localLeaseFences.delete(key)
      continue
    }
    tombstones.push([key, fence.lostAt])
  }
  if (tombstones.length <= MAX_LOCAL_LEASE_TOMBSTONES) return
  tombstones
    .sort((left, right) => left[1] - right[1])
    .slice(0, tombstones.length - MAX_LOCAL_LEASE_TOMBSTONES)
    .forEach(([key]) => localLeaseFences.delete(key))
}

function tombstoneLocalLeaseFence(fence) {
  if (!fence.lost) {
    fence.lost = true
    fence.lostAt = performance.now()
  }
  pruneLocalLeaseTombstones()
}

export function registerLocalLeaseFence({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  duration,
  startedAt,
}) {
  const deadline = monotonicLeaseDeadline(startedAt, duration)
  pruneLocalLeaseTombstones()
  localLeaseFences.set(localLeaseFenceKey({ userId, id, workerToken, leaseOwnerId }), {
    userId,
    id,
    workerToken,
    leaseOwnerId,
    deadline,
    lastObservedAt: startedAt,
    lost: false,
    lostAt: null,
  })
}

export function observeLocalLeaseFence({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  monotonicNow,
}) {
  const key = localLeaseFenceKey({ userId, id, workerToken, leaseOwnerId })
  const fence = localLeaseFences.get(key)
  if (!fence) return { status: 'missing', key, fence: null, observedAt: null }
  if (fence.lost) return { status: 'lost', key, fence, observedAt: null }
  const observedAt = monotonicTimestamp(monotonicNow)
  if (observedAt < fence.lastObservedAt || observedAt >= fence.deadline) {
    return { status: 'lost', key, fence, observedAt }
  }
  return { status: 'live', key, fence, observedAt }
}

export function applyLocalLeaseFenceObservation(observation) {
  pruneLocalLeaseTombstones()
  if (!observation?.fence) return false
  const fence = localLeaseFences.get(observation.key)
  if (fence !== observation.fence || fence.lost) return false
  if (
    observation.status !== 'live'
    || observation.observedAt < fence.lastObservedAt
    || observation.observedAt >= fence.deadline
  ) {
    tombstoneLocalLeaseFence(fence)
    return false
  }
  fence.lastObservedAt = observation.observedAt
  return true
}

export function extendLocalLeaseFence(observation, duration) {
  if (!applyLocalLeaseFenceObservation(observation)) return false
  const deadline = observation.observedAt + duration
  if (!Number.isFinite(deadline)) {
    tombstoneLocalLeaseFence(observation.fence)
    return false
  }
  observation.fence.deadline = deadline
  observation.fence.lastObservedAt = observation.observedAt
  return true
}

export function markLocalLeaseFenceLost(input) {
  const fence = localLeaseFences.get(localLeaseFenceKey(input))
  if (fence) tombstoneLocalLeaseFence(fence)
}

export function releaseLocalLeaseFence(input) {
  localLeaseFences.delete(localLeaseFenceKey(input))
}

export function releaseLocalLeaseFencesForOperation({ userId, id }) {
  for (const [key, fence] of localLeaseFences) {
    if (fence.userId === userId && fence.id === id) localLeaseFences.delete(key)
  }
}

export function takeLocalLeaseFenceCandidates(limit) {
  if (limit <= 0 || localLeaseFences.size === 0) return []
  const candidates = []
  let inspected = 0
  let restarted = false
  while (inspected < limit) {
    localLeaseSweepIterator ||= localLeaseFences.values()
    const next = localLeaseSweepIterator.next()
    if (next.done) {
      localLeaseSweepIterator = null
      if (inspected === 0 && !restarted) {
        restarted = true
        continue
      }
      break
    }
    inspected += 1
    if (next.value) candidates.push(next.value)
  }
  return candidates
}

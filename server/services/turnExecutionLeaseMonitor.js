const RENEWAL_WAIT_CANCELLED = Symbol('turn-lease-renewal-wait-cancelled')

function abortReason(code, message) {
  return Object.assign(new Error(message), { name: 'AbortError', code })
}

function clearMonitorTimer(monitor, name) {
  const timer = monitor.timers[name]
  if (timer !== null) monitor.runtime.clearTimer(timer)
  monitor.timers[name] = null
}

function stopLeaseMonitoring(monitor) {
  if (monitor.monitoringStopped) return
  monitor.monitoringStopped = true
  clearMonitorTimer(monitor, 'heartbeat')
  clearMonitorTimer(monitor, 'expiry')
  clearMonitorTimer(monitor, 'renewal')
  monitor.cancelRenewalWait?.()
  monitor.cancelRenewalWait = null
}

function forgetCurrentProof(monitor) {
  monitor.runtime.forgetProof(monitor.scope, monitor.authoritativeProof)
}

function abortLease(monitor, reason, { forget = true } = {}) {
  if (monitor.stopped || monitor.controller?.signal?.aborted) {
    stopLeaseMonitoring(monitor)
    return
  }
  if (forget) forgetCurrentProof(monitor)
  stopLeaseMonitoring(monitor)
  monitor.controller?.abort(reason)
}

function scheduleTimer(monitor, name, callback, delayMs) {
  const handle = monitor.runtime.setTimer(callback, Math.max(0, Math.floor(delayMs)))
  monitor.timers[name] = handle
  handle?.unref?.()
  return handle
}

function observeNow(monitor) {
  const observedAt = Number(monitor.runtime.now())
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    abortLease(monitor, abortReason('TURN_LEASE_LOST', 'Turn lease clock returned an invalid timestamp'))
    return null
  }
  return observedAt
}

function scheduleExpiryWatchdog(monitor) {
  clearMonitorTimer(monitor, 'expiry')
  if (monitor.stopped || monitor.monitoringStopped || monitor.controller?.signal?.aborted) return
  const observedAt = observeNow(monitor)
  if (observedAt === null) return
  const remaining = Number(monitor.authoritativeProof?.expiresAt) - observedAt
  if (!Number.isFinite(remaining) || remaining <= 0) {
    abortLease(monitor, abortReason('TURN_LEASE_LOST', 'Turn execution lease expired locally'))
    return
  }
  scheduleTimer(monitor, 'expiry', () => {
    monitor.timers.expiry = null
    if (monitor.stopped || monitor.monitoringStopped || monitor.controller?.signal?.aborted) return
    const current = observeNow(monitor)
    if (current === null) return
    if (Number(monitor.authoritativeProof?.expiresAt) > current) scheduleExpiryWatchdog(monitor)
    else abortLease(monitor, abortReason('TURN_LEASE_LOST', 'Turn execution lease expired locally'))
  }, remaining)
}

function waitForRenewalOperation(monitor, operation, deadlineAt) {
  let settleCancellation
  const cancellation = new Promise((resolve) => { settleCancellation = resolve })
  monitor.cancelRenewalWait = () => settleCancellation(RENEWAL_WAIT_CANCELLED)
  const operationPromise = Promise.resolve().then(operation)
  const remaining = Math.max(0, deadlineAt - monitor.runtime.now())
  const deadline = new Promise((_, reject) => {
    scheduleTimer(monitor, 'renewal', () => {
      monitor.timers.renewal = null
      reject(abortReason('TURN_LEASE_RENEWAL_TIMEOUT', 'Turn execution lease renewal timed out'))
    }, remaining)
  })
  return Promise.race([operationPromise, deadline, cancellation]).finally(() => {
    clearMonitorTimer(monitor, 'renewal')
    monitor.cancelRenewalWait = null
  })
}

function scheduleHeartbeat(monitor, preferredDelay = monitor.runtime.heartbeatMs) {
  clearMonitorTimer(monitor, 'heartbeat')
  if (monitor.stopped || monitor.monitoringStopped || monitor.controller?.signal?.aborted) return
  const scheduledAt = observeNow(monitor)
  if (scheduledAt === null) return
  const remaining = Number(monitor.authoritativeProof?.expiresAt) - scheduledAt
  if (remaining <= 0) {
    abortLease(monitor, abortReason('TURN_LEASE_LOST', 'Turn execution lease expired locally'))
    return
  }
  const delay = Math.max(1, Math.min(preferredDelay, Math.max(1, Math.floor(remaining / 2))))
  scheduleTimer(monitor, 'heartbeat', () => {
    monitor.timers.heartbeat = null
    renewalTick(monitor)
  }, delay)
}

async function runRenewal(monitor) {
  const startedAt = monitor.runtime.now()
  const deadlineAt = Math.min(
    startedAt + monitor.runtime.renewalDeadlineMs,
    Number(monitor.authoritativeProof?.expiresAt) || startedAt,
  )
  try {
    const state = await waitForRenewalOperation(monitor, () => monitor.runtime.renewLease({
      ...monitor.scope,
      ownerId: monitor.runtime.ownerId,
      fencingToken: monitor.authoritativeProof?.fencingToken,
      leaseMs: monitor.runtime.duration,
    }), deadlineAt)
    if (state === RENEWAL_WAIT_CANCELLED || monitor.stopped || monitor.monitoringStopped) return
    if (!state?.renewed) {
      abortLease(monitor, abortReason('TURN_LEASE_LOST', 'Turn execution lease was lost'))
      return
    }
    if (state.cancelRequested) {
      abortLease(monitor, abortReason('TURN_CANCEL_REQUESTED', 'Cancelled by user'), { forget: false })
      return
    }
    const lease = await waitForRenewalOperation(
      monitor,
      () => monitor.runtime.readLease(monitor.scope),
      deadlineAt,
    )
    if (lease === RENEWAL_WAIT_CANCELLED || monitor.stopped || monitor.monitoringStopped) return
    const expiresAt = Number(lease?.expiresAt)
    if (lease?.ownerId !== monitor.runtime.ownerId
      || lease?.fencingToken !== monitor.authoritativeProof?.fencingToken
      || !Number.isSafeInteger(expiresAt)
      || expiresAt <= monitor.runtime.now()) {
      abortLease(monitor, abortReason('TURN_LEASE_LOST', 'Renewed Turn execution lease proof is unavailable'))
      return
    }
    monitor.authoritativeProof = {
      ownerId: monitor.runtime.ownerId,
      fencingToken: lease.fencingToken,
      expiresAt,
    }
    monitor.runtime.proofs.set(monitor.runtime.scopeKey(monitor.scope), monitor.authoritativeProof)
    scheduleExpiryWatchdog(monitor)
  } catch {
    abortLease(monitor, abortReason('TURN_LEASE_LOST', 'Turn execution lease could not be renewed'))
  }
}

function renewalTick(monitor) {
  if (monitor.stopped || monitor.monitoringStopped
    || monitor.controller?.signal?.aborted || monitor.renewal) return
  const currentRenewal = runRenewal(monitor)
  monitor.renewal = currentRenewal
  currentRenewal.finally(() => {
    if (monitor.renewal === currentRenewal) monitor.renewal = null
    scheduleHeartbeat(monitor)
  })
}

async function releaseHeldLease(monitor) {
  if (monitor.stopped) return false
  if (monitor.releasePromise) return monitor.releasePromise
  stopLeaseMonitoring(monitor)
  monitor.controller?.signal?.removeEventListener?.('abort', monitor.onAbort)
  const proofAtRelease = monitor.authoritativeProof
  const attempt = (async () => {
    const result = await monitor.runtime.releaseLease({
      ...monitor.scope,
      ownerId: monitor.runtime.ownerId,
      fencingToken: proofAtRelease?.fencingToken,
    })
    monitor.stopped = true
    monitor.runtime.forgetProof(monitor.scope, proofAtRelease)
    return result
  })()
  monitor.releasePromise = attempt
  try { return await attempt }
  finally { if (monitor.releasePromise === attempt) monitor.releasePromise = null }
}

export function holdTurnExecutionLease(runtime, scope, controller) {
  const monitor = {
    runtime,
    scope,
    controller,
    stopped: false,
    releasePromise: null,
    monitoringStopped: false,
    renewal: null,
    authoritativeProof: runtime.readProof(scope),
    timers: { heartbeat: null, expiry: null, renewal: null },
    cancelRenewalWait: null,
    onAbort: null,
  }
  monitor.onAbort = () => stopLeaseMonitoring(monitor)
  controller?.signal?.addEventListener?.('abort', monitor.onAbort, { once: true })
  scheduleExpiryWatchdog(monitor)
  renewalTick(monitor)
  return () => releaseHeldLease(monitor)
}

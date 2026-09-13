import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  getSideEffectTurnInteractionApi,
  resolveSideEffectTurnInteractionApi,
  safeSideEffectResumeDescriptor,
} from '../../../../lib/sideEffectRecoveryClient.js'
import { isSideEffectOutcomeUnknownRecoveryKind } from '../../../../lib/turnClient/turnEventDispatch.js'

function exactId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.trim()
}

function matchingRecord(record, scope, status) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && record.scopeKind === 'turn' && record.status === status
    && record.scopeKey === JSON.stringify(['turn', scope.sessionId, scope.turnId])
    && record.sessionId === scope.sessionId && record.turnId === scope.turnId
    && record.toolCallId === scope.toolCallId && /^[a-f0-9]{64}$/u.test(record.argsDigest || '')
}

function isCurrent(active, run) {
  return run.alive && active.current === run
}

function confirmedInteraction(result, scope) {
  const resolution = result.record?.status
  const confirmation = result.confirmation
  if (!['committed', 'failed'].includes(resolution)
    || !matchingRecord(result.record, scope, resolution)
    || !confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)
    || confirmation.resolution !== resolution
    || !Number.isSafeInteger(confirmation.confirmedAt) || confirmation.confirmedAt < 0) return null
  const resume = safeSideEffectResumeDescriptor(result.record, result.resume)
  return resume ? { record: Object.freeze({ ...result.record }), resume } : null
}

async function loadCurrentInteraction({ active, run, scope, loadInteraction, setStored }) {
  if (!isCurrent(active, run) || run.posting || run.load || run.deferred || run.resolved) return
  run.receipt = null
  if (!scope.valid) {
    setStored({ key: scope.key, phase: 'unavailable', record: null })
    return
  }
  const controller = new AbortController()
  run.load = controller
  setStored({ key: scope.key, phase: 'loading', record: null })
  try {
    const result = await loadInteraction({
      sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: scope.toolCallId,
      signal: controller.signal,
    })
    if (!isCurrent(active, run) || controller.signal.aborted || run.load !== controller) return
    if (!result?.record || !result?.boundary) {
      setStored({ key: scope.key, phase: 'unavailable', record: null })
      return
    }
    const boundary = result.boundary
    if (typeof boundary !== 'object' || Array.isArray(boundary)
      || boundary.type !== 'turn.blocked'
      || !exactId(boundary.id) || !Number.isSafeInteger(boundary.sequence) || boundary.sequence < 0) {
      throw new Error('Invalid scoped recovery response')
    }
    const confirmed = confirmedInteraction(result, scope)
    if (confirmed) {
      run.resolved = confirmed
      setStored({ key: scope.key, phase: 'resolved', record: confirmed.record,
        resolution: confirmed.record.status, resumeRequested: false })
      return
    }
    if (!matchingRecord(result.record, scope, 'unknown')) throw new Error('Invalid scoped recovery response')
    run.receipt = {
      record: Object.freeze({ ...result.record }), boundary: Object.freeze({ ...boundary }),
    }
    setStored({ key: scope.key, phase: 'ready', record: run.receipt.record })
  } catch {
    if (isCurrent(active, run) && !controller.signal.aborted) {
      setStored({ key: scope.key, phase: 'error', error: 'inlineLoadFailed', record: null })
    }
  } finally {
    if (run.load === controller) run.load = null
  }
}

async function continueResolvedInteraction({ active, run, scope, onResolved, msg, setStored }) {
  if (!isCurrent(active, run) || !run.resolved || run.resuming || run.resumeRequested) return false
  run.resuming = true
  let accepted = false
  try {
    accepted = typeof onResolved === 'function' && await onResolved({
      ...run.resolved, message: msg, ownerScope: scope.ownerScope,
    }) !== false
  } catch { /* the decision is already saved; never submit its CAS again */ }
  finally { run.resuming = false }
  if (!isCurrent(active, run)) return false
  run.resumeRequested = accepted
  setStored({ key: scope.key, phase: 'resolved', record: run.resolved.record,
    resolution: run.resolved.record.status, resumeRequested: accepted,
    error: accepted ? '' : 'inlineResumePending' })
  return accepted
}

async function confirmCurrentInteraction({ active, run, scope, resolution, resolveInteraction, onResolved, msg, setStored }) {
  if (!isCurrent(active, run) || run.posting || !run.receipt || !['committed', 'failed'].includes(resolution)) return
  const receipt = run.receipt
  // Revoke the actionable snapshot synchronously, before the first await.
  // A second click, deferred fetch or failed transport cannot reuse this CAS.
  run.receipt = null
  run.posting = true
  const controller = new AbortController()
  run.submit = controller
  setStored({ key: scope.key, phase: 'resolving', record: receipt.record, resolution })
  try {
    const result = await resolveInteraction({
      record: receipt.record, boundary: receipt.boundary, resolution,
      verificationConfirmed: true, confirmToolCallId: receipt.record.toolCallId,
      signal: controller.signal,
    })
    if (!isCurrent(active, run) || controller.signal.aborted) return
    const resume = safeSideEffectResumeDescriptor(receipt.record, result?.resume)
    if (!matchingRecord(result?.record, scope, resolution)
      || result.record.argsDigest !== receipt.record.argsDigest || !resume) {
      throw new Error('Invalid scoped recovery confirmation')
    }
    run.resolved = { record: result.record, resume }
    await continueResolvedInteraction({ active, run, scope, onResolved, msg, setStored })
  } catch (error) {
    if (isCurrent(active, run) && !controller.signal.aborted) {
      setStored({ key: scope.key, phase: 'error', record: receipt.record,
        error: [404, 409].includes(error?.status ?? error?.statusCode) ? 'inlineStale' : 'inlineResolveFailed' })
    }
  } finally {
    run.posting = false
    if (run.submit === controller) run.submit = null
  }
}

export default function useInlineSideEffectRecovery({
  sessionId, msg, ownerScope, onResolved,
  loadInteraction = getSideEffectTurnInteractionApi,
  resolveInteraction = resolveSideEffectTurnInteractionApi,
}) {
  const turnId = msg?.meta?.serverTurnId
  const toolCallId = msg?.meta?.serverRecoveryToolCallId
  const sequence = msg?.meta?.serverLastSequence ?? null
  const blocked = msg?.role === 'assistant' && msg.meta?.serverRecoveryBlocked === true
    && msg.meta?.serverConnectionState === 'blocked' && msg.meta?.cancelled !== true
    && isSideEffectOutcomeUnknownRecoveryKind(msg.meta?.serverRecoveryKind)
  const scope = useMemo(() => ({
    ownerScope, sessionId, turnId, toolCallId,
    key: JSON.stringify([ownerScope, sessionId, turnId, toolCallId, sequence, blocked]),
    valid: blocked && typeof ownerScope === 'string' && ownerScope.length > 0
      && [sessionId, turnId, toolCallId].every(exactId),
  }), [ownerScope, sessionId, turnId, toolCallId, sequence, blocked])
  const [stored, setStored] = useState({ key: scope.key, phase: 'loading', record: null })
  const active = useRef(null)
  useLayoutEffect(() => {
    const run = { alive: true, key: scope.key, receipt: null, load: null, submit: null, posting: false }
    active.current = run
    Promise.resolve().then(() => loadCurrentInteraction({ active, run, scope, loadInteraction, setStored }))
    return () => {
      run.alive = false
      run.receipt = null
      run.load?.abort()
      run.submit?.abort()
      if (active.current === run) active.current = null
    }
  }, [scope, loadInteraction])
  const refresh = useCallback(() => {
    const run = active.current
    if (run?.key !== scope.key) return
    run.deferred = false
    return loadCurrentInteraction({ active, run, scope, loadInteraction, setStored })
  }, [scope, loadInteraction])
  const defer = useCallback(() => {
    const run = active.current
    if (run?.key !== scope.key || run.posting || run.resolved) return
    run.deferred = true
    run.load?.abort()
    run.load = null
    run.receipt = null
    setStored({ key: scope.key, phase: 'deferred', record: null })
  }, [scope])
  const confirm = useCallback((resolution) => {
    const run = active.current
    if (run?.key === scope.key) return confirmCurrentInteraction({
      active, run, scope, resolution, resolveInteraction, onResolved, msg, setStored,
    })
  }, [scope, resolveInteraction, onResolved, msg])
  const resume = useCallback(() => {
    const run = active.current
    if (run?.key === scope.key) return continueResolvedInteraction({ active, run, scope, onResolved, msg, setStored })
  }, [scope, onResolved, msg])
  return {
    ...(stored.key === scope.key ? stored : { phase: 'loading', record: null }),
    canRefresh: scope.valid, confirm, defer, refresh, resume,
  }
}

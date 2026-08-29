import { useCallback, useEffect, useRef, useState } from 'react'
import {
  decideApproval as decideApprovalApi,
  fetchApprovalSettings,
  isPermissionModeWidening,
  updateApprovalSettings,
} from '../../lib/approvalClient.js'
import { createApprovalEpochGuard, createApprovalOwnerGuard } from './approvalOwnerGuard.js'

function approvalPresentationClosedError() {
  const error = new Error('Approval view closed before a decision was submitted.')
  error.name = 'AbortError'
  error.code = 'APPROVAL_PRESENTATION_CLOSED'
  error.localTurnConsumerAbort = true
  return error
}

export default function useChatApprovals({ setWorkbenchMessage, toast, t }) {
  const [toolApproval, setToolApproval] = useState({ open: false, request: null, busy: false })
  const [approvalSettings, setApprovalSettings] = useState({ mode: 'normal', rememberedTools: [] })
  const toolApprovalResolveRef = useRef(null)
  const activeApprovalRef = useRef(null)
  const mountedRef = useRef(true)
  const ownerGuardRef = useRef(createApprovalOwnerGuard())
  const epochGuardRef = useRef(createApprovalEpochGuard())

  const resolveToolApproval = useCallback((decision) => {
    const resolve = toolApprovalResolveRef.current
    if (typeof resolve !== 'function') return false
    const resolutionEpoch = epochGuardRef.current.current()
    toolApprovalResolveRef.current = null
    ownerGuardRef.current.clear()
    setToolApproval((current) => ({ ...current, busy: true }))
    const close = () => {
      if (!epochGuardRef.current.isCurrent(resolutionEpoch) || toolApprovalResolveRef.current) return
      setToolApproval({ open: false, request: null, busy: false })
    }
    Promise.resolve(resolve?.(decision)).catch((error) => {
      setWorkbenchMessage(error?.message || 'Approval failed.')
    }).finally(close)
    return true
  }, [setWorkbenchMessage])

  const presentServerToolApproval = useCallback((request, owner) => {
    // Closing the chat page is not a user denial. Keep the persisted approval
    // pending so the same turn can surface it again when the page reconnects.
    // The local event dispatcher must still be released deterministically;
    // resolving here would falsely claim a decision, while leaving the Promise
    // pending would keep the session registered as running forever.
    if (!mountedRef.current) return Promise.reject(approvalPresentationClosedError())
    let approvalPromise
    let rejectApproval
    approvalPromise = new Promise((resolve, reject) => {
      rejectApproval = reject
      epochGuardRef.current.advance()
      ownerGuardRef.current.claim(owner)
      toolApprovalResolveRef.current = async (decision) => {
        try {
          await decideApprovalApi(request.id, decision?.approved ? 'approve' : 'deny', null, { remember: !!decision?.remember })
          resolve()
        } catch (error) {
          reject(error)
        } finally {
          if (activeApprovalRef.current?.promise === approvalPromise) activeApprovalRef.current = null
        }
      }
      setToolApproval({ open: true, request, busy: false })
    })
    activeApprovalRef.current = {
      id: request.id,
      promise: approvalPromise,
      reject: rejectApproval,
    }
    return approvalPromise
  }, [])

  const requestServerToolApproval = useCallback((request, owner) => {
    // approval.required is durable and may be delivered again after an SSE
    // reconnect. Reusing the in-flight promise is essential: replacing it used
    // to submit `deny` for an approval the user had never rejected.
    const active = activeApprovalRef.current
    if (active?.id === request.id) return active.promise
    if (active) {
      return active.promise.then(
        () => presentServerToolApproval(request, owner),
        () => presentServerToolApproval(request, owner),
      )
    }
    return presentServerToolApproval(request, owner)
  }, [presentServerToolApproval])

  const resolveToolApprovalForOwner = useCallback((owner, decision) => {
    if (!ownerGuardRef.current.matches(owner)) return false
    resolveToolApproval(decision)
    return true
  }, [resolveToolApproval])

  const clearToolApprovalForOwner = useCallback((owner) => {
    if (!ownerGuardRef.current.release(owner)) return false
    epochGuardRef.current.advance()
    const active = activeApprovalRef.current
    toolApprovalResolveRef.current = null
    activeApprovalRef.current = null
    active?.reject?.(approvalPresentationClosedError())
    setToolApproval({ open: false, request: null, busy: false })
    return true
  }, [])

  useEffect(() => {
    const ownerGuard = ownerGuardRef.current
    const epochGuard = epochGuardRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      epochGuard.advance()
      const active = activeApprovalRef.current
      toolApprovalResolveRef.current = null
      activeApprovalRef.current = null
      ownerGuard.clear()
      // Reject only the local waiter. Never translate view teardown into a
      // persisted deny decision; reconnecting can replay the pending approval.
      active?.reject?.(approvalPresentationClosedError())
    }
  }, [])

  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => fetchApprovalSettings()).then((settings) => {
      if (!alive) return
      const safe = settings && typeof settings === 'object' ? settings : { mode: 'normal', rememberedTools: [] }
      setApprovalSettings(safe)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const changeApprovalMode = useCallback(async (mode) => {
    const previous = approvalSettings
    const widened = isPermissionModeWidening(previous.mode, mode)
    let justification = ''
    if (widened && typeof window !== 'undefined') {
      const approved = window.confirm(t('approvals.mode.escalationConfirm'))
      if (!approved) return false
      if (mode === 'bypass') justification = 'user-confirmed'
    }
    const next = { ...approvalSettings, mode }
    setApprovalSettings(next)
    try {
      const saved = await updateApprovalSettings({
        mode,
        approveEscalation: widened,
        ...(justification ? { justification } : {}),
      })
      const safe = saved && typeof saved === 'object' ? saved : next
      setApprovalSettings(safe)
      if (safe.modeTransition?.pending) {
        toast.info({
          title: t('approvals.mode.escalationPendingTitle'),
          body: t('approvals.mode.escalationPendingBody'),
        })
        return safe
      }
      return safe
    } catch (error) {
      setApprovalSettings(previous)
      toast.error({ title: t('errors.saveFailed'), body: error.message })
      return false
    }
  }, [approvalSettings, toast, t])

  return {
    approvalSettings,
    changeApprovalMode,
    clearToolApprovalForOwner,
    requestServerToolApproval,
    resolveToolApproval,
    resolveToolApprovalForOwner,
    setToolApproval,
    toolApproval,
    toolApprovalResolveRef,
  }
}

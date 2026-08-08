import { useCallback, useEffect, useRef, useState } from 'react'
import { decideApproval as decideApprovalApi, fetchApprovalSettings, updateApprovalSettings } from '../../lib/approvalClient.js'
import { createApprovalEpochGuard, createApprovalOwnerGuard } from './approvalOwnerGuard.js'

export default function useChatApprovals({ setWorkbenchMessage, toast, t }) {
  const [toolApproval, setToolApproval] = useState({ open: false, request: null, busy: false })
  const [approvalSettings, setApprovalSettings] = useState({ mode: 'normal', rememberedTools: [] })
  const toolApprovalResolveRef = useRef(null)
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
    }).finally(() => {
      if (typeof window !== 'undefined') window.setTimeout(close, 0)
      else close()
    })
    return true
  }, [setWorkbenchMessage])

  const requestServerToolApproval = useCallback((request, owner) => {
    // A background turn may ask for approval after its chat page was closed.
    // Deny that tool safely instead of leaving the entire turn waiting forever.
    if (!mountedRef.current) return decideApprovalApi(request.id, 'deny', null, { remember: false })
    return new Promise((resolve, reject) => {
      const previousResolve = toolApprovalResolveRef.current
      epochGuardRef.current.advance()
      previousResolve?.({ approved: false })
      ownerGuardRef.current.claim(owner)
      toolApprovalResolveRef.current = async (decision) => {
        try {
          await decideApprovalApi(request.id, decision?.approved ? 'approve' : 'deny', null, { remember: !!decision?.remember })
          resolve()
        } catch (error) {
          reject(error)
        }
      }
      setToolApproval({ open: true, request, busy: false })
    })
  }, [])

  const resolveToolApprovalForOwner = useCallback((owner, decision) => {
    if (!ownerGuardRef.current.matches(owner)) return false
    resolveToolApproval(decision)
    return true
  }, [resolveToolApproval])

  const clearToolApprovalForOwner = useCallback((owner) => {
    if (!ownerGuardRef.current.release(owner)) return false
    epochGuardRef.current.advance()
    toolApprovalResolveRef.current = null
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
      toolApprovalResolveRef.current?.({ approved: false })
      toolApprovalResolveRef.current = null
      ownerGuard.clear()
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
    const next = { ...approvalSettings, mode }
    setApprovalSettings(next)
    try {
      const saved = await updateApprovalSettings({ mode })
      const safe = saved && typeof saved === 'object' ? saved : next
      setApprovalSettings(safe)
    } catch (error) {
      setApprovalSettings(previous)
      toast.error({ title: t('errors.saveFailed'), body: error.message })
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

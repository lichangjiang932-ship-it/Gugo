import { useCallback, useEffect, useRef, useState } from 'react'
import { decideApproval as decideApprovalApi, fetchApprovalSettings, updateApprovalSettings } from '../../lib/approvalClient.js'

export default function useChatApprovals({ setWorkbenchMessage, toast, t }) {
  const [toolApproval, setToolApproval] = useState({ open: false, request: null, busy: false })
  const [approvalSettings, setApprovalSettings] = useState({ mode: 'normal', rememberedTools: [] })
  const toolApprovalResolveRef = useRef(null)

  const resolveToolApproval = useCallback((decision) => {
    const resolve = toolApprovalResolveRef.current
    toolApprovalResolveRef.current = null
    setToolApproval((current) => ({ ...current, busy: true }))
    const close = () => setToolApproval({ open: false, request: null, busy: false })
    Promise.resolve(resolve?.(decision)).catch((error) => {
      setWorkbenchMessage(error?.message || 'Approval failed.')
    }).finally(() => {
      if (typeof window !== 'undefined') window.setTimeout(close, 0)
      else close()
    })
  }, [setWorkbenchMessage])

  const requestServerToolApproval = useCallback((request) => new Promise((resolve, reject) => {
    toolApprovalResolveRef.current?.({ approved: false })
    toolApprovalResolveRef.current = async (decision) => {
      try {
        await decideApprovalApi(request.id, decision?.approved ? 'approve' : 'deny', null, { remember: !!decision?.remember })
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    setToolApproval({ open: true, request, busy: false })
  }), [])

  useEffect(() => () => {
    toolApprovalResolveRef.current?.({ approved: false })
    toolApprovalResolveRef.current = null
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
    requestServerToolApproval,
    resolveToolApproval,
    setToolApproval,
    toolApproval,
    toolApprovalResolveRef,
  }
}

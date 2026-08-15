import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { grantLocalPathApi, pickLocalDirectoryApi, setWorkspaceTrustApi } from '../../lib/localFileAccessClient.js'
import { createLocalPathAccessEnsurer, createLocalPathAccessProbe } from '../../lib/localPathAccessFlow.js'

export default function useDirectoryApproval({ lang, t, toast }) {
  const [directoryApproval, setDirectoryApproval] = useState({ open: false, request: null, requestId: null, busy: false, error: '' })
  const directoryApprovalResolveRef = useRef(null)
  const directoryApprovalRequestRef = useRef(null)
  const directoryApprovalSequenceRef = useRef(0)
  const directoryRequestAbortRef = useRef(null)

  const settleDirectoryApprovalRequest = useCallback((requestRecord, decision, { close = true } = {}) => {
    if (!requestRecord || requestRecord.settled) return false

    requestRecord.settled = true
    requestRecord.controller?.abort()
    requestRecord.controller = null
    const resolve = requestRecord.resolve
    requestRecord.resolve = null

    if (directoryApprovalRequestRef.current === requestRecord) {
      directoryApprovalRequestRef.current = null
      directoryApprovalResolveRef.current = null
      directoryRequestAbortRef.current = null
      if (close) {
        setDirectoryApproval({ open: false, request: null, requestId: null, busy: false, error: '' })
      }
    }

    resolve?.(decision)
    return true
  }, [])

  const resolveDirectoryApproval = useCallback((decision) => {
    settleDirectoryApprovalRequest(directoryApprovalRequestRef.current, decision)
  }, [settleDirectoryApprovalRequest])

  const authorizeDirectory = useCallback(async ({ path, accessMode, usePicker, trustWorkspaceConfig = false }) => {
    const requestRecord = directoryApprovalRequestRef.current
    if (!requestRecord || requestRecord.settled) return

    requestRecord.controller?.abort()
    const controller = new AbortController()
    requestRecord.controller = controller
    directoryRequestAbortRef.current = controller
    const isCurrentRequest = () => (
      directoryApprovalRequestRef.current === requestRecord
      && !requestRecord.settled
      && requestRecord.controller === controller
      && !controller.signal.aborted
    )
    setDirectoryApproval((current) => (
      current.requestId === requestRecord.id
        ? { ...current, busy: usePicker ? 'picker' : 'grant', error: '' }
        : current
    ))
    try {
      let selectedPath = String(path || '').trim()
      if (usePicker) {
        const picked = await pickLocalDirectoryApi({ signal: controller.signal })
        if (!isCurrentRequest()) return
        selectedPath = String(picked?.path || '').trim()
        if (!selectedPath) {
          setDirectoryApproval((current) => (
            current.requestId === requestRecord.id ? { ...current, busy: false } : current
          ))
          return
        }
      }
      if (!selectedPath) {
        setDirectoryApproval((current) => (
          current.requestId === requestRecord.id ? { ...current, busy: false } : current
        ))
        return
      }
      const safeAccessMode = accessMode === 'read_write' ? 'read_write' : 'read_only'
      const result = await grantLocalPathApi({ path: selectedPath, accessMode: safeAccessMode }, { signal: controller.signal })
      if (!isCurrentRequest()) return
      const grant = result?.grant
      if (trustWorkspaceConfig && grant?.resourceType === 'directory') {
        await setWorkspaceTrustApi({ path: grant.path || selectedPath, trusted: true }, { signal: controller.signal })
        if (!isCurrentRequest()) return
      }
      toast.success({ title: t('taskSteering.directoryGranted') })
      settleDirectoryApprovalRequest(requestRecord, {
        approved: true,
        path: grant?.path || selectedPath,
        accessMode: grant?.accessMode || safeAccessMode,
        resourceType: grant?.resourceType || 'directory',
        workspaceConfigTrusted: trustWorkspaceConfig && grant?.resourceType === 'directory',
      })
    } catch (error) {
      if (!isCurrentRequest()) return
      setDirectoryApproval((current) => (
        current.requestId === requestRecord.id
          ? { ...current, busy: false, error: error?.message || t('taskSteering.directoryGrantFailed') }
          : current
      ))
    } finally {
      if (requestRecord.controller === controller) requestRecord.controller = null
      if (directoryRequestAbortRef.current === controller) directoryRequestAbortRef.current = null
    }
  }, [settleDirectoryApprovalRequest, t, toast])

  const cancelDirectoryApproval = useCallback(() => {
    resolveDirectoryApproval({ approved: false })
  }, [resolveDirectoryApproval])

  const requestDirectoryApproval = useCallback((request) => new Promise((resolve) => {
    settleDirectoryApprovalRequest(
      directoryApprovalRequestRef.current,
      { approved: false },
      { close: false },
    )

    const requestRecord = {
      id: directoryApprovalSequenceRef.current + 1,
      resolve,
      controller: null,
      settled: false,
    }
    directoryApprovalSequenceRef.current = requestRecord.id
    directoryApprovalRequestRef.current = requestRecord
    directoryApprovalResolveRef.current = resolve
    setDirectoryApproval({ open: true, request, requestId: requestRecord.id, busy: false, error: '' })
  }), [settleDirectoryApprovalRequest])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    window.__directoryApprovalGate = requestDirectoryApproval
    return () => {
      if (window.__directoryApprovalGate === requestDirectoryApproval) delete window.__directoryApprovalGate
      settleDirectoryApprovalRequest(
        directoryApprovalRequestRef.current,
        { approved: false },
        { close: false },
      )
    }
  }, [requestDirectoryApproval, settleDirectoryApprovalRequest])

  const ensureLocalPathAccess = useMemo(() => createLocalPathAccessEnsurer(requestDirectoryApproval), [requestDirectoryApproval])
  const probeLocalPathAccess = useMemo(() => createLocalPathAccessProbe(lang), [lang])

  return {
    authorizeDirectory,
    cancelDirectoryApproval,
    directoryApproval,
    directoryApprovalResolveRef,
    ensureLocalPathAccess,
    probeLocalPathAccess,
    requestDirectoryApproval,
    resolveDirectoryApproval,
  }
}

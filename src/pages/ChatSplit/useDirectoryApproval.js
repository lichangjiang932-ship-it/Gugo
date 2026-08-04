import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { grantLocalPathApi, pickLocalDirectoryApi, setWorkspaceTrustApi } from '../../lib/localFileAccessClient.js'
import { createLocalPathAccessEnsurer, createLocalPathAccessProbe } from '../../lib/localPathAccessFlow.js'

export default function useDirectoryApproval({ lang, t, toast }) {
  const [directoryApproval, setDirectoryApproval] = useState({ open: false, request: null, busy: false, error: '' })
  const directoryApprovalResolveRef = useRef(null)

  const resolveDirectoryApproval = useCallback((decision) => {
    const resolve = directoryApprovalResolveRef.current
    directoryApprovalResolveRef.current = null
    resolve?.(decision)
    setDirectoryApproval({ open: false, request: null, busy: false, error: '' })
  }, [])

  const authorizeDirectory = useCallback(async ({ path, accessMode, usePicker, trustWorkspaceConfig = false }) => {
    setDirectoryApproval((current) => ({ ...current, busy: usePicker ? 'picker' : 'grant', error: '' }))
    try {
      let selectedPath = String(path || '').trim()
      if (usePicker) {
        const picked = await pickLocalDirectoryApi()
        selectedPath = String(picked?.path || '').trim()
        if (!selectedPath) {
          setDirectoryApproval((current) => ({ ...current, busy: false }))
          return
        }
      }
      if (!selectedPath) return
      const safeAccessMode = accessMode === 'read_write' ? 'read_write' : 'read_only'
      const result = await grantLocalPathApi({ path: selectedPath, accessMode: safeAccessMode })
      const grant = result?.grant
      if (trustWorkspaceConfig && grant?.resourceType === 'directory') {
        await setWorkspaceTrustApi({ path: grant.path || selectedPath, trusted: true })
      }
      toast.success({ title: t('taskSteering.directoryGranted') })
      resolveDirectoryApproval({
        approved: true,
        path: grant?.path || selectedPath,
        accessMode: grant?.accessMode || safeAccessMode,
        resourceType: grant?.resourceType || 'directory',
        workspaceConfigTrusted: trustWorkspaceConfig && grant?.resourceType === 'directory',
      })
    } catch (error) {
      setDirectoryApproval((current) => ({ ...current, busy: false, error: error?.message || t('taskSteering.directoryGrantFailed') }))
    }
  }, [resolveDirectoryApproval, t, toast])

  const requestDirectoryApproval = useCallback((request) => new Promise((resolve) => {
    directoryApprovalResolveRef.current?.({ approved: false })
    directoryApprovalResolveRef.current = resolve
    setDirectoryApproval({ open: true, request, busy: false, error: '' })
  }), [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    window.__directoryApprovalGate = requestDirectoryApproval
    return () => {
      if (window.__directoryApprovalGate === requestDirectoryApproval) delete window.__directoryApprovalGate
      directoryApprovalResolveRef.current?.({ approved: false })
      directoryApprovalResolveRef.current = null
    }
  }, [requestDirectoryApproval])

  const ensureLocalPathAccess = useMemo(() => createLocalPathAccessEnsurer(requestDirectoryApproval), [requestDirectoryApproval])
  const probeLocalPathAccess = useMemo(() => createLocalPathAccessProbe(lang), [lang])

  return { authorizeDirectory, directoryApproval, directoryApprovalResolveRef, ensureLocalPathAccess, probeLocalPathAccess, resolveDirectoryApproval }
}

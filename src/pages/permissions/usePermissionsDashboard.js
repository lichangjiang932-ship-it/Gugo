import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  configureWorkspaceOnboardingApi,
  getLocalFileAccessApi,
  setWorkspaceTrustApi,
} from '../../lib/localFileAccessClient.js'
import { probeLocalStorage, probeMedia, probeNotifications, probeStorage } from '../../lib/permissionsProbes.js'
import { GATEABLE_TOOLS, fetchToolPermissions, setToolPermission } from '../../lib/toolPermissionClient'
import { emptyPermissionResults, PERMISSION_ITEMS } from './permissionViewConfig.js'

export default function usePermissionsDashboard(t) {
  const [results, setResults] = useState(emptyPermissionResults)
  const [checking, setChecking] = useState(false)
  const [toolOverrides, setToolOverrides] = useState({})
  const [toolError, setToolError] = useState(null)
  const [localFiles, setLocalFiles] = useState(null)
  const [localFileError, setLocalFileError] = useState(null)
  const [trustBusyPath, setTrustBusyPath] = useState('')
  const [onboardingBusy, setOnboardingBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetchToolPermissions().then((permissions) => { if (alive) setToolOverrides(permissions || {}) }).catch((error) => { if (alive) setToolError(error.message) })
    return () => { alive = false }
  }, [])
  const refreshLocalFiles = useCallback(async () => {
    try { setLocalFiles(await getLocalFileAccessApi()); setLocalFileError(null) }
    catch (error) { setLocalFileError(error?.message || t('localFiles.workspaceTrustLoadFailed')) }
  }, [t])
  useEffect(() => { Promise.resolve().then(refreshLocalFiles) }, [refreshLocalFiles])
  const changeWorkspaceTrust = async (rootPath, trusted, scope = 'persistent') => {
    setTrustBusyPath(rootPath)
    try { setLocalFiles(await setWorkspaceTrustApi({ path: rootPath, trusted, scope })); setLocalFileError(null) }
    catch (error) { setLocalFileError(error?.message || t('localFiles.workspaceTrustFailed')) }
    finally { setTrustBusyPath('') }
  }
  const configureOnboarding = async (payload) => {
    setOnboardingBusy(true)
    try {
      const result = await configureWorkspaceOnboardingApi(payload)
      setLocalFiles(result)
      setLocalFileError(null)
      return true
    } catch (error) {
      const locked = Array.isArray(error?.locks) && error.locks.length
      setLocalFileError(locked
        ? t('permissionsDashboard.onboardingLocked', { keys: error.locks.map((item) => item.key).join(', ') })
        : error?.message || t('permissionsDashboard.onboardingFailed'))
      return false
    } finally {
      setOnboardingBusy(false)
    }
  }
  const isToolEnabled = (id) => toolOverrides[id] !== false
  const toggleTool = async (id) => {
    const next = !isToolEnabled(id)
    setToolOverrides((current) => ({ ...current, [id]: next }))
    try { setToolOverrides(await setToolPermission(id, next) || {}); setToolError(null) }
    catch (error) { setToolOverrides((current) => ({ ...current, [id]: !next })); setToolError(error.message) }
  }
  const runChecks = useCallback(async () => {
    setChecking(true)
    try {
      const [localStorage, storage, notifications, microphone, camera] = await Promise.all([
        Promise.resolve(probeLocalStorage()), probeStorage(), Promise.resolve(probeNotifications()), probeMedia('microphone'), probeMedia('camera'),
      ])
      setResults({ localStorage, storage, notifications, microphone, camera })
    } finally { setChecking(false) }
  }, [])
  useEffect(() => { Promise.resolve().then(runChecks) }, [runChecks])
  const requestPermission = useCallback(async (id) => {
    if (id === 'notifications') {
      if (typeof window === 'undefined' || !window.Notification) return
      try { await window.Notification.requestPermission() } catch { /* User cancelled. */ }
      setResults((current) => ({ ...current, notifications: probeNotifications() }))
      return
    }
    if (!['microphone', 'camera'].includes(id) || !navigator.mediaDevices?.getUserMedia) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia(id === 'microphone' ? { audio: true } : { video: true })
      stream?.getTracks?.().forEach((track) => { try { track.stop() } catch { /* Ignore cleanup errors. */ } })
    } catch { /* Probe below reflects denial or missing hardware. */ }
    const next = await probeMedia(id)
    setResults((current) => ({ ...current, [id]: next }))
  }, [])
  const counts = useMemo(() => PERMISSION_ITEMS.reduce((acc, item) => {
    const state = results[item.id]?.state
    if (Object.hasOwn(acc, state)) acc[state] += 1
    return acc
  }, { granted: 0, denied: 0, prompt: 0, unsupported: 0 }), [results])
  const gatedOffCount = GATEABLE_TOOLS.filter((tool) => !isToolEnabled(tool.id)).length
  return {
    changeWorkspaceTrust, checking, configureOnboarding, counts, gatedOffCount,
    isToolEnabled, localFileError, localFiles, onboardingBusy, requestPermission,
    results, runChecks, toggleTool, toolError, trustBusyPath,
  }
}

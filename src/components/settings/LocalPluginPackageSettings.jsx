import { useCallback, useEffect, useState } from 'react'
import {
  importLocalPluginPackageApi,
  listLocalPluginPackagesApi,
  recoverLocalPluginPackageApi,
  uninstallLocalPluginPackageApi,
} from '../../lib/pluginClient.js'
import { PackageActionError, PackageNotice } from './localPluginPackage/LocalPluginPackageFeedback.jsx'
import LocalPluginPackageRows from './localPluginPackage/LocalPluginPackageRows.jsx'
import LocalPluginPackageSourcePanels from './localPluginPackage/LocalPluginPackageSourcePanels.jsx'
import { REVISION_CONFLICT } from './localPluginPackage/localPluginPackagePresentation.js'

export function LocalPluginPackageManager({ t, onPackagesChanged }) {
  const [store, setStore] = useState(null)
  const [recoveries, setRecoveries] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [busy, setBusy] = useState('')
  const [directoryAction, setDirectoryAction] = useState(null)
  const [selectedSource, setSelectedSource] = useState(null)
  const [confirmUninstall, setConfirmUninstall] = useState('')
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listLocalPluginPackagesApi()
      setStore(data.store)
      setRecoveries(Array.isArray(data.recoveries) ? data.recoveries : [])
      setLoadError(null)
      return data.store
    } catch (cause) {
      setLoadError(cause)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => {
      if (active) void load()
    })
    return () => { active = false }
  }, [load])

  const refreshAfterConflict = useCallback(async (cause) => {
    if (cause?.code !== REVISION_CONFLICT) return
    try {
      const data = await listLocalPluginPackagesApi()
      setStore(data.store)
      setRecoveries(Array.isArray(data.recoveries) ? data.recoveries : [])
      setLoadError(null)
    } catch {
      // Keep the mutation error authoritative. A manual reload remains available.
    }
  }, [])

  const commitMutationResult = useCallback(async (data) => {
    setStore(data.store)
    setActionError(null)
    setDirectoryAction(null)
    setSelectedSource(null)
    setConfirmUninstall('')
    setNotice({
      kind: data.refreshPending || data.restartRequired ? 'restart' : 'success',
      operation: String(data?.result?.operation || ''),
    })
    try {
      await onPackagesChanged?.()
    } catch {
      // The package store is already authoritative. Runtime inventory can be
      // refreshed manually or after restart without replaying the mutation.
    }
  }, [onPackagesChanged])

  const storeRevision = store?.revision

  const submitSelectedSource = useCallback(async () => {
    if (!selectedSource || !storeRevision) return
    const operationKey = selectedSource.expectedPluginId
      ? `upgrade:${selectedSource.expectedPluginId}`
      : 'install'
    setBusy(operationKey)
    setActionError(null)
    setNotice(null)
    try {
      const data = await importLocalPluginPackageApi({
        sourceDirectory: selectedSource.sourceDirectory,
        expectedRevision: storeRevision,
        replace: selectedSource.replace,
        expectedPluginId: selectedSource.expectedPluginId,
      })
      await commitMutationResult(data)
    } catch (cause) {
      await refreshAfterConflict(cause)
      setActionError(cause)
    } finally {
      setBusy('')
    }
  }, [commitMutationResult, refreshAfterConflict, selectedSource, storeRevision])

  const uninstall = useCallback(async (pluginId) => {
    if (!storeRevision) return
    setBusy(`uninstall:${pluginId}`)
    setActionError(null)
    setNotice(null)
    try {
      const data = await uninstallLocalPluginPackageApi(pluginId, {
        expectedRevision: storeRevision,
      })
      await commitMutationResult(data)
    } catch (cause) {
      await refreshAfterConflict(cause)
      setActionError(cause)
    } finally {
      setBusy('')
    }
  }, [commitMutationResult, refreshAfterConflict, storeRevision])

  const recover = useCallback(async (entry) => {
    if (!storeRevision || !entry?.pluginId || !Number.isSafeInteger(entry.generation)) return
    setBusy(`recover:${entry.pluginId}`)
    setActionError(null)
    setNotice(null)
    try {
      const data = await recoverLocalPluginPackageApi(entry.pluginId, {
        expectedRevision: storeRevision,
        expectedGeneration: entry.generation,
      })
      setStore(data.store)
      setRecoveries((current) => current.filter((item) => (
        item.pluginId !== entry.pluginId || item.generation !== entry.generation
      )))
      setNotice({ kind: 'success', operation: 'recovered' })
      await onPackagesChanged?.()
    } catch (cause) {
      await refreshAfterConflict(cause)
      setActionError(cause)
    } finally {
      setBusy('')
    }
  }, [onPackagesChanged, refreshAfterConflict, storeRevision])

  const beginInstall = () => {
    setDirectoryAction({ replace: false, expectedPluginId: null })
    setSelectedSource(null)
    setConfirmUninstall('')
    setActionError(null)
    setNotice(null)
  }

  const beginUpgrade = (pluginId) => {
    setDirectoryAction({ replace: true, expectedPluginId: pluginId })
    setSelectedSource(null)
    setConfirmUninstall('')
    setActionError(null)
    setNotice(null)
  }

  const beginUninstall = (pluginId) => {
    setDirectoryAction(null)
    setSelectedSource(null)
    setActionError(null)
    setNotice(null)
    setConfirmUninstall(pluginId)
  }

  const selectSource = (sourceDirectory) => {
    setSelectedSource({ ...directoryAction, sourceDirectory })
    setDirectoryAction(null)
  }

  return (
    <>
      <LocalPluginPackageRows
        beginInstall={beginInstall}
        beginUninstall={beginUninstall}
        beginUpgrade={beginUpgrade}
        busy={busy}
        cancelUninstall={() => setConfirmUninstall('')}
        confirmUninstall={confirmUninstall}
        load={load}
        loadError={loadError}
        loading={loading}
        recover={recover}
        recoveries={recoveries}
        store={store}
        storeRevision={storeRevision}
        t={t}
        uninstall={uninstall}
      />
      <LocalPluginPackageSourcePanels
        busy={busy}
        cancelDirectory={() => setDirectoryAction(null)}
        cancelSource={() => setSelectedSource(null)}
        directoryAction={directoryAction}
        selectSource={selectSource}
        selectedSource={selectedSource}
        submitSelectedSource={submitSelectedSource}
        t={t}
      />
      {busy ? (
        <div className="mx-4 my-2 text-xs text-ink-fade" role="status">
          {t('settings.localPluginPackageWorking')}
        </div>
      ) : null}
      <PackageActionError error={actionError} t={t} />
      <PackageNotice notice={notice} t={t} />
    </>
  )
}

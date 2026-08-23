import { PackagePlus, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  importLocalPluginPackageApi,
  listLocalPluginPackagesApi,
  recoverLocalPluginPackageApi,
  uninstallLocalPluginPackageApi,
} from '../../lib/pluginClient.js'
import InlineDirectoryBrowser from '../InlineDirectoryBrowser.jsx'
import { SettingsRow } from './SettingsPrimitives.jsx'

const REVISION_CONFLICT = 'PLUGIN_PACKAGE_REVISION_CONFLICT'

function packageDescription(entry, t) {
  const digest = String(entry?.packageDigest || '')
  return [
    entry?.pluginVersion ? `v${entry.pluginVersion}` : '',
    digest ? `${digest.slice(0, 19)}…` : '',
    Number.isSafeInteger(entry?.fileCount)
      ? t('settings.localPluginPackageFiles', { count: entry.fileCount })
      : '',
  ].filter(Boolean).join(' · ')
}

function PackageActionError({ error, t }) {
  if (!error) return null
  const details = error?.details && typeof error.details === 'object' ? error.details : null
  const dependantPluginIds = Array.isArray(details?.dependantPluginIds)
    ? details.dependantPluginIds
    : []
  const blockingReasons = Array.isArray(details?.blockingReasons)
    ? details.blockingReasons
    : []
  return (
    <div
      className="mx-4 my-3 rounded-xl border border-red-500/30 bg-paper p-4 text-sm"
      data-testid="local-plugin-package-error"
      role="alert"
    >
      <h4 className="font-medium text-red-700">{t('settings.localPluginPackageActionFailed')}</h4>
      <p className="mt-1 break-words text-xs leading-5 text-ink-fade">
        {String(error?.message || t('settings.localPluginPackageActionFailedHint')).slice(0, 300)}
      </p>
      {dependantPluginIds.length > 0 ? (
        <p className="mt-2 text-xs text-ink-fade">
          {t('settings.localPluginPackageDependants')}: {dependantPluginIds.join(', ')}
        </p>
      ) : null}
      {blockingReasons.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs text-ink-fade">
          {blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
    </div>
  )
}

function PackageNotice({ notice, t }) {
  if (!notice) return null
  const warning = notice.kind === 'restart'
  return (
    <div
      className={`mx-4 my-3 rounded-xl border p-3 text-xs ${warning ? 'border-amber-500/35 bg-amber-500/5 text-amber-800' : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700'}`}
      data-testid="local-plugin-package-notice"
      role="status"
    >
      {t(warning
        ? 'settings.localPluginPackageSavedRestartRequired'
        : notice.operation === 'recovered'
          ? 'settings.localPluginPackageRecovered'
          : notice.operation === 'uninstalled'
            ? 'settings.localPluginPackageUninstalled'
            : notice.operation === 'upgraded'
            ? 'settings.localPluginPackageUpgraded'
            : notice.operation === 'unchanged'
              ? 'settings.localPluginPackageUnchanged'
              : 'settings.localPluginPackageInstalled')}
    </div>
  )
}

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

  return (
    <>
      <SettingsRow
        title={t('settings.localPluginPackages')}
        description={t('settings.localPluginPackagesDescription')}
      >
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            className="settings-action-button"
            disabled={Boolean(busy) || loading || !store}
            onClick={beginInstall}
          >
            <PackagePlus className="h-3.5 w-3.5" />
            {t('settings.localPluginPackageInstall')}
          </button>
          <button
            type="button"
            className="settings-action-button"
            disabled={Boolean(busy) || loading}
            onClick={() => void load()}
            title={t('settings.localPluginPackageRefresh')}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('settings.localPluginPackageRefresh')}
          </button>
        </span>
      </SettingsRow>

      {loadError ? (
        <SettingsRow
          title={loadError?.code === 'LOCAL_OWNER_ONLY'
            ? t('settings.pluginLocalOwnerOnly')
            : t('settings.localPluginPackageLoadFailed')}
          description={String(loadError?.message || '').slice(0, 240)}
        />
      ) : null}
      {loading && !store ? (
        <SettingsRow title={t('settings.pluginLoading')} description="" />
      ) : null}
      {!loading && store?.packages?.length === 0 ? (
        <SettingsRow
          title={t('settings.localPluginPackageNone')}
          description={t('settings.localPluginPackageNoneHint')}
        />
      ) : null}

      {recoveries.map((entry) => {
        const orphaned = entry.recoveryRequired === false
        return (
          <SettingsRow
            key={`${entry.pluginId}:${entry.generation}`}
            title={`${t(orphaned
              ? 'settings.localPluginPackageRecoveryInterrupted'
              : 'settings.localPluginPackageRecoveryRequired')} · ${entry.pluginId}`}
            description={t(orphaned
              ? 'settings.localPluginPackageRecoveryInterruptedHint'
              : 'settings.localPluginPackageRecoveryHint', {
              generation: entry.generation,
              phase: entry.phase,
            })}
          >
          <button
            type="button"
            className="settings-action-button settings-action-button-primary"
            data-testid={`local-plugin-package-recover-${entry.pluginId}`}
            disabled={Boolean(busy) || loading || !storeRevision}
            onClick={() => void recover(entry)}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {t('settings.localPluginPackageRecover')}
          </button>
          </SettingsRow>
        )
      })}

      {(store?.packages || []).map((entry) => {
        const pluginId = String(entry.pluginId || '')
        const confirming = confirmUninstall === pluginId
        return (
          <div key={pluginId} data-testid={`local-plugin-package-${pluginId}`}>
            <SettingsRow title={pluginId} description={packageDescription(entry, t)}>
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                <button
                  type="button"
                  className="settings-action-button"
                  disabled={Boolean(busy)}
                  onClick={() => beginUpgrade(pluginId)}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {t('settings.localPluginPackageUpgrade')}
                </button>
                <button
                  type="button"
                  className="settings-action-button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setDirectoryAction(null)
                    setSelectedSource(null)
                    setActionError(null)
                    setNotice(null)
                    setConfirmUninstall(pluginId)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('settings.localPluginPackageUninstall')}
                </button>
              </span>
            </SettingsRow>
            {confirming ? (
              <div
                className="mx-4 my-3 rounded-xl border border-amber-500/35 bg-amber-500/5 p-4 text-sm"
                data-testid={`local-plugin-package-uninstall-confirm-${pluginId}`}
                role="alert"
              >
                <h4 className="font-medium text-ink">
                  {t('settings.localPluginPackageUninstallConfirmTitle')} · {pluginId}
                </h4>
                <p className="mt-1 text-xs leading-5 text-ink-fade">
                  {t('settings.localPluginPackageUninstallConfirmHint')}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    className="settings-action-button"
                    disabled={Boolean(busy)}
                    onClick={() => setConfirmUninstall('')}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className="settings-action-button settings-action-button-primary"
                    disabled={Boolean(busy)}
                    onClick={() => void uninstall(pluginId)}
                  >
                    {t('settings.localPluginPackageUninstallConfirm')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}

      {directoryAction ? (
        <div className="mx-4 my-3 rounded-xl border border-ink/15 bg-paper p-3">
          <h4 className="text-sm font-medium text-ink">
            {directoryAction.expectedPluginId
              ? `${t('settings.localPluginPackageChooseUpgradeSource')} · ${directoryAction.expectedPluginId}`
              : t('settings.localPluginPackageChooseInstallSource')}
          </h4>
          <p className="mt-1 text-xs leading-5 text-ink-fade">
            {t('settings.localPluginPackageSourceHint')}
          </p>
          <InlineDirectoryBrowser
            t={t}
            onSelect={(sourceDirectory) => {
              setSelectedSource({ ...directoryAction, sourceDirectory })
              setDirectoryAction(null)
            }}
            onCancel={() => setDirectoryAction(null)}
          />
        </div>
      ) : null}

      {selectedSource ? (
        <div
          className="mx-4 my-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm"
          data-testid="local-plugin-package-source-confirm"
        >
          <h4 className="font-medium text-ink">
            {selectedSource.expectedPluginId
              ? t('settings.localPluginPackageConfirmUpgradeTitle')
              : t('settings.localPluginPackageConfirmInstallTitle')}
          </h4>
          <p className="mt-1 text-xs text-ink-fade">
            {t('settings.localPluginPackageSelectedSource')}
          </p>
          <code className="mt-2 block break-all rounded-md bg-paper px-2.5 py-2 text-xs text-ink">
            {selectedSource.sourceDirectory}
          </code>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="settings-action-button"
              disabled={Boolean(busy)}
              onClick={() => setSelectedSource(null)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="settings-action-button settings-action-button-primary"
              disabled={Boolean(busy)}
              onClick={() => void submitSelectedSource()}
            >
              {selectedSource.expectedPluginId
                ? t('settings.localPluginPackageConfirmUpgrade')
                : t('settings.localPluginPackageConfirmInstall')}
            </button>
          </div>
        </div>
      ) : null}

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

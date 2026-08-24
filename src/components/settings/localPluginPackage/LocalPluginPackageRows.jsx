import { PackagePlus, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { SettingsRow } from '../SettingsPrimitives.jsx'
import { packageDescription } from './localPluginPackagePresentation.js'

export default function LocalPluginPackageRows({
  beginInstall,
  beginUninstall,
  beginUpgrade,
  busy,
  cancelUninstall,
  confirmUninstall,
  load,
  loadError,
  loading,
  recover,
  recoveries,
  store,
  storeRevision,
  t,
  uninstall,
}) {
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
                  onClick={() => beginUninstall(pluginId)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('settings.localPluginPackageUninstall')}
                </button>
              </span>
            </SettingsRow>
            {confirming ? (
              <div
                className="mx-4 my-3 rounded-card border border-ink/10 border-l-2 border-l-warning bg-paper p-4 text-sm"
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
                    onClick={cancelUninstall}
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
    </>
  )
}

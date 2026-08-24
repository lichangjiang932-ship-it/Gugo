import InlineDirectoryBrowser from '../../InlineDirectoryBrowser.jsx'

export default function LocalPluginPackageSourcePanels({
  busy,
  cancelDirectory,
  cancelSource,
  directoryAction,
  selectSource,
  selectedSource,
  submitSelectedSource,
  t,
}) {
  return (
    <>
      {directoryAction ? (
        <div className="mx-4 my-3 rounded-card border border-ink/15 bg-paper p-3">
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
            onSelect={selectSource}
            onCancel={cancelDirectory}
          />
        </div>
      ) : null}

      {selectedSource ? (
        <div
          className="mx-4 my-3 rounded-card border border-ink/10 border-l-2 border-l-running bg-paper p-4 text-sm"
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
              onClick={cancelSource}
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
    </>
  )
}

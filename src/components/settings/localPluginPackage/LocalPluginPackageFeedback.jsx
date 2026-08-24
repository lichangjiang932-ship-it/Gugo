export function PackageActionError({ error, t }) {
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
      className="mx-4 my-3 rounded-card border border-ink/10 border-l-2 border-l-danger bg-paper p-4 text-sm"
      data-testid="local-plugin-package-error"
      role="alert"
    >
      <h4 className="font-medium text-ink">{t('settings.localPluginPackageActionFailed')}</h4>
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

export function PackageNotice({ notice, t }) {
  if (!notice) return null
  const warning = notice.kind === 'restart'
  return (
    <div
      className={`mx-4 my-3 rounded-card border border-ink/10 border-l-2 bg-paper p-3 text-xs text-ink-soft ${warning ? 'border-l-warning' : 'border-l-success'}`}
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

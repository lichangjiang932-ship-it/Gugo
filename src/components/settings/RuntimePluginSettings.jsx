import { Fragment } from 'react'
import { RotateCcw, ShieldCheck } from 'lucide-react'
import { SettingsRow } from './SettingsPrimitives.jsx'

function PermissionApprovalCard({ challenge, busy, onApprove, onDismiss, t }) {
  if (!challenge) return null
  return (
    <div
      className="mx-4 my-3 rounded-xl border border-ink/15 bg-paper p-4 text-sm shadow-sm"
      data-testid={`runtime-plugin-permission-approval-${challenge.pluginId}`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h4 className="font-medium text-ink">{t('settings.pluginPermissionReviewTitle')}</h4>
          <p className="mt-1 text-xs leading-5 text-ink-fade">
            {t('settings.pluginPermissionReviewHint')}
          </p>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
            <dt className="text-ink-fade">{t('settings.pluginPermissionVersion')}</dt>
            <dd className="font-mono text-ink">{challenge.pluginVersion}</dd>
            <dt className="text-ink-fade">{t('settings.pluginPermissionSource')}</dt>
            <dd className="break-all font-mono text-ink" title={challenge.sourceDigest}>
              {challenge.sourceDigest}
            </dd>
          </dl>
          <p className="mt-3 text-xs font-medium text-ink">
            {t('settings.pluginPermissionRequested')}
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 font-mono text-xs text-ink-fade">
            {challenge.permissions.map((permission) => <li key={permission}>{permission}</li>)}
          </ul>
          <p className="mt-3 text-xs leading-5 text-ink-fade">
            {t('settings.pluginPermissionChangeHint')}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="settings-action-button"
              disabled={busy}
              onClick={onDismiss}
            >
              {t('settings.pluginPermissionCancel')}
            </button>
            <button
              type="button"
              className="settings-action-button settings-action-button-primary"
              disabled={busy}
              onClick={onApprove}
            >
              {t('settings.pluginPermissionApprove')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PluginActionFailure({ failure, t }) {
  if (!failure) return null
  const revokeFailed = failure.action === 'revoke-permissions'
  return (
    <div
      className="mx-4 my-3 rounded-xl border border-red-500/30 bg-paper p-4 text-sm"
      data-testid={`runtime-plugin-action-failure-${failure.pluginId}`}
      role="alert"
    >
      <h4 className="font-medium text-red-700">
        {t(revokeFailed ? 'settings.pluginRevokeFailedTitle' : 'settings.pluginActionFailedTitle')}
      </h4>
      <p className="mt-1 text-xs leading-5 text-ink-fade">
        {t(revokeFailed ? 'settings.pluginRevokeFailedHint' : 'settings.pluginActionFailedHint')}
      </p>
      {failure.message ? <p className="mt-2 text-xs text-ink-fade">{failure.message}</p> : null}
    </div>
  )
}

export function RuntimePluginList({
  plugins,
  error,
  busy,
  permissionChallenge,
  actionFailure,
  onAction,
  onApprove,
  onDismissApproval,
  t,
}) {
  if (error) {
    const localOwnerOnly = error?.code === 'LOCAL_OWNER_ONLY'
    return (
      <SettingsRow
        title={localOwnerOnly ? t('settings.pluginLocalOwnerOnly') : t('settings.pluginLoadFailed')}
        description={localOwnerOnly ? t('settings.runtimePluginsLocalOnlyHint') : String(error?.message || '').slice(0, 200)}
      />
    )
  }
  if (!plugins) {
    return <SettingsRow title={t('settings.pluginLoading')} description="" />
  }
  if (plugins.length === 0) {
    return <SettingsRow title={t('settings.pluginNone')} description={t('settings.pluginNoneHint')} />
  }
  return plugins.map((plugin) => {
    const enabled = plugin?.enabled === true
    const active = plugin?.active === true
    const controllable = plugin?.controllable === true
    const hasPermissionGrant = Boolean(plugin?.permissionGrant?.grantedAt)
    const statusKey = active
      ? 'settings.pluginActive'
      : enabled ? 'settings.pluginEnabled' : 'settings.pluginInactive'
    const description = [
      plugin?.version ? `v${plugin.version}` : '',
      plugin?.toolName ? `tool: ${plugin.toolName}` : '',
      plugin?.lastError ? String(plugin.lastError).slice(0, 120) : '',
    ].filter(Boolean).join(' · ')
    const challenge = permissionChallenge?.pluginId === plugin?.id
      ? permissionChallenge
      : null
    const failure = actionFailure?.pluginId === plugin?.id
      ? actionFailure
      : null
    return (
      <Fragment key={String(plugin?.id || '')}>
        <SettingsRow title={String(plugin?.name || plugin?.id || '')} description={description}>
          <span className={`text-xs ${active ? 'text-emerald-600' : 'text-ink-fade'}`}>{t(statusKey)}</span>
          {controllable && (
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              {!enabled && (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => onAction(plugin.id, 'enable')}
                  className="settings-action-button"
                >
                  {t('settings.pluginEnable')}
                </button>
              )}
              {enabled && (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => onAction(plugin.id, 'disable')}
                  className="settings-action-button"
                >
                  {t('settings.pluginDisable')}
                </button>
              )}
              <button
                type="button"
                disabled={Boolean(busy) || !enabled}
                onClick={() => onAction(plugin.id, 'reload')}
                className="settings-action-button"
                title={t('settings.pluginReload')}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('settings.pluginReload')}
              </button>
              {hasPermissionGrant && (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => onAction(plugin.id, 'revoke-permissions')}
                  className="settings-action-button"
                  title={t('settings.pluginRevokePermissionsHint')}
                >
                  {t('settings.pluginRevokePermissions')}
                </button>
              )}
            </span>
          )}
        </SettingsRow>
        <PermissionApprovalCard
          challenge={challenge}
          busy={Boolean(busy)}
          onApprove={onApprove}
          onDismiss={onDismissApproval}
          t={t}
        />
        <PluginActionFailure failure={failure} t={t} />
      </Fragment>
    )
  })
}

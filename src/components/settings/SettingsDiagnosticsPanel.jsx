import { RefreshCw, Server } from 'lucide-react'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPrimitives.jsx'

function StatusDot({ ok }) {
  const color = ok === true ? 'bg-emerald-500' : ok === false ? 'bg-red-500' : 'bg-ink-fade'
  return <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden="true" />
}

export default function SettingsDiagnosticsPanel({
  authMode = 'multi_user',
  diagnostics,
  message,
  loading,
  onConfigureModels,
  onRefresh,
  onTest,
  t,
}) {
  const model = diagnostics?.model
  const endpoint = diagnostics?.endpoint
  const mail = diagnostics?.mail
  const turnHost = diagnostics?.runtime?.turnHost
  const localModelNeedsConfiguration = authMode === 'local'
    && diagnostics
    && model?.configured === false

  return (
    <SettingsPanel title={t('settings.about')} description={t('settings.aboutDescription')}>
      <SettingsGroup>
        <SettingsRow title={t('settings.runtimeMode')} description={authMode === 'local' ? t('settings.localAuthDescription') : t('settings.multiUserDescription')}>
          <span className="settings-inline-status">
            {t(authMode === 'local' ? 'settings.localMode' : 'settings.multiUserMode')}
          </span>
        </SettingsRow>
        <SettingsRow title={t('settings.systemDiagnostics')} description={t('settings.systemDiagnosticsDescription')}>
          <button type="button" onClick={() => onRefresh()} disabled={loading} className="settings-action-button">
            <RefreshCw className="h-3.5 w-3.5" />
            {t('settings.refresh')}
          </button>
          <button type="button" onClick={() => onRefresh({ check: true })} disabled={loading} className="settings-action-button">
            <Server className="h-3.5 w-3.5" />
            {t('settings.probeEndpoint')}
          </button>
        </SettingsRow>
      </SettingsGroup>

      {turnHost ? (
        <SettingsGroup title={t('settings.agentRuntime')}>
          <SettingsRow
            title={t('settings.agentRuntimeStatus')}
            description={t(turnHost.ready
              ? 'settings.agentRuntimeReadyDescription'
              : 'settings.agentRuntimeUnavailableDescription')}
          >
            <StatusDot ok={turnHost.ready} />
            <span className="settings-inline-status">
              {t(turnHost.ready ? 'settings.agentRuntimeReady' : 'settings.agentRuntimeUnavailable')}
            </span>
          </SettingsRow>
          <SettingsRow title={t('settings.turnPersistence')}>
            <StatusDot ok={turnHost.persistenceConfigured} />
            <span className="settings-inline-status">
              {t(turnHost.persistenceConfigured ? 'settings.hostPortReady' : 'settings.hostPortUnavailable')}
            </span>
          </SettingsRow>
          <SettingsRow title={t('settings.compactionArchiveStorage')}>
            <StatusDot ok={turnHost.compactionArchiveConfigured} />
            <span className="settings-inline-status">
              {t(turnHost.compactionArchiveConfigured ? 'settings.hostPortReady' : 'settings.hostPortUnavailable')}
            </span>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {localModelNeedsConfiguration ? (
        <SettingsGroup>
          <SettingsRow title={t('modelProviders.notConfigured')} description={t('settings.localAuthHint')}>
            <button type="button" onClick={onConfigureModels} className="settings-action-button settings-action-button-primary">
              {t('modelProviders.manage')}
            </button>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={t('settings.modelService')}>
        <SettingsRow title={t('modelProviders.currentModel')} description={model?.modelName || t('modelProviders.notConfigured')}>
          <StatusDot ok={model?.configured} />
          <span className="settings-inline-status">
            {t(model?.configured ? 'modelProviders.statusConfigured' : 'modelProviders.statusWaiting')}
          </span>
        </SettingsRow>
        <SettingsRow title={t('modelProviders.baseUrlLabel')}>
          <code className="settings-link-value">{model?.baseUrlMasked || t('modelProviders.notConfigured')}</code>
        </SettingsRow>
        <SettingsRow title={t('settings.endpointStatus')} description={endpoint?.error || endpoint?.reason}>
          <StatusDot ok={endpoint?.checked ? endpoint.ok : null} />
          <span className="settings-inline-status">
            {t(endpoint?.checked ? (endpoint.ok ? 'settings.endpointReady' : 'settings.endpointUnavailable') : 'settings.endpointUnchecked')}
          </span>
        </SettingsRow>
        <SettingsRow title={t('settings.testModel')} description={t('settings.testModelDescription')}>
          <button type="button" onClick={onTest} disabled={loading || !model?.configured} className="settings-action-button">
            {t('settings.testModel')}
          </button>
        </SettingsRow>
      </SettingsGroup>

      {model?.models?.length ? (
        <SettingsGroup title={t('settings.availableModels')}>
          <SettingsRow title={t('settings.availableModels')} description={t('settings.availableModelsDescription', { count: model.models.length })}>
            <span className="settings-link-value">{model.models.map((item) => item.name).join(', ')}</span>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {authMode !== 'local' ? (
        <SettingsGroup title={t('settings.emailLogin')}>
          <SettingsRow title={t('settings.smtpService')} description={mail?.server || t('modelProviders.notConfigured')}>
            <StatusDot ok={mail?.configured} />
            <span className="settings-inline-status">
              {t(mail?.configured ? 'settings.smtpConfigured' : 'settings.smtpWaiting')}
            </span>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {message ? <p className="settings-inline-status px-1" role="status">{message}</p> : null}
    </SettingsPanel>
  )
}

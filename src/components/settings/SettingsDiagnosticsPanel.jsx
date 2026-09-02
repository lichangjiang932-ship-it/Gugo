import { RefreshCw, Server } from 'lucide-react'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPrimitives.jsx'

const CODEX_REASON_TRANSLATIONS = Object.freeze({
  CODEX_APP_SERVER_DISABLED: 'settings.codexHostDisabledDescription',
  CODEX_CLI_NOT_FOUND: 'settings.codexCliNotFoundDescription',
  CODEX_CLI_PATH_INVALID: 'settings.codexCliPathInvalidDescription',
  CODEX_CLI_SIGNATURE_INVALID: 'settings.codexCliSignatureInvalidDescription',
  CODEX_CLI_VERSION_INVALID: 'settings.codexCliVersionInvalidDescription',
  CODEX_APP_SERVER_HANDSHAKE_TIMEOUT: 'settings.codexHandshakeTimeoutDescription',
})

const LSP_INVALID_CONFIG_CODES = Object.freeze([
  'LSP_COMMAND_NOT_ALLOWED',
  'LSP_CONFIG_INVALID',
])

const LSP_INITIALIZATION_CODES = Object.freeze([
  'LSP_CONFLICT',
  'LSP_INVALID_PROVIDER',
  'LSP_PROVIDER_FACTORY_INVALID',
  'LSP_PROVIDER_INIT_FAILED',
])

const LSP_EXECUTION_FAILURE_CODES = Object.freeze([
  'LSP_PROCESS_BACKOFF',
  'LSP_PROCESS_EXITED',
  'LSP_PROCESS_FAILED',
  'LSP_PROVIDER_FAILED',
  'LSP_TIMEOUT',
  'LSP_TRANSPORT_FAILED',
])

const LSP_PROTOCOL_FAILURE_CODES = Object.freeze([
  'LSP_MALFORMED_RESPONSE',
  'LSP_RESPONSE_TOO_LARGE',
  'LSP_SERVER_ERROR',
])

function resolveLspPresentation(lspHost) {
  if (!lspHost || typeof lspHost !== 'object') return null

  const enabled = lspHost.enabled === true
  const providerCount = Number.isSafeInteger(lspHost.providerCount) && lspHost.providerCount > 0
    ? lspHost.providerCount
    : 0
  const reason = typeof lspHost.reason === 'string' ? lspHost.reason : ''
  const code = typeof lspHost.code === 'string' ? lspHost.code : ''

  if (reason === 'invalid_config' || LSP_INVALID_CONFIG_CODES.includes(code)) {
    return {
      descriptionKey: 'settings.lspInvalidConfigDescription',
      ok: false,
      providerCount: 0,
      statusKey: 'settings.lspInvalidConfig',
    }
  }
  if (reason === 'provider_initialization_failed' || LSP_INITIALIZATION_CODES.includes(code)) {
    return {
      descriptionKey: 'settings.lspInitializationFailedDescription',
      ok: false,
      providerCount: 0,
      statusKey: 'settings.lspInitializationFailed',
    }
  }
  if (reason === 'query_failed' && LSP_EXECUTION_FAILURE_CODES.includes(code)) {
    return {
      descriptionKey: 'settings.lspExecutionFailedDescription',
      ok: false,
      providerCount,
      statusKey: 'settings.lspExecutionFailed',
    }
  }
  if (reason === 'query_failed' && LSP_PROTOCOL_FAILURE_CODES.includes(code)) {
    return {
      descriptionKey: 'settings.lspProtocolFailedDescription',
      ok: false,
      providerCount,
      statusKey: 'settings.lspProtocolFailed',
    }
  }
  if (reason === 'query_failed') {
    return {
      descriptionKey: 'settings.lspQueryFailedDescription',
      ok: false,
      providerCount,
      statusKey: 'settings.lspQueryFailed',
    }
  }
  if (enabled && providerCount > 0 && reason === 'configured') {
    return {
      descriptionKey: 'settings.lspReadyDescription',
      ok: true,
      providerCount,
      statusKey: 'settings.lspReady',
    }
  }
  return {
    descriptionKey: 'settings.lspNotConfiguredDescription',
    ok: null,
    providerCount: 0,
    statusKey: 'settings.lspNotConfigured',
  }
}

function StatusDot({ ok }) {
  const color = ok === true ? 'bg-success' : ok === false ? 'bg-danger' : 'bg-ink-fade'
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
  const codexHost = diagnostics?.runtime?.codexHost
  const lspPresentation = resolveLspPresentation(diagnostics?.runtime?.lspHost)
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

      {codexHost ? (
        <SettingsGroup title={t('settings.codexIntegration')}>
          <SettingsRow
            title={t('settings.codexAppServer')}
            description={codexHost.ready
              ? t('settings.codexHostReadyDescription', { version: codexHost.version || 'unknown' })
              : t(CODEX_REASON_TRANSLATIONS[codexHost.reasonCode]
                || 'settings.codexHostUnavailableDescription')}
          >
            <StatusDot ok={codexHost.enabled ? codexHost.ready : null} />
            <span className="settings-inline-status">
              {t(codexHost.ready
                ? 'settings.codexHostReady'
                : codexHost.enabled
                  ? 'settings.codexHostUnavailable'
                  : 'settings.codexHostDisabled')}
            </span>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {lspPresentation ? (
        <SettingsGroup title={t('settings.lspIntegration')}>
          <SettingsRow
            title={t('settings.lspLanguageServers')}
            description={t(lspPresentation.descriptionKey, { count: lspPresentation.providerCount })}
          >
            <StatusDot ok={lspPresentation.ok} />
            <span className="settings-inline-status">
              {t(lspPresentation.statusKey)}
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

import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppLayout from '../components/AppLayout.jsx'
import Modal from '../components/Modal.jsx'
import SettingsDataExport from '../components/settings/SettingsDataExport.jsx'
import SettingsDiagnosticsPanel from '../components/settings/SettingsDiagnosticsPanel.jsx'
import SettingsFileOutputPanel from '../components/settings/SettingsFileOutputPanel.jsx'
import SettingsModelsPanel from '../components/settings/SettingsModelsPanel.jsx'
import SettingsSideEffectRecoveryPanel from '../components/settings/SettingsSideEffectRecoveryPanel.jsx'
import {
  SettingsAgentPresetsPanel,
  SettingsAppearancePanel,
  SettingsIntegrationsPanel,
  SettingsPermissionsPanel,
  SettingsPetPanel,
  SettingsPluginsPanel,
} from '../components/settings/SettingsSecondaryPanels.jsx'
import { SettingsGroup, SettingsPanel, SettingsRow } from '../components/settings/SettingsPrimitives.jsx'
import SettingsWebSearchPanel from '../components/settings/SettingsWebSearchPanel.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { getSystemDiagnostics, testModelEndpoint } from '../lib/modelClient.js'
import { parseModelRecoveryTarget } from '../lib/modelRequestRecoveryClient.js'
import { openRuntimeConfigInBrowser } from '../lib/runtimeConfigClient.js'
import {
  SETTINGS_TAB_ABOUT,
  SETTINGS_TAB_AGENT_PRESETS,
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_DATA,
  SETTINGS_TAB_GENERAL,
  SETTINGS_TAB_INTEGRATIONS,
  SETTINGS_TAB_LANGUAGE,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_PLUGINS,
  SETTINGS_TAB_RECOVERY,
  SETTINGS_TAB_WEB_SEARCH,
} from '../lib/settingsNavigation.js'
import useSettingsNavigation from '../lib/useSettingsNavigation.js'
import { useLocation } from '../lib/router.jsx'
import { useAppContext } from '../store/AppContext'
import { UiContributionRenderer, useUiContributions } from '../plugins/uiContributionRegistry.js'
import SettingsDialogNavigation from './settingsView/SettingsDialogNavigation.jsx'
import { getBrowserStorageEstimate, getLocalStorageBytes } from './settingsView/storageEstimate.js'
import './SettingsView.css'

export default function SettingsView() {
  const { state, dispatch } = useAppContext()
  const { activeSection, navigate, returnTo, setActiveSection } = useSettingsNavigation()
  const location = useLocation()
  const { t, lang, setLang, languages } = useT()
  const contributedSettings = useUiContributions('settings-section')
  const closeButtonRef = useRef(null)
  const [storageTick, setStorageTick] = useState(0)
  const [storageEstimate, setStorageEstimate] = useState(() => ({ usage: getLocalStorageBytes(), quota: null }))
  const [diagnostics, setDiagnostics] = useState(null)
  const [diagnosticsMessage, setDiagnosticsMessage] = useState('')
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [configMessage, setConfigMessage] = useState('')
  const modelRecoveryTarget = useMemo(
    () => parseModelRecoveryTarget(location.search, state.activeSessionId),
    [location.search, state.activeSessionId],
  )

  const closeSettings = useCallback(
    () => navigate(returnTo || '/chat', { replace: true }),
    [navigate, returnTo],
  )
  const openRecoveredTask = useCallback(({ record, resume } = {}) => {
    if (record?.scopeKind === 'turn'
      && typeof record.sessionId === 'string'
      && record.sessionId
      && typeof record.turnId === 'string'
      && record.turnId) {
      dispatch({ type: 'SWITCH_SESSION', payload: record.sessionId })
      navigate('/chat', {
        state: resume?.kind === 'turn' ? { manualRecoveryResume: resume } : null,
      })
      return
    }
    if (record?.scopeKind === 'job' && typeof record.jobId === 'string' && record.jobId) {
      navigate(`/task?${new URLSearchParams({ job: record.jobId })}`)
    }
  }, [dispatch, navigate])
  const refreshStorage = useCallback(() => setStorageTick((value) => value + 1), [])

  useEffect(() => {
    let active = true
    getBrowserStorageEstimate().then((estimate) => {
      if (active) setStorageEstimate(estimate)
    })
    return () => { active = false }
  }, [state.sessions.length, state.history.length, storageTick])

  const refreshDiagnostics = useCallback(async ({ check = false } = {}) => {
    setDiagnosticsLoading(true)
    setDiagnosticsMessage(check ? t('settings.diagnosticsChecking') : '')
    try {
      setDiagnostics(await getSystemDiagnostics({ check }))
      setDiagnosticsMessage(t(check ? 'settings.diagnosticsChecked' : 'settings.diagnosticsRefreshed'))
    } catch (error) {
      setDiagnosticsMessage(error.message)
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [t])

  const testModel = useCallback(async () => {
    setDiagnosticsLoading(true)
    setDiagnosticsMessage(t('settings.modelTesting'))
    try {
      const result = await testModelEndpoint()
      setDiagnosticsMessage(t('settings.modelTestSucceeded', { latency: result.latency ?? 0 }))
    } catch (error) {
      setDiagnosticsMessage(error.message)
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [t])

  useEffect(() => {
    Promise.resolve().then(() => refreshDiagnostics())
  }, [refreshDiagnostics])

  const enabledPermCount = useMemo(
    () => state.permissions.filter((permission) => permission.enabled).length,
    [state.permissions],
  )

  const openConfigFile = useCallback(async () => {
    const desktopOpen = globalThis.window?.gugoDesktop?.openConfigFile
    try {
      const result = typeof desktopOpen === 'function'
        ? await desktopOpen()
        : await openRuntimeConfigInBrowser()
      if (result?.opened !== true) throw new Error('runtime config was not opened')
      setConfigMessage(t('settings.configFileOpened'))
    } catch {
      setConfigMessage(t('settings.configFileOpenFailed'))
    }
  }, [t])

  function renderModels() {
    return <SettingsModelsPanel
      diagnostics={diagnostics}
      onChanged={() => refreshDiagnostics()}
      onReady={returnTo ? closeSettings : undefined}
      t={t}
    />
  }

  function renderGeneral() {
    return (
      <SettingsPanel title={t('settings.general')} description={t('settings.generalDescription')}>
        <SettingsFileOutputPanel compact t={t} />
        <SettingsPetPanel compact t={t} />
      </SettingsPanel>
    )
  }

  function renderLanguage() {
    return (
      <SettingsPanel title={t('settings.language')} description={t('settings.languageHint')}>
        <SettingsGroup>
          <SettingsRow title={t('settings.interfaceLanguage')} description={t('settings.interfaceLanguageDescription')}>
            <select
              id="settings-language"
              aria-label={t('settings.interfaceLanguage')}
              value={lang}
              onChange={(event) => setLang(event.target.value)}
              className="settings-select"
            >
              {languages.map((language) => (
                <option key={language.code} value={language.code}>{language.label}</option>
              ))}
            </select>
          </SettingsRow>
        </SettingsGroup>
      </SettingsPanel>
    )
  }

  function renderAbout() {
    return (
      <SettingsDiagnosticsPanel
        compact
        authMode={state.authMode}
        diagnostics={diagnostics}
        message={diagnosticsMessage}
        loading={diagnosticsLoading}
        onConfigureModels={() => setActiveSection(SETTINGS_TAB_MODELS)}
        onRefresh={refreshDiagnostics}
        onTest={testModel}
        t={t}
      />
    )
  }

  function renderActive() {
    const contributed = contributedSettings.find((entry) => entry.sectionId === activeSection)
    if (contributed) {
      return <UiContributionRenderer
        contribution={contributed}
        context={{ dispatch, lang, navigate, state, t }}
        fallback={<div role="alert" className="settings-empty-state">{t('errors.unknown')}</div>}
      />
    }
    switch (activeSection) {
      case SETTINGS_TAB_GENERAL:
        return renderGeneral()
      case SETTINGS_TAB_MODELS:
        return renderModels()
      case SETTINGS_TAB_APPEARANCE:
        return <SettingsAppearancePanel t={t} state={state} dispatch={dispatch} />
      case SETTINGS_TAB_LANGUAGE:
        return renderLanguage()
      case SETTINGS_TAB_PLUGINS:
        return <SettingsPluginsPanel navigate={navigate} t={t} />
      case SETTINGS_TAB_WEB_SEARCH:
        return <SettingsWebSearchPanel t={t} />
      case SETTINGS_TAB_PERMISSIONS:
        return <SettingsPermissionsPanel navigate={navigate} t={t} state={state} enabledPermCount={enabledPermCount} />
      case SETTINGS_TAB_AGENT_PRESETS:
        return <SettingsAgentPresetsPanel navigate={navigate} t={t} />
      case SETTINGS_TAB_INTEGRATIONS:
        return <SettingsIntegrationsPanel navigate={navigate} t={t} />
      case SETTINGS_TAB_DATA:
        return <SettingsDataExport state={state} dispatch={dispatch} storageBytes={storageEstimate.usage} storageQuota={storageEstimate.quota} onStorageChanged={refreshStorage} />
      case SETTINGS_TAB_RECOVERY:
        return <SettingsSideEffectRecoveryPanel
          lang={lang}
          modelRecoveryTarget={modelRecoveryTarget}
          onOpenOriginalTask={openRecoveredTask}
          t={t}
        />
      case SETTINGS_TAB_ABOUT:
      default:
        return renderAbout()
    }
  }

  return (
    <div className="settings-page h-screen flex overflow-hidden">
      <AppLayout className="settings-page-background flex min-w-0 flex-1" aria-hidden="true" inert={true}>
        <div className="min-w-0 flex-1 bg-paper-2/25" />
      </AppLayout>
      <Modal
        onClose={closeSettings}
        ariaLabel={t('settings.sectionTitle')}
        initialFocusRef={closeButtonRef}
        restoreFocusSelector="[data-settings-focus-return]"
        overlayClassName="settings-page-backdrop"
        className="settings-dialog"
      >
          <SettingsDialogNavigation
            activeSection={activeSection}
            contributedSettings={contributedSettings}
            setActiveSection={setActiveSection}
            t={t}
          />
          <main className="settings-dialog-main">
            <header className="settings-dialog-toolbar">
              {configMessage ? <span className="settings-dialog-status" role="status">{configMessage}</span> : null}
              <button type="button" className="settings-config-button" onClick={() => void openConfigFile()}>
                {t('settings.openConfigFile')}
              </button>
              <button
                ref={closeButtonRef}
                type="button"
                className="settings-close-button"
                onClick={closeSettings}
                aria-label={t('settings.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="settings-dialog-content">{renderActive()}</div>
          </main>
      </Modal>
    </div>
  )
}

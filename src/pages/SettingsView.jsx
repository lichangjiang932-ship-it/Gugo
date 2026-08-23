import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import LeftRail from '../components/LeftRail'
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
import useModalFocusTrap from '../lib/useModalFocusTrap.js'
import { useAppContext } from '../store/AppContext'
import { estimatePersistedSnapshotBytes } from '../store/indexedDbPersistence.js'
import { UiContributionRenderer, useUiContributions } from '../plugins/uiContributionRegistry.js'
import './SettingsView.css'

const SETTINGS_NAV_GROUPS = [
  {
    labelKey: 'settings.navGroups.general',
    items: [
      SETTINGS_TAB_GENERAL,
      SETTINGS_TAB_MODELS,
      SETTINGS_TAB_APPEARANCE,
      SETTINGS_TAB_LANGUAGE,
    ],
  },
  {
    labelKey: 'settings.navGroups.capabilities',
    items: [
      SETTINGS_TAB_PLUGINS,
      SETTINGS_TAB_WEB_SEARCH,
      SETTINGS_TAB_PERMISSIONS,
      SETTINGS_TAB_AGENT_PRESETS,
    ],
  },
  {
    labelKey: 'settings.navGroups.system',
    items: [
      SETTINGS_TAB_INTEGRATIONS,
      SETTINGS_TAB_DATA,
      SETTINGS_TAB_RECOVERY,
      SETTINGS_TAB_ABOUT,
    ],
  },
]

function getLocalStorageBytes() {
  if (typeof window === 'undefined') return 0
  let total = 0
  try {
    for (const key of Object.keys(window.localStorage)) {
      const value = window.localStorage.getItem(key) || ''
      total += key.length + value.length
    }
  } catch (error) {
    console.warn('[SettingsView] localStorage unavailable:', error?.name || error)
    return 0
  }
  return total * 2
}

async function getBrowserStorageEstimate() {
  const localStorageBytes = getLocalStorageBytes()
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate()
      if (Number.isFinite(estimate?.usage)) {
        return {
          usage: estimate.usage,
          quota: Number.isFinite(estimate.quota) ? estimate.quota : null,
        }
      }
    }
  } catch {
    // Fall back to application-owned storage below.
  }
  const indexedDb = await estimatePersistedSnapshotBytes()
  return {
    usage: localStorageBytes + (indexedDb.ok ? indexedDb.bytes : 0),
    quota: null,
  }
}

export default function SettingsView() {
  const { state, dispatch } = useAppContext()
  const { activeSection, navigate, returnTo, setActiveSection } = useSettingsNavigation()
  const location = useLocation()
  const { t, lang, setLang, languages } = useT()
  const contributedSettings = useUiContributions('settings-section')
  const closeButtonRef = useRef(null)
  const dialogRef = useRef(null)
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

  useModalFocusTrap({
    dialogRef,
    initialFocusRef: closeButtonRef,
    onClose: closeSettings,
    restoreFocusSelector: '[data-settings-focus-return]',
  })

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

  const navLabel = (item) => {
    switch (item) {
      case SETTINGS_TAB_GENERAL: return t('settings.general')
      case SETTINGS_TAB_MODELS: return t('modelProviders.navTitle')
      case SETTINGS_TAB_APPEARANCE: return t('settings.appearance')
      case SETTINGS_TAB_LANGUAGE: return t('settings.language')
      case SETTINGS_TAB_PLUGINS: return t('settings.plugins')
      case SETTINGS_TAB_WEB_SEARCH: return t('webSearch.title')
      case SETTINGS_TAB_PERMISSIONS: return t('nav.permissions')
      case SETTINGS_TAB_AGENT_PRESETS: return t('settings.agentPresets')
      case SETTINGS_TAB_INTEGRATIONS: return t('settings.integrations')
      case SETTINGS_TAB_DATA: return t('settings.dataExport')
      case SETTINGS_TAB_RECOVERY: return t('sideEffectRecovery.navTitle')
      case SETTINGS_TAB_ABOUT: return t('settings.about')
      default: return item
    }
  }

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
      <div className="settings-page-background flex min-w-0 flex-1" aria-hidden="true" inert={true}>
        <LeftRail />
        <div className="min-w-0 flex-1 bg-paper-2/25" />
      </div>
      <div className="settings-page-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSettings()
      }}>
        <div
          ref={dialogRef}
          className="settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('settings.sectionTitle')}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <aside className="settings-dialog-nav">
            <div className="settings-dialog-brand">{t('settings.sectionTitle')}</div>
            <nav className="settings-nav-groups" aria-label={t('settings.sectionTitle')}>
              {SETTINGS_NAV_GROUPS.map((group) => (
                <section className="settings-nav-group" key={group.labelKey}>
                  <h2 className="settings-nav-group-label">{t(group.labelKey)}</h2>
                  <div className="settings-nav-group-items">
                    {group.items.map((item) => (
                      <button
                        key={item}
                        type="button"
                        aria-current={activeSection === item ? 'page' : undefined}
                        onClick={() => setActiveSection(item)}
                        className="settings-nav-item"
                      >
                        {navLabel(item)}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {contributedSettings.length > 0 && (
                <section className="settings-nav-group" data-ui-contribution-slot="settings-section">
                  <h2 className="settings-nav-group-label">{t('settings.plugins')}</h2>
                  <div className="settings-nav-group-items">
                    {contributedSettings.map((contribution) => (
                      <button
                        key={contribution.key}
                        type="button"
                        aria-current={activeSection === contribution.sectionId ? 'page' : undefined}
                        onClick={() => setActiveSection(contribution.sectionId)}
                        className="settings-nav-item"
                      >
                        {contribution.labelKey ? t(contribution.labelKey) : contribution.label}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </nav>
          </aside>
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
        </div>
      </div>
    </div>
  )
}

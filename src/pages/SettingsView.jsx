import { useCallback, useEffect, useMemo, useState } from 'react'
import LeftRail from '../components/LeftRail'
import SettingsDataExport from '../components/settings/SettingsDataExport.jsx'
import SettingsDiagnosticsPanel from '../components/settings/SettingsDiagnosticsPanel.jsx'
import SettingsModelsPanel from '../components/settings/SettingsModelsPanel.jsx'
import {
  SettingsAppearancePanel,
  SettingsFeatureHub,
  SettingsIntegrationsPanel,
  SettingsPermissionsPanel,
  SettingsPetPanel,
} from '../components/settings/SettingsSecondaryPanels.jsx'
import SettingsFileOutputPanel from '../components/settings/SettingsFileOutputPanel.jsx'
import SettingsWebSearchPanel from '../components/settings/SettingsWebSearchPanel.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { getSystemDiagnostics, testModelEndpoint } from '../lib/modelClient.js'
import {
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_DATA,
  SETTINGS_TAB_DIAGNOSTICS,
  SETTINGS_TAB_FEATURES,
  SETTINGS_TAB_FILES,
  SETTINGS_TAB_INTEGRATIONS,
  SETTINGS_TAB_LANGUAGE,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_PET,
  SETTINGS_TAB_WEB_SEARCH,
} from '../lib/settingsNavigation.js'
import useSettingsNavigation from '../lib/useSettingsNavigation.js'
import { useAppContext } from '../store/AppContext'
import { estimatePersistedSnapshotBytes } from '../store/indexedDbPersistence.js'

const SETTINGS_NAV_ITEMS = [
  SETTINGS_TAB_FEATURES,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_WEB_SEARCH,
  SETTINGS_TAB_FILES,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_INTEGRATIONS,
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_LANGUAGE,
  SETTINGS_TAB_PET,
  SETTINGS_TAB_DIAGNOSTICS,
  SETTINGS_TAB_DATA,
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
  const { activeSection, navigate, setActiveSection } = useSettingsNavigation()
  const { t, lang, setLang, languages } = useT()
  const [storageTick, setStorageTick] = useState(0)
  const [storageEstimate, setStorageEstimate] = useState(() => ({ usage: getLocalStorageBytes(), quota: null }))
  const [diagnostics, setDiagnostics] = useState(null)
  const [diagnosticsMessage, setDiagnosticsMessage] = useState('')
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)

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
    setDiagnosticsMessage(check ? '正在探测模型端点...' : '')
    try {
      setDiagnostics(await getSystemDiagnostics({ check }))
      setDiagnosticsMessage(check ? '端点探测完成。' : '诊断状态已刷新。')
    } catch (error) {
      setDiagnosticsMessage(error.message)
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [])

  const testModel = useCallback(async () => {
    setDiagnosticsLoading(true)
    setDiagnosticsMessage('正在发送测试消息...')
    try {
      const result = await testModelEndpoint()
      setDiagnosticsMessage(`测试成功，延迟 ${result.latency ?? 0} ms。`)
    } catch (error) {
      setDiagnosticsMessage(error.message)
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [])

  useEffect(() => {
    Promise.resolve().then(() => refreshDiagnostics())
  }, [refreshDiagnostics])

  const enabledPermCount = useMemo(
    () => state.permissions.filter((permission) => permission.enabled).length,
    [state.permissions],
  )

  const navLabel = (item) => {
    switch (item) {
      case SETTINGS_TAB_FEATURES: return '功能入口'
      case SETTINGS_TAB_MODELS: return t('modelProviders.navTitle')
      case SETTINGS_TAB_WEB_SEARCH: return t('webSearch.title')
      case SETTINGS_TAB_FILES: return t('fileOutput.navTitle')
      case SETTINGS_TAB_PERMISSIONS: return t('nav.permissions')
      case SETTINGS_TAB_INTEGRATIONS: return t('settings.integrations')
      case SETTINGS_TAB_APPEARANCE: return t('settings.appearance')
      case SETTINGS_TAB_LANGUAGE: return t('settings.language')
      case SETTINGS_TAB_PET: return t('settings.pet')
      case SETTINGS_TAB_DIAGNOSTICS: return t('settings.systemDiagnostics')
      case SETTINGS_TAB_DATA: return t('settings.dataExport')
      default: return item
    }
  }

  function renderModels() {
    return <SettingsModelsPanel diagnostics={diagnostics} onChanged={() => refreshDiagnostics()} t={t} />
  }

  function renderLanguage() {
    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">LANGUAGE</span>
          <h1 className="mt-1.5 text-[28px] font-semibold text-ink">{t('settings.language')}</h1>
          <p className="mt-1 text-sm text-ink-soft">{t('settings.languageHint')}</p>
        </div>
        <div className="max-w-md rounded-md border border-ink/20 p-4">
          <label htmlFor="settings-language" className="mb-2 block text-sm font-medium text-ink">{t('settings.language')}</label>
          <select id="settings-language" value={lang} onChange={(event) => setLang(event.target.value)} className="h-10 w-full rounded-md border border-ink/30 bg-paper px-3 text-sm text-ink outline-none focus:border-ember">
            {languages.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
        </div>
      </section>
    )
  }

  function renderActive() {
    switch (activeSection) {
      case SETTINGS_TAB_FEATURES:
        return <SettingsFeatureHub navigate={navigate} t={t} />
      case SETTINGS_TAB_MODELS:
        return renderModels()
      case SETTINGS_TAB_WEB_SEARCH:
        return <SettingsWebSearchPanel t={t} />
      case SETTINGS_TAB_INTEGRATIONS:
        return <SettingsIntegrationsPanel navigate={navigate} t={t} />
      case SETTINGS_TAB_PERMISSIONS:
        return <SettingsPermissionsPanel navigate={navigate} t={t} state={state} enabledPermCount={enabledPermCount} />
      case SETTINGS_TAB_FILES:
        return <SettingsFileOutputPanel t={t} />
      case SETTINGS_TAB_LANGUAGE:
        return renderLanguage()
      case SETTINGS_TAB_PET:
        return <SettingsPetPanel t={t} />
      case SETTINGS_TAB_DATA:
        return <SettingsDataExport state={state} dispatch={dispatch} storageBytes={storageEstimate.usage} storageQuota={storageEstimate.quota} onStorageChanged={refreshStorage} />
      case SETTINGS_TAB_DIAGNOSTICS:
        return <SettingsDiagnosticsPanel authMode={state.authMode} diagnostics={diagnostics} message={diagnosticsMessage} loading={diagnosticsLoading} onConfigureModels={() => setActiveSection(SETTINGS_TAB_MODELS)} onRefresh={refreshDiagnostics} onTest={testModel} t={t} />
      case SETTINGS_TAB_APPEARANCE:
      default:
        return <SettingsAppearancePanel t={t} state={state} dispatch={dispatch} />
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <div className="min-w-0 flex-1 flex flex-col md:flex-row overflow-hidden">
        <aside className="shrink-0 border-b md:border-b-0 md:border-r border-dashed border-ink-fade/50 bg-paper-2 px-2 py-2 md:w-[220px] md:p-4 md:overflow-y-auto overflow-x-auto">
          <div className="hidden md:block font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade mb-3">{t('settings.sectionTitle')}</div>
          <nav className="flex min-w-max flex-row gap-1 md:min-w-0 md:flex-col" aria-label={t('settings.sectionTitle')}>
            {SETTINGS_NAV_ITEMS.map((item) => (
              <button key={item} type="button" aria-current={activeSection === item ? 'page' : undefined} onClick={() => setActiveSection(item)} className={`shrink-0 text-left px-3 py-2 rounded-md text-sm transition-colors ${activeSection === item ? 'bg-paper border border-ink-fade/50 text-ink' : 'text-ink-soft hover:bg-paper/70'}`}>
                {navLabel(item)}
              </button>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="max-w-4xl">{renderActive()}</div>
        </main>
      </div>
    </div>
  )
}

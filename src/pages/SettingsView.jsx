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
  SETTINGS_PAGE_APPEARANCE_LANGUAGE,
  SETTINGS_PAGE_FEATURES,
  SETTINGS_PAGE_FILES_PERMISSIONS,
  SETTINGS_PAGE_MODEL_SEARCH,
  SETTINGS_PAGE_SYSTEM_DATA,
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_DATA,
  SETTINGS_TAB_DIAGNOSTICS,
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
  SETTINGS_PAGE_FEATURES,
  SETTINGS_PAGE_MODEL_SEARCH,
  SETTINGS_PAGE_FILES_PERMISSIONS,
  SETTINGS_PAGE_APPEARANCE_LANGUAGE,
  SETTINGS_PAGE_SYSTEM_DATA,
]

function SettingsSubnav({ label, onChange, options, value }) {
  return (
    <nav className="mb-6 flex flex-wrap gap-1 rounded-lg border border-ink/15 bg-paper-2 p-1" aria-label={label}>
      {options.map(([id, title]) => (
        <button
          key={id}
          type="button"
          aria-current={value === id ? 'page' : undefined}
          onClick={() => onChange(id)}
          className={`min-h-9 rounded-md px-3 text-sm transition-colors ${value === id ? 'bg-paper font-medium text-ink shadow-sm' : 'text-ink-soft hover:bg-paper/70 hover:text-ink'}`}
        >
          {title}
        </button>
      ))}
    </nav>
  )
}

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
  const { activeNav, activeSection, navigate, setActiveNav, setActiveSection } = useSettingsNavigation()
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
      case SETTINGS_PAGE_FEATURES: return '功能入口'
      case SETTINGS_PAGE_MODEL_SEARCH: return `${t('modelProviders.navTitle')} · ${t('webSearch.title')}`
      case SETTINGS_PAGE_FILES_PERMISSIONS: return `${t('fileOutput.navTitle')} · ${t('nav.permissions')}`
      case SETTINGS_PAGE_APPEARANCE_LANGUAGE: return `${t('settings.appearance')} · ${t('settings.language')}`
      case SETTINGS_PAGE_SYSTEM_DATA: return `${t('settings.systemDiagnostics')} · ${t('settings.dataExport')}`
      default: return item
    }
  }

  const sectionOptions = () => {
    switch (activeNav) {
      case SETTINGS_PAGE_MODEL_SEARCH:
        return [[SETTINGS_TAB_MODELS, t('modelProviders.navTitle')], [SETTINGS_TAB_WEB_SEARCH, t('webSearch.title')], [SETTINGS_TAB_INTEGRATIONS, t('settings.integrations')]]
      case SETTINGS_PAGE_FILES_PERMISSIONS:
        return [[SETTINGS_TAB_FILES, t('fileOutput.navTitle')], [SETTINGS_TAB_PERMISSIONS, t('nav.permissions')]]
      case SETTINGS_PAGE_APPEARANCE_LANGUAGE:
        return [[SETTINGS_TAB_APPEARANCE, t('settings.appearance')], [SETTINGS_TAB_LANGUAGE, t('settings.language')], [SETTINGS_TAB_PET, t('settings.pet')]]
      case SETTINGS_PAGE_SYSTEM_DATA:
        return [[SETTINGS_TAB_DIAGNOSTICS, t('settings.systemDiagnostics')], [SETTINGS_TAB_DATA, t('settings.dataExport')]]
      default:
        return []
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
    if (activeNav === SETTINGS_PAGE_FEATURES) return <SettingsFeatureHub navigate={navigate} t={t} />

    let panel
    switch (activeSection) {
      case SETTINGS_TAB_MODELS:
        panel = renderModels()
        break
      case SETTINGS_TAB_WEB_SEARCH:
        panel = <SettingsWebSearchPanel t={t} />
        break
      case SETTINGS_TAB_INTEGRATIONS:
        panel = <SettingsIntegrationsPanel navigate={navigate} t={t} />
        break
      case SETTINGS_TAB_PERMISSIONS:
        panel = <SettingsPermissionsPanel navigate={navigate} t={t} state={state} enabledPermCount={enabledPermCount} />
        break
      case SETTINGS_TAB_FILES:
        panel = <SettingsFileOutputPanel t={t} />
        break
      case SETTINGS_TAB_LANGUAGE:
        panel = renderLanguage()
        break
      case SETTINGS_TAB_PET:
        panel = <SettingsPetPanel t={t} />
        break
      case SETTINGS_TAB_DATA:
        panel = <SettingsDataExport state={state} dispatch={dispatch} storageBytes={storageEstimate.usage} storageQuota={storageEstimate.quota} onStorageChanged={refreshStorage} />
        break
      case SETTINGS_TAB_DIAGNOSTICS:
        panel = <SettingsDiagnosticsPanel authMode={state.authMode} diagnostics={diagnostics} message={diagnosticsMessage} loading={diagnosticsLoading} onConfigureModels={() => setActiveSection(SETTINGS_TAB_MODELS)} onRefresh={refreshDiagnostics} onTest={testModel} t={t} />
        break
      case SETTINGS_TAB_APPEARANCE:
      default:
        panel = <SettingsAppearancePanel t={t} state={state} dispatch={dispatch} />
        break
    }

    return <><SettingsSubnav label={navLabel(activeNav)} options={sectionOptions()} value={activeSection} onChange={setActiveSection} />{panel}</>
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <aside className="w-[240px] border-r border-dashed border-ink-fade/50 p-4 overflow-y-auto bg-paper-2">
        <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade mb-3">{t('settings.sectionTitle')}</div>
        <nav className="flex flex-col gap-1">
          {SETTINGS_NAV_ITEMS.map((item) => (
            <button key={item} aria-current={activeNav === item ? 'page' : undefined} onClick={() => setActiveNav(item)} className={`text-left px-3 py-2.5 rounded-md text-sm transition-colors ${activeNav === item ? 'bg-paper border border-ink-fade/50 text-ink' : 'text-ink-soft hover:bg-paper/70'}`}>
              {navLabel(item)}
            </button>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl">{renderActive()}</div>
      </main>
    </div>
  )
}

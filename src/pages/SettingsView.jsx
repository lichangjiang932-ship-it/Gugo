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
import SettingsToolsPanel from '../components/settings/SettingsToolsPanel.jsx'
import SettingsWebSearchPanel from '../components/settings/SettingsWebSearchPanel.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { useLocation, useNavigate } from '../lib/router.jsx'
import { getSystemDiagnostics, testModelEndpoint } from '../lib/modelClient.js'
import {
  resolveSettingsNavFromSearch,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_WEB_SEARCH,
} from '../lib/settingsNavigation.js'
import { useAppContext } from '../store/AppContext'
import { estimatePersistedSnapshotBytes } from '../store/indexedDbPersistence.js'

const SETTINGS_NAV_GROUPS = [
  { label: null, items: ['功能入口'] },
  { label: 'groupModelSearch', items: [SETTINGS_TAB_MODELS, SETTINGS_TAB_WEB_SEARCH] },
  { label: 'groupPermissionsTools', items: ['权限中心', '工具'] },
  { label: null, items: ['集成', '外观', '宠物', '系统诊断', '数据 & 导出'] },
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
  const navigate = useNavigate()
  const location = useLocation()
  const { t, lang, setLang, languages } = useT()
  const [storageTick, setStorageTick] = useState(0)
  const [storageEstimate, setStorageEstimate] = useState(() => ({ usage: getLocalStorageBytes(), quota: null }))
  const [diagnostics, setDiagnostics] = useState(null)
  const [diagnosticsMessage, setDiagnosticsMessage] = useState('')
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)

  const urlNav = resolveSettingsNavFromSearch(location.search)
  const [navOverride, setNavOverride] = useState({ search: location.search, nav: null })
  const activeNav = navOverride.search === location.search && navOverride.nav
    ? navOverride.nav
    : urlNav
  const setActiveNav = (nav) => setNavOverride({ search: location.search, nav })

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
      case '功能入口': return '功能入口'
      case SETTINGS_TAB_MODELS: return t('modelProviders.navTitle')
      case SETTINGS_TAB_WEB_SEARCH: return t('webSearch.title')
      case '权限中心': return t('nav.permissions')
      case '工具': return t('settings.tools')
      case '集成': return t('settings.integrations')
      case '外观': return t('settings.appearance')
      case '宠物': return t('settings.pet')
      case '系统诊断': return t('settings.systemDiagnostics')
      case '数据 & 导出': return t('settings.dataExport')
      default: return item
    }
  }

  function renderModels() {
    return <SettingsModelsPanel diagnostics={diagnostics} onChanged={() => refreshDiagnostics()} t={t} />
  }

  function renderActive() {
    switch (activeNav) {
      case '功能入口':
        return <SettingsFeatureHub navigate={navigate} t={t} />
      case SETTINGS_TAB_MODELS:
        return renderModels()
      case SETTINGS_TAB_WEB_SEARCH:
        return <SettingsWebSearchPanel t={t} />
      case '系统诊断':
        return <SettingsDiagnosticsPanel authMode={state.authMode} diagnostics={diagnostics} message={diagnosticsMessage} loading={diagnosticsLoading} onConfigureModels={() => setActiveNav(SETTINGS_TAB_MODELS)} onRefresh={refreshDiagnostics} onTest={testModel} t={t} />
      case '权限中心':
        return <SettingsPermissionsPanel navigate={navigate} t={t} state={state} enabledPermCount={enabledPermCount} />
      case '工具':
        return <SettingsToolsPanel state={state} dispatch={dispatch} t={t} />
      case '集成':
        return <SettingsIntegrationsPanel navigate={navigate} t={t} />
      case '外观':
        return <SettingsAppearancePanel t={t} state={state} dispatch={dispatch} />
      case '宠物':
        return <SettingsPetPanel t={t} />
      case '数据 & 导出':
        return <SettingsDataExport state={state} dispatch={dispatch} storageBytes={storageEstimate.usage} storageQuota={storageEstimate.quota} onStorageChanged={refreshStorage} />
      default:
        return <SettingsFeatureHub navigate={navigate} t={t} />
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <aside className="w-[220px] border-r border-dashed border-ink-fade/50 p-4 overflow-y-auto bg-paper-2">
        <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade mb-3">{t('settings.sectionTitle')}</div>
        <div className="mb-4">
          <label className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade block mb-1.5">{t('settings.language')}</label>
          <select value={lang} onChange={(event) => setLang(event.target.value)} aria-label={t('settings.language')} className="w-full h-8 px-2 border border-ink/30 rounded-md bg-paper text-sm text-ink outline-none focus:border-ember">
            {languages.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
          <p className="text-[10px] text-ink-fade mt-1">{t('settings.languageHint')}</p>
        </div>
        <nav className="flex flex-col gap-1">
          {SETTINGS_NAV_GROUPS.map((group) => (
            <div key={group.label || group.items.join(',')} className="flex flex-col gap-1">
              {group.label ? <div className="px-3 pt-3 pb-1 font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{t(`settings.${group.label}`)}</div> : null}
              {group.items.map((item) => (
                <button key={item} onClick={() => setActiveNav(item)} className={`text-left px-3 py-2 rounded-md text-sm transition-colors ${activeNav === item ? 'bg-paper border border-ink-fade/50 text-ink' : 'text-ink-soft hover:bg-paper/70'}`}>
                  {navLabel(item)}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl">{renderActive()}</div>
      </main>
    </div>
  )
}

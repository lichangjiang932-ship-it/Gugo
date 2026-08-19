import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileJson, HardDrive, MessageSquare, Trash2, Upload, Zap } from 'lucide-react'
import { clearPersistedState } from '../../store/AppContext.jsx'
import { InvalidExportError, SCHEMA_VERSION, parseImport, wrapSessionsExport, wrapSettingsExport } from '../../store/exportSchema.js'
import { useT } from '../../i18n/I18nProvider.jsx'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPrimitives.jsx'

function formatBytes(bytes) {
  if (!bytes) return '0 KB'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function SettingsDataExport({ state, dispatch, storageBytes, storageQuota, onStorageChanged }) {
  const { t } = useT()
  const [message, setMessage] = useState('')
  const [importMode, setImportMode] = useState('merge')
  const [clearing, setClearing] = useState(false)
  const inputRef = useRef(null)

  const exportSessions = () => {
    downloadJson(`sessions-${Date.now()}.json`, wrapSessionsExport(state.sessions))
    setMessage(t('settingsDataExport.sessionsExported', { version: SCHEMA_VERSION }))
  }
  const exportSettings = () => {
    downloadJson(`settings-${Date.now()}.json`, wrapSettingsExport({
      theme: state.theme, accentColor: state.accentColor, fontSize: state.fontSize, density: state.density,
      animationsEnabled: state.animationsEnabled, permissions: state.permissions, skillConfigs: state.skillConfigs,
      inputHistoryNavigationEnabled: state.inputHistoryNavigationEnabled !== false,
    }))
    setMessage(t('settingsDataExport.settingsExported', { version: SCHEMA_VERSION }))
  }
  const importFile = async (file) => {
    if (!file) return
    try {
      const parsed = parseImport(await file.text())
      if (parsed.kind === 'sessions') {
        dispatch({ type: 'IMPORT_SESSIONS', payload: parsed.payload })
        setMessage(t('settingsDataExport.sessionsImported', { count: parsed.payload.length, schema: parsed.schema }))
      } else {
        dispatch({ type: 'IMPORT_SETTINGS', payload: { settings: parsed.payload, mode: importMode } })
        setMessage(t('settingsDataExport.settingsImported', {
          mode: t(`settingsDataExport.${importMode === 'replace' ? 'replace' : 'merge'}`),
          schema: parsed.schema,
        }))
      }
      onStorageChanged()
    } catch (error) {
      setMessage(t('settingsDataExport.importFailed', {
        reason: error instanceof InvalidExportError ? error.reason : error?.message || error,
      }))
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }
  const clearTemporary = () => {
    let cleared = 0
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('your-model-atelier:tmp:') || key.startsWith('tmp:')) {
          localStorage.removeItem(key)
          cleared += 1
        }
      }
    } catch (error) {
      setMessage(t('settingsDataExport.storageUnavailable', { reason: error?.name || 'Error' }))
      return
    }
    onStorageChanged()
    setMessage(t('settingsDataExport.temporaryCleared', { count: cleared }))
  }
  const clearAll = async () => {
    if (!confirm(t('settingsDataExport.clearConfirm'))) return
    setClearing(true)
    try {
      const result = await clearPersistedState()
      if (result?.ok) {
        dispatch({ type: 'CLEAR_ALL_DATA' })
        setMessage(t('settingsDataExport.clearSucceeded'))
      } else {
        setMessage(t('settingsDataExport.clearFailed', {
          reason: result?.reason || result?.status || 'unknown',
        }))
      }
      onStorageChanged()
    } finally {
      setClearing(false)
    }
  }

  return (
    <SettingsPanel title={t('settingsDataExport.title')} description={t('settingsDataExport.subtitle')}>
      <SettingsGroup title={t('settingsDataExport.exportData')}>
        <SettingsRow title={t('settingsDataExport.exportSessions')} description={t('settingsDataExport.exportSessionsDescription')}>
          <button type="button" onClick={exportSessions} className="settings-action-button">
            <FileJson className="h-3.5 w-3.5" />{t('settingsDataExport.exportSessions')}
          </button>
        </SettingsRow>
        <SettingsRow title={t('settingsDataExport.exportSettings')} description={t('settingsDataExport.exportSettingsDescription')}>
          <button type="button" onClick={exportSettings} className="settings-action-button">
            <Download className="h-3.5 w-3.5" />{t('settingsDataExport.exportSettings')}
          </button>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('settingsDataExport.importData')}>
        <SettingsRow title={t('settingsDataExport.chooseJson')} description={t('settingsDataExport.importHint', { version: SCHEMA_VERSION })}>
          <input ref={inputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => importFile(event.target.files?.[0])} />
          <button type="button" onClick={() => inputRef.current?.click()} className="settings-action-button">
            <Upload className="h-3.5 w-3.5" />{t('settingsDataExport.chooseJson')}
          </button>
        </SettingsRow>
        <SettingsRow title={t('settingsDataExport.importMode')}>
          <select className="settings-select" value={importMode} onChange={(event) => setImportMode(event.target.value)}>
            <option value="merge">{t('settingsDataExport.mergeHint')}</option>
            <option value="replace">{t('settingsDataExport.replaceHint')}</option>
          </select>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('settingsDataExport.storageStats')}>
        <SettingsRow title={t('settingsDataExport.browserStorage')}>
          <HardDrive className="h-3.5 w-3.5 text-ink-fade" />
          <span className="settings-inline-status">{formatBytes(storageBytes)}{storageQuota ? ` / ${formatBytes(storageQuota)}` : ''}</span>
        </SettingsRow>
        <SettingsRow title={t('settingsDataExport.sessionCount')}>
          <MessageSquare className="h-3.5 w-3.5 text-ink-fade" />
          <span className="settings-inline-status">{state.sessions.length}</span>
        </SettingsRow>
        <SettingsRow title={t('settingsDataExport.historyCount')}>
          <CheckCircle2 className="h-3.5 w-3.5 text-ink-fade" />
          <span className="settings-inline-status">{state.history.length}</span>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('settingsDataExport.localCleanup')}>
        <SettingsRow title={t('settingsDataExport.clearTemporary')} description={t('settingsDataExport.clearTemporaryDescription')}>
          <button type="button" onClick={clearTemporary} className="settings-action-button">
            <Zap className="h-3.5 w-3.5" />{t('settingsDataExport.clearTemporary')}
          </button>
        </SettingsRow>
        <SettingsRow title={t('settingsDataExport.clearAll')} description={t('settingsDataExport.clearWarning')}>
          <AlertTriangle className="h-3.5 w-3.5 text-accent-ink" />
          <button type="button" onClick={clearAll} disabled={clearing} className="settings-action-button text-accent-ink">
            <Trash2 className="h-3.5 w-3.5" />{t('settingsDataExport.clearAll')}
          </button>
        </SettingsRow>
      </SettingsGroup>
      {message ? <p className="settings-inline-status px-1" role="status">{message}</p> : null}
    </SettingsPanel>
  )
}

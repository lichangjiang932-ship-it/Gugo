import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileJson, HardDrive, MessageSquare, Trash2, Upload, Zap } from 'lucide-react'
import { clearPersistedState } from '../../store/AppContext.jsx'
import { InvalidExportError, SCHEMA_VERSION, parseImport, wrapSessionsExport, wrapSettingsExport } from '../../store/exportSchema.js'
import { useT } from '../../i18n/I18nProvider.jsx'

function Group({ title, children }) {
  return (
    <div className="p-4 border border-ink/30 rounded-md flex flex-col gap-3">
      <h3 className="font-hand text-lg text-ink">{title}</h3>
      {children}
    </div>
  )
}

function Stat({ icon: Icon, value, label }) {
  return (
    <div className="p-3 border border-ink-fade/30 rounded-md flex items-center gap-3">
      <Icon className="w-5 h-5 text-ink-fade" />
      <div><span className="text-sm text-ink">{value}</span><span className="text-xs text-ink-soft block">{label}</span></div>
    </div>
  )
}

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
    <section className="flex flex-col gap-5 animate-float-up">
      <div><span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">DATA & EXPORT</span><h1 className="font-hand text-[28px] text-ink mt-1.5">{t('settingsDataExport.title')}</h1></div>
      <Group title={t('settingsDataExport.exportData')}><div className="flex flex-wrap gap-2">
        <button onClick={exportSessions} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 flex items-center gap-1.5"><FileJson className="w-3.5 h-3.5" />{t('settingsDataExport.exportSessions')}</button>
        <button onClick={exportSettings} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 flex items-center gap-1.5"><Download className="w-3.5 h-3.5" />{t('settingsDataExport.exportSettings')}</button>
      </div></Group>
      <Group title={t('settingsDataExport.importData')}>
        <div className="flex flex-wrap items-center gap-2"><input ref={inputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => importFile(event.target.files?.[0])} /><button onClick={() => inputRef.current?.click()} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 flex items-center gap-1.5"><Upload className="w-3.5 h-3.5" />{t('settingsDataExport.chooseJson')}</button><span className="text-xs text-ink-soft">{t('settingsDataExport.importHint', { version: SCHEMA_VERSION })}</span></div>
        <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-ink-soft"><span>{t('settingsDataExport.importMode')}</span>{[['merge', t('settingsDataExport.mergeHint')], ['replace', t('settingsDataExport.replaceHint')]].map(([value, label]) => <label key={value} className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="settingsImportMode" value={value} checked={importMode === value} onChange={() => setImportMode(value)} className="accent-ember" /><span className={importMode === value ? 'text-ink' : ''}>{label}</span></label>)}</div>
      </Group>
      <Group title={t('settingsDataExport.storageStats')}><div className="grid grid-cols-1 md:grid-cols-3 gap-3"><Stat icon={HardDrive} value={`${formatBytes(storageBytes)}${storageQuota ? ` / ${formatBytes(storageQuota)}` : ''}`} label={t('settingsDataExport.browserStorage')} /><Stat icon={MessageSquare} value={String(state.sessions.length)} label={t('settingsDataExport.sessionCount')} /><Stat icon={CheckCircle2} value={String(state.history.length)} label={t('settingsDataExport.historyCount')} /></div></Group>
      <Group title={t('settingsDataExport.localCleanup')}><div className="flex flex-wrap gap-2"><button onClick={clearTemporary} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 flex items-center gap-1.5"><Zap className="w-3.5 h-3.5" />{t('settingsDataExport.clearTemporary')}</button><button onClick={clearAll} disabled={clearing} className="h-9 px-4 border border-ember-line rounded-md text-sm text-ember hover:bg-ember-soft disabled:cursor-wait disabled:opacity-60 flex items-center gap-1.5"><Trash2 className="w-3.5 h-3.5" />{t('settingsDataExport.clearAll')}</button></div>{message && <div className="p-3 border border-ink-fade/40 rounded-md text-sm text-ink-soft bg-paper-2">{message}</div>}</Group>
      <div className="p-4 border border-dashed border-ember-line rounded-md bg-ember-soft/30 text-sm text-ember flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{t('settingsDataExport.clearWarning')}</div>
    </section>
  )
}

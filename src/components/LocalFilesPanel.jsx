import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, FileText, Folder, FolderOpen, Loader2, ShieldCheck, Trash2 } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import { useAppContext } from '../store/AppContext.jsx'
import {
  getLocalFileAccessApi,
  grantLocalPathApi,
  pickLocalDirectoryApi,
  revokeLocalPathApi,
  setAllFilesAccessApi,
} from '../lib/localFileAccessClient.js'

function applyStatus(setStatus, data) {
  setStatus({
    allFilesEnabled: !!data.allFilesEnabled,
    grants: Array.isArray(data.grants) ? data.grants : [],
    workspace: data.workspace || { enabled: false, path: null },
    runtime: data.runtime || {},
  })
}

export default function LocalFilesPanel() {
  const { t } = useT()
  const { dispatch } = useAppContext()
  const [status, setStatus] = useState(null)
  const [pathValue, setPathValue] = useState('')
  const [accessMode, setAccessMode] = useState('read_write')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')

  const refresh = useCallback(async () => {
    try {
      applyStatus(setStatus, await getLocalFileAccessApi())
      setMessage('')
    } catch (error) {
      setMessage(error.message)
    }
  }, [])

  useEffect(() => { Promise.resolve().then(refresh) }, [refresh])

  const enableFileTools = useCallback((mode) => {
    dispatch({
      type: 'SET_TOOLS_CONFIG',
      payload: {
        list_directory: true,
        read_file: true,
        ...(mode === 'read_write' ? { write_file: true, edit_file: true } : {}),
      },
    })
  }, [dispatch])

  const grantPath = async (selectedPath = pathValue) => {
    if (!selectedPath.trim()) return
    setBusy('grant')
    setMessage('')
    try {
      const data = await grantLocalPathApi({ path: selectedPath.trim(), accessMode })
      applyStatus(setStatus, data)
      enableFileTools(accessMode)
      setPathValue('')
      setMessage(t('localFiles.granted'))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy('')
    }
  }

  const pickAndGrant = async () => {
    setBusy('picker')
    setMessage(t('localFiles.pickerWaiting'))
    try {
      const selected = await pickLocalDirectoryApi()
      if (selected.path) await grantPath(selected.path)
      else setMessage(t('localFiles.pickerCancelled'))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy('')
    }
  }

  const revoke = async (id) => {
    setBusy(id)
    try {
      const data = await revokeLocalPathApi(id)
      applyStatus(setStatus, data)
      setMessage(t('localFiles.revoked'))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy('')
    }
  }

  const toggleAllFiles = async () => {
    const enabled = !status?.allFilesEnabled
    if (enabled && !window.confirm(t('localFiles.allConfirm'))) return
    setBusy('all')
    try {
      const data = await setAllFilesAccessApi(enabled)
      applyStatus(setStatus, data)
      if (enabled) enableFileTools('read_write')
      setMessage(enabled ? t('localFiles.allEnabled') : t('localFiles.allDisabled'))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy('')
    }
  }

  const copyPath = async (value) => {
    try {
      await navigator.clipboard.writeText(value)
      setMessage(t('localFiles.copied'))
    } catch {
      setMessage(t('localFiles.copyFailed'))
    }
  }

  return (
    <section className="flex flex-col gap-5 animate-float-up">
      <div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">LOCAL FILES</span>
        <h1 className="font-hand text-[28px] text-ink mt-1.5">{t('localFiles.title')}</h1>
        <p className="text-sm text-ink-soft mt-1 max-w-3xl">{t('localFiles.subtitle')}</p>
      </div>

      <div className="p-4 border border-ink/30 rounded-md bg-paper flex gap-3">
        <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
        <div>
          <div className="text-sm text-ink">{t('localFiles.securityTitle')}</div>
          <p className="text-xs text-ink-soft mt-1">{t('localFiles.securityHint')}</p>
        </div>
      </div>

      <div className="p-4 border border-ink/30 rounded-md flex flex-col gap-4">
        <div>
          <h2 className="font-hand text-lg text-ink">{t('localFiles.addTitle')}</h2>
          <p className="text-xs text-ink-soft mt-1">{t('localFiles.addHint')}</p>
        </div>
        <div className="flex flex-col md:flex-row gap-2">
          <input
            value={pathValue}
            onChange={(event) => setPathValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') grantPath() }}
            placeholder={t('localFiles.pathPlaceholder')}
            className="h-10 flex-1 min-w-0 px-3 rounded-md border border-ink-fade/50 bg-paper outline-none focus:border-ink text-sm text-ink font-mono"
          />
          <select
            value={accessMode}
            onChange={(event) => setAccessMode(event.target.value)}
            className="h-10 px-3 rounded-md border border-ink-fade/50 bg-paper text-sm text-ink"
            aria-label={t('localFiles.accessMode')}
          >
            <option value="read_write">{t('localFiles.readWrite')}</option>
            <option value="read_only">{t('localFiles.readOnly')}</option>
          </select>
          <button
            type="button"
            onClick={() => grantPath()}
            disabled={!!busy || !pathValue.trim()}
            className="h-10 px-4 rounded-md bg-ink text-paper text-sm disabled:opacity-40"
          >
            {busy === 'grant' ? t('localFiles.authorizing') : t('localFiles.authorize')}
          </button>
        </div>
        {status?.runtime?.pickerAvailable && (
          <button
            type="button"
            onClick={pickAndGrant}
            disabled={!!busy}
            className="h-10 px-4 rounded-md border border-ink/60 text-sm text-ink self-start flex items-center gap-2 hover:bg-paper-2 disabled:opacity-40"
          >
            {busy === 'picker' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
            {t('localFiles.pickFolder')}
          </button>
        )}
      </div>

      <div className={`p-4 rounded-md border ${status?.allFilesEnabled ? 'border-ember-line bg-ember-soft/30' : 'border-ink/30'} flex items-center justify-between gap-4`}>
        <div className="flex gap-3 min-w-0">
          <AlertTriangle className={`w-5 h-5 shrink-0 mt-0.5 ${status?.allFilesEnabled ? 'text-ember' : 'text-ink-fade'}`} />
          <div>
            <div className="text-sm text-ink">{t('localFiles.allTitle')}</div>
            <p className="text-xs text-ink-soft mt-1">{t('localFiles.allHint')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={toggleAllFiles}
          disabled={!status || !!busy}
          aria-pressed={!!status?.allFilesEnabled}
          className={`h-9 px-4 rounded-md text-sm shrink-0 border disabled:opacity-40 ${status?.allFilesEnabled ? 'border-ember-line text-ember bg-paper' : 'border-ink/60 text-ink'}`}
        >
          {status?.allFilesEnabled ? t('localFiles.disable') : t('localFiles.enable')}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-hand text-lg text-ink">{t('localFiles.authorizedTitle')}</h2>
          <span className="text-xs text-ink-fade">{status?.grants?.length || 0}</span>
        </div>
        {status?.workspace?.enabled && (
          <div className="p-3 border border-emerald-500/30 bg-emerald-50/60 rounded-md flex items-center gap-3">
            <Check className="w-4 h-4 text-emerald-700" />
            <div className="min-w-0 flex-1"><div className="text-xs text-emerald-800">WORKSPACE_ROOT</div><div className="font-mono text-xs text-ink truncate">{status.workspace.path}</div></div>
            <button type="button" onClick={() => copyPath(status.workspace.path)} className="p-2 text-ink-soft" aria-label={t('localFiles.copy')}><Copy className="w-4 h-4" /></button>
          </div>
        )}
        {status?.grants?.map((grant) => {
          const Icon = grant.resourceType === 'directory' ? Folder : FileText
          return (
            <div key={grant.id} className="p-3 border border-ink/20 rounded-md flex items-center gap-3">
              <span className="w-9 h-9 rounded-full border border-ink-fade/30 bg-paper-2 flex items-center justify-center shrink-0"><Icon className="w-4 h-4 text-ink-soft" /></span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-ink break-all">{grant.path}</div>
                <div className="text-[11px] text-ink-fade mt-1">{grant.accessMode === 'read_write' ? t('localFiles.readWrite') : t('localFiles.readOnly')} · {grant.available ? t('localFiles.available') : t('localFiles.unavailable')}</div>
              </div>
              <button type="button" onClick={() => copyPath(grant.path)} className="p-2 text-ink-soft hover:text-ink" aria-label={t('localFiles.copy')}><Copy className="w-4 h-4" /></button>
              <button type="button" onClick={() => revoke(grant.id)} disabled={!!busy} className="p-2 text-ink-soft hover:text-ember disabled:opacity-40" aria-label={t('localFiles.revoke')}><Trash2 className="w-4 h-4" /></button>
            </div>
          )
        })}
        {status && !status.workspace?.enabled && status.grants.length === 0 && !status.allFilesEnabled && (
          <div className="p-6 border border-dashed border-ink-fade/40 rounded-md text-center text-sm text-ink-soft">{t('localFiles.empty')}</div>
        )}
      </div>

      {message && <div className="p-3 border border-ink-fade/40 rounded-md bg-paper-2 text-sm text-ink-soft">{message}</div>}
    </section>
  )
}

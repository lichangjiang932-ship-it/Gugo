import { FolderOpen, LoaderCircle, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import InlineDirectoryBrowser from '../InlineDirectoryBrowser.jsx'
import {
  getLocalFileAccessApi,
  setDefaultOutputDirectoryApi,
} from '../../lib/localFileAccessClient.js'

export default function SettingsFileOutputPanel({ t }) {
  const [path, setPath] = useState('')
  const [projectDirectory, setProjectDirectory] = useState('')
  const [browserOpen, setBrowserOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState({ type: '', text: '' })

  useEffect(() => {
    let active = true
    getLocalFileAccessApi().then((status) => {
      if (!active) return
      setPath(status.defaultOutputDirectory || status.projectDirectory || '')
      setProjectDirectory(status.projectDirectory || '')
      setMessage({ type: '', text: '' })
    }).catch((error) => {
      if (active) setMessage({ type: 'error', text: error?.message || t('fileOutput.loadFailed') })
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [t])

  const save = async () => {
    if (!path.trim() || saving) return
    setSaving(true)
    setMessage({ type: '', text: '' })
    try {
      const status = await setDefaultOutputDirectoryApi(path.trim())
      setPath(status.defaultOutputDirectory || path.trim())
      setProjectDirectory(status.projectDirectory || projectDirectory)
      setMessage({ type: 'success', text: t('fileOutput.saved') })
    } catch (error) {
      setMessage({ type: 'error', text: error?.message || t('fileOutput.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-col gap-5 animate-float-up" data-testid="settings-file-output">
      <div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">FILES</span>
        <h1 className="mt-1.5 text-[28px] font-semibold text-ink">{t('fileOutput.title')}</h1>
        <p className="mt-1 text-sm text-ink-soft">{t('fileOutput.subtitle')}</p>
      </div>

      <div className="rounded-md border border-ink/20 p-4">
        <label htmlFor="default-output-directory" className="text-sm font-medium text-ink">{t('fileOutput.defaultDirectory')}</label>
        <p className="mt-1 text-xs leading-relaxed text-ink-fade">{t('fileOutput.defaultDirectoryHint')}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            id="default-output-directory"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
            }}
            disabled={loading || saving}
            placeholder={projectDirectory || t('fileOutput.pathPlaceholder')}
            className="h-10 min-w-0 flex-1 rounded-md border border-ink/20 bg-paper px-3 font-mono text-xs text-ink outline-none focus:border-ember disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => setBrowserOpen((open) => !open)}
            disabled={loading || saving}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-ink/20 px-3 text-sm text-ink-soft disabled:opacity-50"
          >
            <FolderOpen className="h-4 w-4" />
            {t('fileOutput.browse')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading || saving || !path.trim()}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-ember px-4 text-sm text-paper disabled:opacity-50"
          >
            {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t(saving ? 'fileOutput.saving' : 'fileOutput.save')}
          </button>
        </div>
        {browserOpen && (
          <InlineDirectoryBrowser
            initialPath={path || projectDirectory}
            onSelect={(selectedPath) => {
              setPath(selectedPath)
              setBrowserOpen(false)
            }}
            onCancel={() => setBrowserOpen(false)}
            t={t}
          />
        )}
        {message.text && (
          <p className={`mt-3 text-xs ${message.type === 'error' ? 'text-red-600' : 'text-emerald-700'}`} role="status">
            {message.text}
          </p>
        )}
      </div>

      <div className="rounded-md border border-dashed border-ink/20 bg-paper-2/50 p-4 text-xs leading-relaxed text-ink-soft">
        <p>{t('fileOutput.priorityHint')}</p>
        {projectDirectory && <p className="mt-2 font-mono text-[11px] text-ink-fade">{t('fileOutput.projectDirectory')}: {projectDirectory}</p>}
      </div>
    </section>
  )
}

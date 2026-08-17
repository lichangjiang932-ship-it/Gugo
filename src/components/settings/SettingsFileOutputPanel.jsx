import { FolderOpen, LoaderCircle, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import InlineDirectoryBrowser from '../InlineDirectoryBrowser.jsx'
import {
  getLocalFileAccessApi,
  setDefaultOutputDirectoryApi,
} from '../../lib/localFileAccessClient.js'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPrimitives.jsx'

export default function SettingsFileOutputPanel({ compact = false, t }) {
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

  const content = (
    <SettingsGroup
      title={compact ? t('fileOutput.title') : undefined}
      description={compact ? t('fileOutput.subtitle') : undefined}
    >
      <SettingsRow
        title={t('fileOutput.defaultDirectory')}
        description={t('fileOutput.defaultDirectoryHint')}
        align="start"
      >
        <div className="flex min-w-0 max-w-[370px] flex-1 flex-wrap justify-end gap-2">
          <input
            id="default-output-directory"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
            }}
            disabled={loading || saving}
            placeholder={projectDirectory || t('fileOutput.pathPlaceholder')}
            className="settings-input min-w-[180px] flex-1 font-mono disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => setBrowserOpen((open) => !open)}
            disabled={loading || saving}
            className="settings-action-button"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t('fileOutput.browse')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={loading || saving || !path.trim()}
            className="settings-action-button settings-action-button-primary"
          >
            {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t(saving ? 'fileOutput.saving' : 'fileOutput.save')}
          </button>
        </div>
      </SettingsRow>
      {browserOpen ? (
        <div className="p-3">
          <InlineDirectoryBrowser
            initialPath={path || projectDirectory}
            onSelect={(selectedPath) => {
              setPath(selectedPath)
              setBrowserOpen(false)
            }}
            onCancel={() => setBrowserOpen(false)}
            t={t}
          />
        </div>
      ) : null}
      {message.text ? (
        <p className={`px-4 py-2 text-xs ${message.type === 'error' ? 'text-red-600' : 'text-emerald-700'}`} role="status">
          {message.text}
        </p>
      ) : null}
      <SettingsRow title={t('fileOutput.projectDirectory')} description={t('fileOutput.priorityHint')}>
        <span className="settings-link-value">{projectDirectory || '—'}</span>
      </SettingsRow>
    </SettingsGroup>
  )

  if (compact) return <div data-testid="settings-file-output">{content}</div>
  return (
    <SettingsPanel title={t('fileOutput.title')} description={t('fileOutput.subtitle')} testId="settings-file-output">
      {content}
    </SettingsPanel>
  )
}

import { Check, Folder, FolderRoot, LoaderCircle, RefreshCw, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { browseLocalDirectoriesApi } from '../lib/localFileAccessClient.js'

export default function InlineDirectoryBrowser({
  initialPath = '',
  onSelect,
  onCancel,
  t,
  browseDirectories = browseLocalDirectoriesApi,
  neutral = false,
}) {
  const [directory, setDirectory] = useState(null)
  const [path, setPath] = useState(String(initialPath || ''))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const openDirectory = useCallback(async (nextPath = '') => {
    setLoading(true)
    setError('')
    try {
      const result = await browseDirectories(String(nextPath || ''))
      const next = result?.directory || result
      if (!next?.currentPath) throw new Error(t('taskSteering.directoryBrowserLoadFailed'))
      setDirectory(next)
      setPath(next.currentPath)
    } catch (cause) {
      setError(cause?.message || t('taskSteering.directoryBrowserLoadFailed'))
    } finally {
      setLoading(false)
    }
  }, [browseDirectories, t])

  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => {
      if (active) void openDirectory(initialPath)
    })
    return () => { active = false }
  }, [initialPath, openDirectory])

  return (
    <div className={`mt-2 rounded-md border bg-paper p-2.5 ${neutral ? 'border-ink/10' : 'border-accent/25'}`} data-testid="inline-directory-browser">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && path.trim() && !loading) void openDirectory(path)
          }}
          aria-label={t('taskSteering.directoryBrowserPath')}
          className={`h-9 min-w-0 flex-1 rounded-md border border-ink/15 bg-paper px-3 font-mono text-xs text-ink outline-none ${neutral ? 'focus:border-ink/35' : 'focus:border-accent/50'}`}
        />
        <button
          type="button"
          onClick={() => void openDirectory(path)}
          disabled={loading || !path.trim()}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-ink/15 px-3 text-xs text-ink-soft disabled:opacity-50"
        >
          {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('taskSteering.directoryBrowserOpen')}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => void openDirectory(directory?.parentPath)}
          disabled={loading || !directory?.parentPath}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/10 px-2.5 text-xs text-ink-soft disabled:opacity-40"
        >
          <Undo2 className="h-3.5 w-3.5" />
          {t('taskSteering.directoryBrowserParent')}
        </button>
        <button
          type="button"
          onClick={() => void openDirectory(directory?.projectDirectory)}
          disabled={loading || !directory?.projectDirectory}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/10 px-2.5 text-xs text-ink-soft disabled:opacity-40"
        >
          <FolderRoot className="h-3.5 w-3.5" />
          {t('taskSteering.directoryBrowserProject')}
        </button>
        {directory?.defaultOutputDirectory && directory.defaultOutputDirectory !== directory.projectDirectory && (
          <button
            type="button"
            onClick={() => void openDirectory(directory.defaultOutputDirectory)}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/10 px-2.5 text-xs text-ink-soft disabled:opacity-40"
          >
            <Folder className="h-3.5 w-3.5" />
            {t('taskSteering.directoryBrowserDefault')}
          </button>
        )}
      </div>

      <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-ink/10" role="list">
        {!loading && (directory?.entries || []).map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => void openDirectory(entry.path)}
            className={`flex w-full items-center gap-2 border-b border-ink/5 px-3 py-2 text-left text-xs text-ink-soft last:border-b-0 hover:text-ink ${neutral ? 'hover:bg-ink/[0.025]' : 'hover:bg-accent/5'}`}
            role="listitem"
          >
            <Folder className={`h-3.5 w-3.5 shrink-0 ${neutral ? 'text-ink-fade' : 'text-accent-ink'}`} />
            <span className="truncate">{entry.name}</span>
          </button>
        ))}
        {!loading && !error && (directory?.entries || []).length === 0 && (
          <p className="px-3 py-5 text-center text-xs text-ink-fade">{t('taskSteering.directoryBrowserEmpty')}</p>
        )}
        {loading && (
          <div className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-ink-fade">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t('taskSteering.directoryBrowserLoading')}
          </div>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-8 rounded-md border border-ink/15 px-3 text-xs text-ink-soft">
            {t('common.cancel')}
          </button>
        )}
        <button
          type="button"
          onClick={() => onSelect?.(directory?.currentPath || path.trim())}
          disabled={loading || !directory?.currentPath}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs disabled:opacity-50 ${neutral ? 'bg-ink text-paper hover:bg-ink-soft' : 'bg-accent text-white'}`}
        >
          <Check className="h-3.5 w-3.5" />
          {t('taskSteering.directoryBrowserSelectCurrent')}
        </button>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import { getWorkbenchDiff, getWorkbenchStatus } from '../../../lib/workbenchClient.js'

// Porcelain status codes. Anything else falls back to the raw code so an
// uncommon state is shown rather than silently labelled as something else.
const STATUS_KEYS = {
  M: 'workbench.gitModified',
  A: 'workbench.gitAdded',
  D: 'workbench.gitDeleted',
  R: 'workbench.gitRenamed',
  C: 'workbench.gitCopied',
  U: 'workbench.gitConflicted',
}

const MAX_DIFF_LINES = 2_000

function statusKey(code) {
  const value = String(code || '').trim()
  if (!value || value === '??') return 'workbench.gitUntracked'
  return STATUS_KEYS[value[0].toUpperCase()] || ''
}

function diffLineClass(line) {
  if (line.startsWith('@@')) return 'text-accent-ink'
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-ink-fade'
  if (line.startsWith('+')) return 'text-success'
  if (line.startsWith('-')) return 'text-danger'
  return 'text-ink-soft'
}

function DiffBody({ diff, t }) {
  if (!diff) return <p className="px-2 py-3 text-xs leading-5 text-ink-fade">{t('workbench.gitSelectFile')}</p>
  const lines = String(diff).split('\n')
  const shown = lines.slice(0, MAX_DIFF_LINES)
  return (
    <div className="min-h-0 flex-1 overflow-auto border-t border-ink/10 px-2 py-2" data-testid="workbench-git-diff">
      {shown.map((line, index) => (
        <pre key={index} className={`whitespace-pre-wrap break-all font-mono text-xs leading-5 ${diffLineClass(line)}`}>{line || ' '}</pre>
      ))}
      {lines.length > shown.length && (
        <p className="mt-2 text-xs text-ink-fade">{t('workbench.gitDiffTruncated', { shown: shown.length, total: lines.length })}</p>
      )}
    </div>
  )
}

export default function WorkbenchGit({ t }) {
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [diff, setDiff] = useState('')
  const [diffError, setDiffError] = useState('')

  const loadStatus = useCallback(async () => {
    // Nothing is set before the request: this also runs from the mount effect,
    // where a synchronous state update is disallowed.
    try {
      const value = await getWorkbenchStatus()
      setStatus(value)
      setStatusError('')
    } catch (error) {
      setStatus(null)
      setStatusError(error?.message || String(error))
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time async fetch; state updates happen after the request settles.
  useEffect(() => { void loadStatus() }, [loadStatus])

  // Only the button marks a refresh busy, so the mount path stays free of a
  // synchronous state update.
  const refresh = useCallback(async () => {
    setBusy(true)
    try { await loadStatus() } finally { setBusy(false) }
  }, [loadStatus])

  const openFile = useCallback(async (path) => {
    setSelectedPath(path)
    setDiff('')
    setDiffError('')
    try {
      const value = await getWorkbenchDiff({ path })
      setDiff(String(value?.diff || ''))
    } catch (error) {
      setDiffError(error?.message || String(error))
    }
  }, [])

  const files = status?.files || []
  // The selected file is derived, not synchronised: once a refresh stops listing
  // it, its diff stops rendering instead of lingering beside a list without it.
  const selectedFile = files.find((file) => file.path === selectedPath) || null
  return (
    <section data-testid="workbench-git" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-ink/10 px-2 py-2">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink" title={status?.branch || undefined}>
          {status?.branch || t('workbench.gitBranchUnknown')}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          data-testid="workbench-git-refresh"
          aria-label={t('workbench.gitRefresh')}
          title={t('workbench.gitRefresh')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {statusError && (
        <p role="alert" data-testid="workbench-git-error" className="px-3 py-3 text-xs leading-5 text-danger">
          {t('workbench.gitUnavailable')}
          <span className="mt-1 block break-words text-ink-fade">{statusError}</span>
        </p>
      )}

      {!statusError && (
        <div className="max-h-56 min-h-0 shrink-0 overflow-y-auto px-2 py-2">
          {files.length === 0
            ? <p className="px-1 py-2 text-xs leading-5 text-ink-fade">{status ? t('workbench.gitClean') : t('workbench.gitLoading')}</p>
            : <>
              <h3 className="mb-1 px-1 text-xs font-semibold text-ink">{t('workbench.gitChangedFiles')}</h3>
              {files.map((file) => (
                <button
                  key={`${file.status}:${file.path}`}
                  type="button"
                  data-testid="workbench-git-file"
                  onClick={() => void openFile(file.path)}
                  aria-current={selectedFile?.path === file.path ? 'true' : undefined}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-ink/5 ${selectedFile?.path === file.path ? 'bg-ink/[0.06]' : ''}`}
                >
                  <span className="w-6 shrink-0 font-mono text-xs uppercase text-ink-fade">{String(file.status || '').trim() || '?'}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink" title={file.path}>{file.path}</span>
                  {statusKey(file.status) && <span className="shrink-0 text-xs text-ink-fade">{t(statusKey(file.status))}</span>}
                </button>
              ))}
            </>}
        </div>
      )}

      {diffError && selectedFile && (
        <p role="alert" data-testid="workbench-git-diff-error" className="px-3 py-2 text-xs leading-5 text-danger">
          {t('workbench.gitDiffUnavailable')}
          <span className="mt-1 block break-words text-ink-fade">{diffError}</span>
        </p>
      )}
      {!diffError && <DiffBody diff={selectedFile ? diff : ''} t={t} />}
    </section>
  )
}

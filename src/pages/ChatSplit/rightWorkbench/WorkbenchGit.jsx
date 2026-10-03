import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import {
  commitWorkbenchChanges,
  getWorkbenchDiff,
  getWorkbenchStatus,
  pushWorkbenchBranch,
} from '../../../lib/workbenchClient.js'

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
// The server refuses a message outside this range; the field says so before the
// reader finds out by pressing the button.
const MIN_MESSAGE_LENGTH = 3
const MAX_MESSAGE_LENGTH = 200

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

const ACTION_BUTTON = 'flex h-8 shrink-0 items-center rounded-control px-3 text-xs transition-colors disabled:cursor-default disabled:opacity-40'

/**
 * The changes panel: what changed, what each change is, and what to do with it.
 *
 * Until now it could only look. Committing from here is the point of the page —
 * the reader reviews a diff and then has to leave for a terminal to do anything
 * about it, which is where unreviewed `git add -A` habits come from. The panel
 * never chooses for the reader: files are named explicitly (the server refuses a
 * file that is not changed, so a stale selection cannot commit the wrong thing),
 * the message is typed rather than guessed, and pushing stays a separate,
 * deliberate press.
 */
export default function WorkbenchGit({ t }) {
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const [diff, setDiff] = useState('')
  const [diffError, setDiffError] = useState('')
  const [chosen, setChosen] = useState(() => new Set())
  const [message, setMessage] = useState('')
  const [action, setAction] = useState('')
  const [notice, setNotice] = useState(null)

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

  // Same for what is about to be committed: a path the tree no longer lists is
  // dropped from the plan rather than sent back to a server that would refuse it.
  // `status` is the dependency, not the array derived from it, so the memo does
  // not recompute on every render.
  const chosenPaths = useMemo(() => {
    const changed = new Set((status?.files || []).map((file) => file.path))
    return new Set([...chosen].filter((path) => changed.has(path)))
  }, [chosen, status])

  const toggleChosen = (path) => setChosen((current) => {
    const next = new Set(current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  const messageReady = message.trim().length >= MIN_MESSAGE_LENGTH
  const canCommit = chosenPaths.size > 0 && messageReady && !action
  const allChosen = files.length > 0 && chosenPaths.size === files.length

  const submitCommit = async (event) => {
    event.preventDefault()
    if (!canCommit) return
    setAction('commit')
    setNotice(null)
    try {
      const result = await commitWorkbenchChanges({ message: message.trim(), files: [...chosenPaths] })
      setMessage('')
      setChosen(new Set())
      setSelectedPath('')
      setDiff('')
      setNotice({ kind: 'ok', text: t('workbench.gitCommitDone', { commit: String(result?.commit || '').slice(0, 8) }) })
      await loadStatus()
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || String(error) })
    } finally {
      setAction('')
    }
  }

  const push = async () => {
    if (action) return
    setAction('push')
    setNotice(null)
    try {
      const result = await pushWorkbenchBranch()
      setNotice({ kind: 'ok', text: t('workbench.gitPushDone', { branch: result?.branch || '' }) })
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || String(error) })
    } finally {
      setAction('')
    }
  }

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
          disabled={busy || Boolean(action)}
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
                <div key={`${file.status}:${file.path}`} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={chosenPaths.has(file.path)}
                    onChange={() => toggleChosen(file.path)}
                    disabled={Boolean(action)}
                    data-testid="workbench-git-choose"
                    data-path={file.path}
                    aria-label={t('workbench.gitChooseFile', { path: file.path })}
                    className="ml-1 h-3.5 w-3.5 shrink-0 accent-accent"
                  />
                  <button
                    type="button"
                    data-testid="workbench-git-file"
                    onClick={() => void openFile(file.path)}
                    aria-current={selectedFile?.path === file.path ? 'true' : undefined}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-ink/5 ${selectedFile?.path === file.path ? 'bg-ink/[0.06]' : ''}`}
                  >
                    <span className="w-6 shrink-0 font-mono text-xs uppercase text-ink-fade">{String(file.status || '').trim() || '?'}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-ink" title={file.path}>{file.path}</span>
                    {statusKey(file.status) && <span className="shrink-0 text-xs text-ink-fade">{t(statusKey(file.status))}</span>}
                  </button>
                </div>
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

      {!statusError && files.length > 0 && (
        <form onSubmit={submitCommit} className="shrink-0 border-t border-ink/10 px-2 py-2" data-testid="workbench-git-actions">
          <div className="flex items-center gap-2 pb-1.5">
            <span className="min-w-0 flex-1 truncate text-xs text-ink-fade" data-testid="workbench-git-chosen-count">
              {t('workbench.gitChosenCount', { count: chosenPaths.size })}
            </span>
            <button
              type="button"
              onClick={() => (allChosen ? setChosen(new Set()) : setChosen(new Set(files.map((file) => file.path))))}
              disabled={Boolean(action)}
              data-testid="workbench-git-choose-all"
              className="shrink-0 rounded-control px-1.5 py-0.5 text-xs text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-40"
            >
              {t(allChosen ? 'workbench.gitChooseNone' : 'workbench.gitChooseAll')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={MAX_MESSAGE_LENGTH}
              disabled={Boolean(action)}
              data-testid="workbench-git-message"
              aria-label={t('workbench.gitCommitMessage')}
              placeholder={t('workbench.gitCommitMessageHint')}
              className="h-8 min-w-0 flex-1 rounded-control border border-ink/15 bg-paper px-2 text-xs text-ink outline-none transition-colors focus:border-ink/40"
            />
            <button
              type="submit"
              disabled={!canCommit}
              data-testid="workbench-git-commit"
              className={`${ACTION_BUTTON} bg-ink font-medium text-paper`}
            >
              {t('workbench.gitCommit')}
            </button>
            <button
              type="button"
              onClick={() => void push()}
              disabled={Boolean(action) || !status?.branch}
              data-testid="workbench-git-push"
              className={`${ACTION_BUTTON} border border-ink/15 text-ink-soft hover:bg-ink/5`}
            >
              {t('workbench.gitPush')}
            </button>
          </div>
          {notice && (
            <p
              role={notice.kind === 'error' ? 'alert' : 'status'}
              data-testid="workbench-git-notice"
              className={`mt-1.5 break-words text-xs leading-5 ${notice.kind === 'error' ? 'text-danger' : 'text-success'}`}
            >
              {notice.text}
            </p>
          )}
        </form>
      )}
    </section>
  )
}

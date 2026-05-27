import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, GitBranch, Play, RefreshCw, UploadCloud } from 'lucide-react'
import {
  commitWorkbenchChanges,
  getWorkbenchDiff,
  getWorkbenchStatus,
  pushWorkbenchBranch,
  runWorkbenchCheck,
} from '../../lib/workbenchClient.js'
import { useT } from '../../i18n/I18nProvider.jsx'

const CHECKS = [
  { id: 'lint', labelKey: 'codingWorkbench.runLint' },
  { id: 'test', labelKey: 'codingWorkbench.runTests' },
  { id: 'build', labelKey: 'codingWorkbench.runBuild' },
]

function statusLabel(status, t) {
  if (!status) return ''
  if (status.includes('??')) return t('codingWorkbench.statusNew')
  if (status.includes('D')) return t('codingWorkbench.statusDeleted')
  if (status.includes('M')) return t('codingWorkbench.statusModified')
  if (status.includes('A')) return t('codingWorkbench.statusAdded')
  if (status.includes('R')) return t('codingWorkbench.statusRenamed')
  return status.trim() || t('codingWorkbench.statusChanged')
}

export default function CodingWorkbench({ onMessage }) {
  const { t } = useT()
  const [status, setStatus] = useState(null)
  const [diff, setDiff] = useState(null)
  const [selectedFiles, setSelectedFiles] = useState([])
  const [commitMessage, setCommitMessage] = useState(() => t('codingWorkbench.defaultCommitMessage'))
  const [checkRuns, setCheckRuns] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const files = status?.files || []
  const selectedSet = useMemo(() => new Set(selectedFiles), [selectedFiles])
  const canCommit = selectedFiles.length > 0 && commitMessage.trim().length >= 3 && !busy

  async function refresh() {
    setBusy('refresh')
    setError('')
    try {
      const nextStatus = await getWorkbenchStatus()
      setStatus(nextStatus)
      setSelectedFiles((current) => {
        const nextPaths = (nextStatus.files || []).map((f) => f.path)
        const kept = current.filter((p) => nextPaths.includes(p))
        return kept.length ? kept : nextPaths
      })
      setDiff(await getWorkbenchDiff())
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { refresh() }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  async function refreshDiffFor(path) {
    setBusy(`diff:${path || 'all'}`)
    setError('')
    try {
      setDiff(await getWorkbenchDiff(path ? { path } : {}))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  function toggleFile(filePath) {
    setSelectedFiles((current) => current.includes(filePath)
      ? current.filter((p) => p !== filePath)
      : [...current, filePath])
  }

  async function runCheck(check) {
    setBusy(`check:${check}`)
    setError('')
    try {
      const result = await runWorkbenchCheck(check)
      setCheckRuns((current) => [{ ...result, at: Date.now() }, ...current].slice(0, 6))
      onMessage?.(t(result.ok ? 'codingWorkbench.checkPassed' : 'codingWorkbench.checkFailed', { command: result.command }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  async function commitAndPush() {
    if (!canCommit) return
    setBusy('commit')
    setError('')
    try {
      const commit = await commitWorkbenchChanges({ message: commitMessage.trim(), files: selectedFiles })
      setBusy('push')
      const push = await pushWorkbenchBranch()
      onMessage?.(t('codingWorkbench.committedAndPushed', {
        commit: commit.commit.slice(0, 7),
        remote: push.remote,
        branch: push.branch,
      }))
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <aside className="w-[520px] shrink-0 bg-paper-2 border-l border-dashed border-ink-fade/50 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-dashed border-ink-fade/40 bg-paper flex items-center gap-3">
        <div className="w-8 h-8 rounded-md bg-ink text-paper flex items-center justify-center">
          <GitBranch className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">{t('codingWorkbench.title')}</div>
          <div className="text-sm text-ink truncate">
            {status?.branch || t('codingWorkbench.workspace')} · {status?.clean ? t('codingWorkbench.clean') : t('codingWorkbench.changedCount', { count: files.length })}
          </div>
        </div>
        <button onClick={refresh} disabled={!!busy} className="w-8 h-8 rounded-md border border-ink-fade/40 flex items-center justify-center text-ink-soft hover:text-ember disabled:opacity-50" title={t('codingWorkbench.refreshGitStatus')}>
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-4 overflow-y-auto flex-1 min-h-0 space-y-4">
        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 text-red-700 text-xs p-3 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <section className="rounded-md border border-ink/15 bg-paper p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-hand text-lg text-ink">{t('codingWorkbench.changedFiles')}</h3>
            <button onClick={() => setSelectedFiles(files.map((f) => f.path))} className="text-[11px] text-ember">{t('codingWorkbench.selectAll')}</button>
          </div>
          {files.length === 0 ? (
            <p className="text-xs text-ink-fade">{t('codingWorkbench.noGitChanges')}</p>
          ) : (
            <div className="space-y-1.5">
              {files.map((file) => (
                <div key={file.path} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={selectedSet.has(file.path)} onChange={() => toggleFile(file.path)} />
                  <button onClick={() => refreshDiffFor(file.path)} className="flex-1 min-w-0 text-left truncate text-ink hover:text-ember" title={file.path}>
                    {file.path}
                  </button>
                  <span className="font-mono text-[10px] text-ink-fade">{statusLabel(file.status, t)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-md border border-ink/15 bg-paper p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-hand text-lg text-ink">{t('codingWorkbench.projectChecks')}</h3>
            <span className="text-[10px] text-ink-fade">{t('codingWorkbench.allowlistOnly')}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {CHECKS.map((item) => (
              <button key={item.id} onClick={() => runCheck(item.id)} disabled={!!busy} className="h-8 rounded-md border border-ink-fade/40 text-[11px] text-ink-soft hover:text-ember hover:border-ember/50 disabled:opacity-50 inline-flex items-center justify-center gap-1">
                <Play className="w-3 h-3" />
                {t(item.labelKey)}
              </button>
            ))}
          </div>
          {checkRuns.length > 0 && (
            <div className="mt-3 space-y-2 max-h-44 overflow-auto">
              {checkRuns.map((run) => (
                <div key={`${run.check}:${run.at}`} className="rounded border border-dashed border-ink-fade/30 p-2 text-[11px]">
                  <div className="flex items-center gap-1.5 text-ink">
                    <CheckCircle2 className={`w-3.5 h-3.5 ${run.ok ? 'text-emerald-600' : 'text-red-600'}`} />
                    <span className="font-mono">{run.command}</span>
                    <span className="ml-auto text-ink-fade">{t('codingWorkbench.exitCode', { code: run.exitCode })}</span>
                  </div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-ink-fade">{run.stdout || run.stderr || t('codingWorkbench.noOutput')}</pre>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-md border border-ink/15 bg-paper p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-hand text-lg text-ink">{t('codingWorkbench.unifiedDiff')}</h3>
            <button onClick={() => refreshDiffFor('')} className="text-[11px] text-ember">{t('codingWorkbench.fullDiff')}</button>
          </div>
          <pre className="max-h-80 overflow-auto rounded bg-ink text-paper p-3 text-[11px] leading-relaxed whitespace-pre-wrap font-mono">
            {diff?.diff || diff?.stat || t('codingWorkbench.noDiffLoaded')}
          </pre>
        </section>
      </div>

      <div className="p-4 border-t border-dashed border-ink-fade/40 bg-paper space-y-2">
        <input
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          className="w-full h-9 px-3 rounded-md border border-ink/25 bg-paper-2 text-sm outline-none focus:border-ember"
          placeholder={t('codingWorkbench.commitPlaceholder')}
        />
        <button onClick={commitAndPush} disabled={!canCommit} className="w-full h-9 rounded-md bg-ember text-paper text-sm font-hand disabled:opacity-50 inline-flex items-center justify-center gap-2">
          <UploadCloud className="w-4 h-4" />
          {t('codingWorkbench.commitAndPush')}
        </button>
        <p className="text-[11px] text-ink-fade">{t('codingWorkbench.mutationHint')}</p>
      </div>
    </aside>
  )
}

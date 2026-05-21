import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, CheckCircle2, GitBranch, Play, RefreshCw, UploadCloud, Terminal, FileCode, Bug, Wrench, XCircle, ChevronDown, ChevronRight, FileDiff, FileCheck } from 'lucide-react'
import {
  commitWorkbenchChanges, getWorkbenchDiff, getWorkbenchStatus, pushWorkbenchBranch, runWorkbenchCheck,
} from '../../lib/workbenchClient.js'

const CHECKS = [
  { id: 'lint', label: 'npm run lint', icon: FileCheck },
  { id: 'test', label: 'npm run test', icon: Bug },
  { id: 'build', label: 'npm run build', icon: Wrench },
]

function statusLabel(status) {
  if (!status) return ''
  if (status.includes('??')) return 'new'
  if (status.includes('D')) return 'deleted'
  if (status.includes('M')) return 'modified'
  if (status.includes('A')) return 'added'
  if (status.includes('R')) return 'renamed'
  return status.trim() || 'changed'
}

function statusColor(status) {
  if (!status) return '#8A7B68'
  if (status.includes('??')) return '#5B8FA3'
  if (status.includes('D')) return '#A55B5B'
  if (status.includes('M')) return '#8B7B30'
  if (status.includes('A')) return '#5B8B6B'
  return '#8A7B68'
}

export default function CodingWorkbench({ onMessage }) {
  const [status, setStatus] = useState(null)
  const [diff, setDiff] = useState(null)
  const [selectedFiles, setSelectedFiles] = useState([])
  const [commitMessage, setCommitMessage] = useState('feat: update from workbench')
  const [checkRuns, setCheckRuns] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('files')
  const [diffExpanded, setDiffExpanded] = useState(true)

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
    } catch (err) { setError(err.message) }
    finally { setBusy('') }
  }

  useEffect(() => { const t = window.setTimeout(() => refresh(), 0); return () => window.clearTimeout(t) }, [])

  async function refreshDiffFor(path) {
    setBusy(`diff:${path || 'all'}`); setError('')
    try { setDiff(await getWorkbenchDiff(path ? { path } : {})) }
    catch (err) { setError(err.message) }
    finally { setBusy('') }
  }

  function toggleFile(filePath) {
    setSelectedFiles((c) => c.includes(filePath) ? c.filter((p) => p !== filePath) : [...c, filePath])
  }

  async function runCheck(check) {
    setBusy(`check:${check}`); setError('')
    try {
      const result = await runWorkbenchCheck(check)
      setCheckRuns((c) => [{ ...result, at: Date.now() }, ...c].slice(0, 8))
      onMessage?.(result.ok ? `${result.command} passed` : `${result.command} failed`)
    } catch (err) { setError(err.message) }
    finally { setBusy('') }
  }

  async function commitAndPush() {
    if (!canCommit) return
    setBusy('commit'); setError('')
    try {
      const commit = await commitWorkbenchChanges({ message: commitMessage.trim(), files: selectedFiles })
      setBusy('push')
      const push = await pushWorkbenchBranch()
      onMessage?.(`Committed ${commit.commit.slice(0, 7)} and pushed ${push.remote}/${push.branch}`)
      await refresh()
    } catch (err) { setError(err.message) }
    finally { setBusy('') }
  }

  return (
    <aside className="w-[520px] shrink-0 bg-paper border-l border-ink-fade/15 flex flex-col min-h-0 shadow-lg">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-ink-fade/10 bg-paper-2/30 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-ink text-paper flex items-center justify-center shadow-sm">
          <Terminal className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ember">Coding Workbench</div>
          <div className="text-sm text-ink font-medium flex items-center gap-2">
            <GitBranch className="w-3 h-3 text-ink-fade" />
            <span className="truncate">{status?.branch || 'workspace'}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${status?.clean ? 'bg-emerald-50 text-emerald-700' : 'bg-ember-soft text-ember'} font-mono`}>
              {status?.clean ? 'clean' : `${files.length} changed`}
            </span>
          </div>
        </div>
        <button onClick={refresh} disabled={!!busy} className="w-8 h-8 rounded-lg border border-ink-fade/20 flex items-center justify-center text-ink-fade hover:text-ember hover:border-ember/30 disabled:opacity-40 transition-all" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-ink-fade/10 bg-paper-2/20">
        {[
          { id: 'files', label: '文件', icon: FileCode, count: files.length },
          { id: 'checks', label: '检查', icon: Wrench, count: checkRuns.length },
          { id: 'diff', label: 'Diff', icon: FileDiff },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium transition-all border-b-2 ${
              activeTab === tab.id ? 'border-ember text-ember' : 'border-transparent text-ink-fade hover:text-ink'
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
            {tab.count > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${activeTab === tab.id ? 'bg-ember-soft text-ember' : 'bg-paper-2 text-ink-fade'}`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="p-5 overflow-y-auto flex-1 min-h-0">
        {/* Error */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-xl border border-red-300/50 bg-red-50/30 text-red-700 text-xs p-3.5 flex gap-2 mb-4"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Files Tab */}
        {activeTab === 'files' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="section-label">CHANGED FILES</h3>
              <button onClick={() => setSelectedFiles(files.map((f) => f.path))} className="text-[11px] text-ember hover:text-ember/80 font-medium">全选</button>
            </div>
            {files.length === 0 ? (
              <div className="py-8 text-center">
                <FileCheck className="w-8 h-8 text-ink-fade/20 mx-auto mb-2" />
                <p className="text-xs text-ink-fade">工作区干净，没有修改</p>
              </div>
            ) : (
              <div className="space-y-1 stagger-children">
                {files.map((file, i) => (
                  <motion.div
                    key={file.path}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.03 }}
                    className="flex items-center gap-2.5 py-2 px-2.5 rounded-lg hover:bg-paper-2/40 transition-colors group"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(file.path)}
                      onChange={() => toggleFile(file.path)}
                      className="rounded border-ink-fade/30 text-ember focus:ring-ember"
                    />
                    <FileCode className="w-3.5 h-3.5 shrink-0" style={{ color: statusColor(file.status) }} />
                    <button
                      onClick={() => refreshDiffFor(file.path)}
                      className="flex-1 min-w-0 text-left truncate text-xs text-ink hover:text-ember transition-colors"
                      title={file.path}
                    >
                      {file.path}
                    </button>
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${statusColor(file.status)}12`, color: statusColor(file.status) }}>
                      {statusLabel(file.status)}
                    </span>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Checks Tab */}
        {activeTab === 'checks' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="section-label">PROJECT CHECKS</h3>
              <span className="text-[10px] text-ink-fade font-mono">allowlist only</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {CHECKS.map((item) => (
                <button
                  key={item.id}
                  onClick={() => runCheck(item.id)}
                  disabled={!!busy}
                  className="flex flex-col items-center gap-1.5 py-3 rounded-xl border border-ink-fade/15 text-[11px] text-ink-soft hover:text-ember hover:border-ember/30 hover:bg-ember-soft/10 disabled:opacity-40 transition-all"
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </button>
              ))}
            </div>
            <AnimatePresence>
              {checkRuns.length > 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-2"
                >
                  {checkRuns.map((run) => (
                    <motion.div
                      key={`${run.check}:${run.at}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="rounded-xl border border-ink-fade/15 bg-paper-2/30 p-3"
                    >
                      <div className="flex items-center gap-2 text-xs">
                        {run.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-500" />}
                        <span className="font-mono text-ink">{run.command}</span>
                        <span className="ml-auto text-ink-fade text-[10px]">exit {run.exitCode}</span>
                      </div>
                      {(run.stdout || run.stderr) && (
                        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-ink-fade font-mono bg-paper/60 p-2 rounded-lg">{run.stdout || run.stderr}</pre>
                      )}
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Diff Tab */}
        {activeTab === 'diff' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <button onClick={() => setDiffExpanded(!diffExpanded)} className="flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink transition-colors">
                {diffExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                <span className="section-label">UNIFIED DIFF</span>
              </button>
              <button onClick={() => refreshDiffFor('')} className="text-[11px] text-ember hover:text-ember/80 font-medium">刷新</button>
            </div>
            <AnimatePresence>
              {diffExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <pre className="max-h-[500px] overflow-auto rounded-xl bg-ink text-paper p-4 text-[11px] leading-relaxed whitespace-pre-wrap font-mono">
                    {diff?.diff || diff?.stat || 'No diff loaded.'}
                  </pre>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-ink-fade/10 bg-paper-2/20 space-y-2">
        <input
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          className="w-full h-10 px-4 rounded-xl border border-ink-fade/20 bg-paper text-sm outline-none focus:border-ember/50 focus:ring-2 focus:ring-ember/10 transition-all"
          placeholder="feat: describe this change"
        />
        <button
          onClick={commitAndPush}
          disabled={!canCommit}
          className="w-full h-10 rounded-xl bg-ember text-paper text-sm font-medium disabled:opacity-40 hover:bg-ember/90 transition-colors inline-flex items-center justify-center gap-2 shadow-sm"
        >
          <UploadCloud className="w-4 h-4" />
          提交并推送
        </button>
        <p className="text-[10px] text-ink-fade/50 text-center">需要 WORKSPACE_GIT_MUTATION_ENABLED=1</p>
      </div>
    </aside>
  )
}

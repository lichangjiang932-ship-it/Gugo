import { useEffect, useMemo, useState } from 'react'
import { buildFileDiff } from '../../../../lib/diffRows.js'
import { buildFileTree, compareLabel, diffTextFromPayload, filesFromStatusPayload } from '../../../../lib/diffReviewModel.js'
import DiffToolbar from './DiffToolbar.jsx'
import DiffViewerPane from './DiffViewerPane.jsx'
import FeedbackComposer from './FeedbackComposer.jsx'
import FileTreePane from './FileTreePane.jsx'

const DEFAULT_TARGET = Object.freeze({ mode: 'uncommitted', branch: 'main' })
const DEFAULT_VIEW = Object.freeze({
  showFiles: true,
  groupByFolder: true,
  separateSpecial: false,
  sideBySide: false,
  wordWrap: true,
  highlightWords: true,
  hideWhitespace: false,
  collapseToken: 0,
  expandToken: 0,
})

/**
 * The docked diff review panel: reviewer chrome, changed files on the left, the
 * selected file's diff on the right, collected comments at the bottom.
 *
 * The list is read once and refreshed on demand, and a file's diff is only read
 * when it is selected — the panel never loads the whole change set. Comments are
 * local to the review until the reader sends them, and then they travel as one
 * ordinary user message, so the agent sees them in the conversation it already
 * knows how to read.
 */
export default function DiffReviewPanel({ onClose, onExpandToggle, onSendMessage, panelExpanded = false, t }) {
  const [target, setTarget] = useState(DEFAULT_TARGET)
  const [view, setView] = useState(DEFAULT_VIEW)
  const [files, setFiles] = useState([])
  const [status, setStatus] = useState('loading')
  const [refreshToken, setRefreshToken] = useState(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [selected, setSelected] = useState('')
  const [diffs, setDiffs] = useState({})
  const [comments, setComments] = useState([])
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/workbench/git/status')
        const payload = await response.json().catch(() => null)
        if (cancelled) return
        setFiles(filesFromStatusPayload(payload))
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [refreshToken])

  useEffect(() => {
    if (!selected || diffs[selected]) return undefined
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch(`/api/workbench/git/diff?path=${encodeURIComponent(selected)}`)
        const payload = await response.json().catch(() => null)
        const built = buildFileDiff(diffTextFromPayload(payload))
        if (!cancelled) setDiffs((current) => ({ ...current, [selected]: { status: 'ready', ...built } }))
      } catch {
        if (!cancelled) setDiffs((current) => ({ ...current, [selected]: { status: 'error', rows: [], additions: 0, deletions: 0 } }))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [selected, diffs])

  const needle = searchTerm.trim().toLowerCase()
  const visible = useMemo(
    () => (needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files),
    [files, needle],
  )
  const tree = useMemo(
    () => buildFileTree(visible, { groupByFolder: view.groupByFolder, separateSpecial: view.separateSpecial }),
    [visible, view.groupByFolder, view.separateSpecial],
  )
  const activeFile = files.find((file) => file.path === selected) || null
  const diff = selected ? diffs[selected] || { status: 'loading', rows: [], additions: 0, deletions: 0 } : null
  const label = compareLabel(target, t)
  const initialCollapsed = view.collapseToken > view.expandToken

  const send = (text) => {
    if (!text) return
    setSending(true)
    try {
      onSendMessage?.(text)
    } finally {
      setSending(false)
    }
  }
  const sendFeedback = () => {
    if (comments.length === 0) return
    const lines = [t('diffReview.feedbackHeader', { label })]
    comments.forEach((entry, index) => {
      lines.push(t('diffReview.feedbackLine', { index: index + 1, path: entry.path, line: entry.line, text: entry.text }))
      if (entry.codeLine?.trim()) lines.push(t('diffReview.feedbackCode', { code: entry.codeLine.trim() }))
    })
    send(lines.join('\n'))
    setComments([])
  }
  const reviewCode = () => {
    send(t('diffReview.reviewPrompt', { label, files: files.map((file) => file.path).slice(0, 20).join(', ') || '—' }))
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="diff-review-panel" data-target-mode={target.mode} data-status={status}>
      <DiffToolbar
        compact={!panelExpanded}
        onClose={onClose}
        onExpandToggle={onExpandToggle}
        onRefresh={() => { setDiffs({}); setRefreshToken((token) => token + 1) }}
        onReviewCode={reviewCode}
        onSearchChange={setSearchTerm}
        onTargetChange={setTarget}
        onToggleFiles={() => setView((current) => ({ ...current, showFiles: !current.showFiles }))}
        onViewChange={setView}
        searchTerm={searchTerm}
        t={t}
        target={target}
        view={view}
      />
      <div className="flex min-h-0 flex-1">
        {view.showFiles && (
          status === 'error'
            ? <aside className="min-h-0 w-[46%] max-w-[320px] shrink-0 border-r border-ink/10 p-3" data-testid="diff-file-pane"><p role="alert" className="text-xs text-danger">{t('diffReview.failed')}</p></aside>
            : status === 'loading'
              ? <aside className="min-h-0 w-[46%] max-w-[320px] shrink-0 border-r border-ink/10 p-3" data-testid="diff-file-pane"><p className="text-xs text-ink-fade">{t('diffReview.loading')}</p></aside>
              : tree.nodes.length === 0 && tree.special.length === 0
                ? <aside className="min-h-0 w-[46%] max-w-[320px] shrink-0 border-r border-ink/10 p-3" data-testid="diff-file-pane"><p className="text-xs leading-5 text-ink-fade" data-testid="diff-tree-empty">{t('diffReview.emptyTree')}</p></aside>
                : <FileTreePane nodes={tree.nodes} onSelect={setSelected} selected={selected} special={tree.special} t={t} />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <DiffViewerPane
            key={`${selected}:${view.collapseToken}:${view.expandToken}`}
            comments={comments}
            diff={diff}
            file={activeFile}
            initialCollapsed={initialCollapsed}
            onAddComment={(comment) => setComments((current) => [...current, comment])}
            onRemoveComment={(id) => setComments((current) => current.filter((entry) => entry.id !== id))}
            t={t}
            view={view}
          />
          <FeedbackComposer comments={comments} onReviewCode={reviewCode} onSend={sendFeedback} sending={sending} t={t} />
        </div>
      </div>
    </section>
  )
}

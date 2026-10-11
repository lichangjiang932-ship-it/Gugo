import { useEffect, useRef, useState } from 'react'
import { buildFileDiff } from '../../../../lib/diffRows.js'
import { compareLabel, diffTextFromPayload, filesFromStatusPayload } from '../../../../lib/diffReviewModel.js'
import { subscribeSessionChanges } from '../../../../lib/sessionChangesFeed.js'
import { getAuthToken } from '../../../../lib/accountClient.js'
import CurrentFileChange from '../../../../components/CurrentFileChange.jsx'

/**
 * The two reads below go through the same authorized workbench routes the
 * terminal does, so they carry the same bearer token — without it the server
 * answers 401, the payload parses to an error object, and the review reports an
 * empty change set for a workspace that is full of changes.
 */
function authHeaders() {
  const token = getAuthToken?.()
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}
import DiffToolbar from './DiffToolbar.jsx'
import DiffViewerPane from './DiffViewerPane.jsx'
import FeedbackComposer from './FeedbackComposer.jsx'
import FileListOverlay from './FileListOverlay.jsx'

const DEFAULT_TARGET = Object.freeze({ mode: 'uncommitted', branch: 'main' })
const DEFAULT_VIEW = Object.freeze({
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
export default function DiffReviewPanel({ onClose, onExpandToggle, onSendMessage, panelExpanded = false, t, workspacePath = '' }) {
  const [target, setTarget] = useState(DEFAULT_TARGET)
  const [view, setView] = useState(DEFAULT_VIEW)
  const [files, setFiles] = useState([])
  const [status, setStatus] = useState('loading')
  const [refreshToken, setRefreshToken] = useState(0)
  const [selected, setSelected] = useState('')
  const [contentMode, setContentMode] = useState('diff')
  const [fileListOpen, setFileListOpen] = useState(false)
  const [diffs, setDiffs] = useState({})
  const [comments, setComments] = useState([])
  const [sending, setSending] = useState(false)
  const [feed, setFeed] = useState({ files: [], diffs: {}, revision: 0 })
  const [draftActive, setDraftActive] = useState(false)
  const [pendingRefresh, setPendingRefresh] = useState(false)
  const seenRevision = useRef(0)
  // Declared before the effects: a dependency array is evaluated during render,
  // so reading this below its declaration would throw before the panel mounts.
  const isSession = target.mode === 'session'
  // The comparison base the server understands: HEAD for "all changes", a
  // revision name for "compare against", and nothing for the working tree.
  const base = target.mode === 'all' ? 'HEAD' : target.mode === 'branch' ? (target.branch || 'main') : ''

  // The conversation's changes arrive by subscription. A new revision refreshes
  // the panel — unless a comment is being written, in which case the reader is
  // told and decides when to take the update.
  useEffect(() => {
    const timer = setTimeout(() => subscribeSessionChanges((next) => {
      setFeed(next)
      if (next.revision === seenRevision.current) return
      seenRevision.current = next.revision
      if (draftActive) setPendingRefresh(true)
      else setRefreshToken((token) => token + 1)
    }), 0)
    return () => clearTimeout(timer)
  }, [draftActive])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/workbench/git/status', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ ...(workspacePath ? { cwd: workspacePath } : {}), ...(base ? { base } : {}) }),
        })
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
  }, [refreshToken, workspacePath, base])

  useEffect(() => {
    if (isSession || !selected || diffs[selected]) return undefined
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/workbench/git/diff', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ path: selected, ...(workspacePath ? { cwd: workspacePath } : {}), ...(base ? { base } : {}) }),
        })
        const payload = await response.json().catch(() => null)
        const built = buildFileDiff(diffTextFromPayload(payload))
        if (!cancelled) setDiffs((current) => ({ ...current, [selected]: { status: 'ready', ...built } }))
      } catch {
        if (!cancelled) setDiffs((current) => ({ ...current, [selected]: { status: 'error', rows: [], additions: 0, deletions: 0 } }))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [selected, diffs, workspacePath, base, isSession])

  // Opening the review from the chat asks for the conversation target, whether
  // or not this panel was already mounted; the breadcrumb can change it after.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onOpen = (event) => {
      const mode = event?.detail?.mode
      if (!mode) return
      setTarget((current) => ({ ...current, mode }))
      setDiffs({})
      setPendingRefresh(false)
    }
    window.addEventListener('chat-workbench:open-diff', onOpen)
    return () => window.removeEventListener('chat-workbench:open-diff', onOpen)
  }, [])

  const source = isSession ? feed.files : files
  // Which folder the file list browses: the one holding the file in hand, so the
  // list is about where the reader already is, and the workspace otherwise.
  const listRoot = selected ? String(selected).replace(/[\\/][^\\/]*$/u, '') : (workspacePath || '')
  // The review's list is the conversation's own change set and nothing else: the
  // pane next door browses the whole folder, and a reader who opened *this* one
  // is asking what this conversation touched.
  const changedEntries = source
    .map((file) => ({ name: String(file.path || file.displayPath || '').split(/[\\/]/u).pop() || '' }))
    .filter((entry) => entry.name)
  // Land on a file rather than on an empty pane. The review is opened to read a
  // change, and a reader who has to guess that a row is clickable reads the blank
  // right-hand side as "there is nothing here" — which is what it looked like.
  // Adjusted during render, not in an effect: an effect would paint the empty
  // pane first and then replace it, and this panel is often opened on data that
  // is already in hand.
  const [prevSource, setPrevSource] = useState(source)
  if (prevSource !== source) {
    setPrevSource(source)
    if (!source.some((file) => file.path === selected)) setSelected(String(source[0]?.path || ''))
  }
  const activeFile = source.find((file) => file.path === selected) || null
  const diff = selected
    ? isSession
      ? { status: 'ready', ...buildFileDiff(feed.diffs[selected] || '') }
      : diffs[selected] || { status: 'loading', rows: [], additions: 0, deletions: 0 }
    : null
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
    <section className="relative flex min-h-0 flex-1 flex-col" data-testid="diff-review-panel" data-target-mode={target.mode} data-status={status}>
      <DiffToolbar
        compact={!panelExpanded}
        contentMode={contentMode}
        fileListOpen={fileListOpen}
        onClose={onClose}
        onContentModeChange={setContentMode}
        onExpandToggle={onExpandToggle}
        onRefresh={() => { setDiffs({}); setRefreshToken((token) => token + 1) }}
        onReviewCode={reviewCode}
        onTargetChange={(next) => { setTarget(next); setDiffs({}); setPendingRefresh(false) }}
        onToggleFileList={() => setFileListOpen((open) => !open)}
        onViewChange={setView}
        t={t}
        target={target}
        view={view}
      />
      {pendingRefresh && (
        <button
          type="button"
          data-testid="diff-new-changes"
          onClick={() => { setPendingRefresh(false); setDiffs({}); setRefreshToken((token) => token + 1) }}
          className="absolute inset-x-0 top-10 z-20 mx-auto w-fit rounded-pill bg-ink px-3 py-1 text-xs text-paper"
        >
          {t('diffReview.newChanges')}
        </button>
      )}
      {/* No resident file column: at 46% of the pane it was the largest thing on
          screen and the least of what a reader came for. The list it held is the
          overlay the ≡ opens, which names every file in the folder rather than
          only the ones this conversation touched. */}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          {contentMode === 'file' && selected ? (
            // The file as it stands. A changed file is usually source or text the
            // reader can simply read, and only some of them have an edit recorded
            // to diff against — without this, those files were a dead end. A file
            // reached from the folder list need not be in the change set at all,
            // so the path is enough to read it by.
            <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="diff-file-content">
              <CurrentFileChange className="text-xs" counts={activeFile} file={activeFile || { path: selected }} t={t} wrap={view.wordWrap} />
            </div>
          ) : (
            <DiffViewerPane
              key={`${selected}:${view.collapseToken}:${view.expandToken}`}
              comments={comments}
              diff={diff}
              file={activeFile}
              initialCollapsed={initialCollapsed}
              onAddComment={(comment) => setComments((current) => [...current, comment])}
              onDraftActiveChange={setDraftActive}
              onRemoveComment={(id) => setComments((current) => current.filter((entry) => entry.id !== id))}
              t={t}
              view={view}
            />
          )}
          <FeedbackComposer comments={comments} onReviewCode={reviewCode} onSend={sendFeedback} sending={sending} t={t} />
        </div>
        {fileListOpen && (
          <FileListOverlay
            changed={source}
            entries={changedEntries}
            onClose={() => setFileListOpen(false)}
            onPick={(path) => { setSelected(path); setContentMode('file'); setFileListOpen(false) }}
            rootPath={listRoot}
            t={t}
          />
        )}
      </div>
    </section>
  )
}

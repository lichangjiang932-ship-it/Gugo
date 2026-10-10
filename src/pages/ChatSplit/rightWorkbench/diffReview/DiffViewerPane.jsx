import { useState } from 'react'
import { ChevronDown, ChevronRight, MessageSquarePlus } from 'lucide-react'
import { highlightChangedWords } from '../../../../lib/diffRows.js'

const ROW_TINT = Object.freeze({
  added: 'diff-row-added',
  removed: 'diff-row-removed',
  changed: 'diff-row-changed',
  context: '',
  filler: 'diff-row-filler',
})

function rowKey(file, row, index) {
  return `${file}:${row.newNumber ?? `o${row.oldNumber}`}:${index}`
}

function isWhitespaceOnly(row) {
  return row.kind === 'changed' && String(row.oldText).trim() === String(row.newText).trim()
}

function LineText({ parts, wrap }) {
  return (
    <span className={wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}>
      {parts.map((part, index) => (
        <span key={index} className={part.changed ? 'diff-word' : undefined}>{part.text}</span>
      ))}
    </span>
  )
}

/**
 * One changed row. The gutter carries the line numbers and the comment entry —
 * the blue plus shows on hover, exactly where the eye already is.
 */
function Row({ comment, draft, onComment, onDraftChange, onSaveComment, onCancelComment, row, rowId, t, view }) {
  const tint = ROW_TINT[row.kind] || ''
  const words = view.highlightWords && row.kind === 'changed'
    ? highlightChangedWords(row.oldText, row.newText)
    : null
  const comments = comment || []
  const showDraft = draft?.rowId === rowId
  return (
    <div className={`group grid grid-cols-[3.2rem_3.2rem_1fr] text-xs leading-5 ${tint}`} data-testid="diff-row" data-kind={row.kind}>
      <span className="select-none border-r border-ink/5 px-1 text-right font-mono text-ink-fade">{row.oldNumber ?? ''}</span>
      <span className="flex items-center justify-end gap-0.5 border-r border-ink/5 px-1 font-mono text-ink-fade">
        <button
          type="button"
          data-testid="diff-comment-add"
          aria-label={t('diffReview.addComment')}
          title={t('diffReview.addComment')}
          onClick={() => onComment(rowId, row)}
          className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent text-paper opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 group-hover:flex"
        >
          <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
        </button>
        {row.newNumber ?? ''}
      </span>
      <span className={`min-w-0 px-2 font-mono ${view.wordWrap ? 'break-all' : ''}`}>
        <span className="select-none pr-1.5 text-ink-fade">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span>
        {words ? <LineText parts={words.newParts} wrap={view.wordWrap} /> : <span className={view.wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'}>{row.newText || row.oldText}</span>}
      </span>
      {(comments.length > 0 || showDraft) && (
        <div className="col-span-3 border-t border-ink/5 bg-paper-2/50 px-2 py-1.5" data-testid="diff-inline-comment">
          {comments.map((entry) => (
            <p key={entry.id} className="flex items-start gap-2 py-0.5 text-xs text-ink-soft">
              <span className="min-w-0 flex-1">{entry.text}</span>
              <button type="button" className="shrink-0 text-xs text-ink-fade hover:text-danger" onClick={() => entry.onRemove?.()}>
                {t('diffReview.cancel')}
              </button>
            </p>
          ))}
          {showDraft && (
            <div className="flex items-center gap-2 py-0.5">
              <input
                autoFocus
                value={draft.text}
                data-testid="diff-comment-input"
                placeholder={t('diffReview.commentPlaceholder')}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') onCancelComment()
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSaveComment() }
                }}
                className="h-7 min-w-0 flex-1 rounded-control border border-ink/15 bg-paper px-2 text-xs text-ink outline-none focus:border-focus"
              />
              <button type="button" data-testid="diff-comment-save" className="text-xs text-accent" onClick={onSaveComment}>{t('diffReview.save')}</button>
              <button type="button" data-testid="diff-comment-cancel" className="text-xs text-ink-fade" onClick={onCancelComment}>{t('diffReview.cancel')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One file's diff. Side-by-side shares a single scroll container, so the two
 * columns cannot drift apart; unified is the default, matching the reference.
 */
export default function DiffViewerPane({
  comments = [],
  diff,
  file,
  initialCollapsed = false,
  onAddComment,
  onRemoveComment,
  t,
  view,
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [draft, setDraft] = useState(null)
  if (!file) {
    return <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="diff-viewer-pane"><p className="text-xs text-ink-fade" data-testid="diff-empty">{t('diffReview.emptyDiff')}</p></div>
  }
  const rows = (diff?.rows || []).filter((row) => !(view.hideWhitespace && isWhitespaceOnly(row)))
  const commentsFor = (rowId) => comments.filter((entry) => entry.rowId === rowId).map((entry) => ({
    ...entry,
    onRemove: () => onRemoveComment?.(entry.id),
  }))
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="diff-viewer-pane" data-file={file.path}>
      <div className="flex shrink-0 items-center gap-2 border-b border-ink/10 px-2.5 py-1.5 text-xs">
        <button type="button" data-testid="diff-file-collapse" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}
          className="flex h-5 w-5 items-center justify-center rounded-control text-ink-fade hover:text-ink">
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
        <span className="min-w-0 flex-1 truncate font-medium text-ink" title={file.path}>{file.path}</span>
        <span className="shrink-0 font-mono text-accent">+{diff?.additions ?? 0}</span>
        <span className="shrink-0 font-mono text-danger">−{diff?.deletions ?? 0}</span>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-auto" data-testid="diff-rows">
          {diff?.status === 'loading' && <p className="px-3 py-2 text-xs text-ink-fade">{t('diffReview.loading')}</p>}
          {diff?.status === 'error' && <p role="alert" className="px-3 py-2 text-xs text-danger">{diff.error || t('diffReview.failed')}</p>}
          {diff?.status === 'ready' && rows.length === 0 && <p className="px-3 py-2 text-xs text-ink-fade">{t('diffReview.emptyDiff')}</p>}
          <div className={view.sideBySide ? 'grid grid-cols-2 divide-x divide-ink/10' : ''}>
            {rows.map((row, index) => {
              const rowId = rowKey(file.path, row, index)
              const shared = {
                comment: commentsFor(rowId), draft, onCancelComment: () => setDraft(null),
                onComment: (id) => setDraft({ rowId: id, row, text: '' }),
                onDraftChange: (text) => setDraft((current) => (current ? { ...current, text } : current)),
                onSaveComment: () => {
                  if (!draft?.text?.trim()) { setDraft(null); return }
                  onAddComment?.({
                    id: `${rowId}:${Date.now()}`, rowId, path: file.path, side: 'new',
                    line: row.newNumber ?? row.oldNumber ?? 0,
                    codeLine: row.newText || row.oldText || '', text: draft.text.trim(),
                  })
                  setDraft(null)
                },
                row: view.sideBySide ? { ...row, newText: row.newText } : row,
                rowId, t, view,
              }
              return <Row key={rowId} {...shared} />
            })}
          </div>
        </div>
      )}
    </div>
  )
}

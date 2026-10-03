import { createPortal } from 'react-dom'
import { FileDiff } from 'lucide-react'
import SessionChangesPanel from './SessionChangesPanel.jsx'

/**
 * This conversation's change review: the header indicator and the panel behind it.
 *
 * One module because the two belong together — the count in the header is the
 * panel's summary, and a reader who wants one always wants the other.
 *
 * The panel is drawn through a portal into the chat's main area rather than beside
 * the button: the button lives in a header with `backdrop-blur`, which makes that
 * header the containing block for absolutely positioned children, so a panel left
 * inside it would position itself against a 48-pixel strip. The main area is the
 * surface the review is read against.
 */
export default function SessionChangesReview({ review, t }) {
  const count = review?.count || 0
  const additions = review?.summary?.additions || 0
  const deletions = review?.summary?.deletions || 0
  const host = typeof document === 'undefined' ? null : document.querySelector('[data-chat-main-area]')
  return (
    <>
      <button
        type="button"
        data-open={review?.visible || undefined}
        data-has-changes={count > 0 || undefined}
        onClick={review?.toggle}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && review?.visible) {
            event.preventDefault()
            review.close?.()
          }
        }}
        aria-pressed={review?.visible || undefined}
        aria-label={t('chat.changes.toggle')}
        title={count > 0 ? t('chat.changes.toggleCount', { count }) : t('chat.changes.toggle')}
        data-testid="session-changes-toggle"
        className={`chat-chrome-button inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-1.5 text-xs text-ink-fade hover:text-ink ${count > 0 ? 'chat-changes-chip' : ''}`}
      >
        <FileDiff className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
        {/* Codex's diff stat: the size of what changed, in the colours of a diff. */}
        {count > 0 && (
          <span className="flex items-center gap-1 font-mono tabular-nums" aria-hidden="true" data-testid="session-changes-stat">
            <span className={additions > 0 ? 'text-success' : 'text-ink-fade/60'}>+{additions}</span>
            <span className={deletions > 0 ? 'text-danger' : 'text-ink-fade/60'}>−{deletions}</span>
          </span>
        )}
        {count > 0 && <span className="sr-only">{t('chat.changes.toggleCount', { count })}</span>}
      </button>
      {host && review?.visible ? createPortal(<SessionChangesPanel review={review} t={t} />, host) : null}
    </>
  )
}

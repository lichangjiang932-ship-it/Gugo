import { Send, Sparkles } from 'lucide-react'

/**
 * The close of the review loop: what has been collected, the one button that
 * sends it to the agent, and the shortcut that asks the agent to review the
 * change set itself. Nothing is sent automatically — the reader decides.
 */
export default function FeedbackComposer({ comments = [], onReviewCode, onSend, sending = false, t }) {
  const count = comments.length
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t border-ink/10 px-2.5 py-2" data-testid="diff-feedback-composer">
      <span className="min-w-0 flex-1 truncate text-xs text-ink-fade" data-testid="diff-comment-count">
        {t('diffReview.comments', { count })}
      </span>
      <button
        type="button"
        data-testid="diff-review-code"
        onClick={() => onReviewCode?.()}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-ink/15 bg-paper px-2.5 text-xs text-ink-soft transition-colors hover:text-ink"
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        {t('diffReview.reviewCode')}
      </button>
      <button
        type="button"
        data-testid="diff-send-feedback"
        disabled={count === 0 || sending}
        onClick={() => onSend?.()}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control bg-ink px-2.5 text-xs text-paper disabled:opacity-40"
      >
        <Send className="h-3.5 w-3.5" aria-hidden="true" />
        {t('diffReview.sendFeedback')}
      </button>
    </footer>
  )
}

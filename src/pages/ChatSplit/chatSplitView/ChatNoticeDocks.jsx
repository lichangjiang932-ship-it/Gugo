/**
 * The two chat notice docks that sit above the composer.
 *
 * Extracted so the chat view keeps its size budget: these are self-contained
 * notices with their own copy and actions, and they must stay mutually
 * exclusive — a hand-paused turn offers "continue the same task", while a
 * recoverable failure offers retry/resume.
 */
export default function ChatNoticeDocks({
  continueSameTaskAvailable,
  handleContinueSameTask,
  manualRetryAvailable,
  onDismissResume,
  onResume,
  isGenerating,
  resumeAvailable,
  t,
}) {
  return (
    <>
      {continueSameTaskAvailable && (
        <div className="chat-notice-dock mx-auto w-full min-w-0 max-w-[780px] px-4 pb-1.5 sm:px-6" data-testid="chat-continue-dock">
          <div className="flex flex-wrap items-center gap-2 rounded-control border border-ink/10 border-l-2 border-l-ink/25 bg-paper-2/45 px-3 py-2 text-xs">
            <span className="min-w-0 basis-48 flex-1 leading-relaxed text-ink-soft">{t('chat.serverTurn.pausedByUser')}</span>
            <button type="button" onClick={handleContinueSameTask} className="h-7 px-3 rounded-md bg-accent text-accent-contrast">
              {t('chat.serverTurn.continueSameTask')}
            </button>
          </div>
        </div>
      )}
      {resumeAvailable && !isGenerating && (
        <div className="chat-notice-dock mx-auto w-full min-w-0 max-w-[780px] px-4 pb-1.5 sm:px-6" data-testid="chat-resume-dock">
          <div className="flex flex-wrap items-center gap-2 rounded-control border border-ink/10 border-l-2 border-l-warning/55 bg-paper-2/45 px-3 py-2 text-xs">
            <span className="min-w-0 basis-48 flex-1 leading-relaxed text-ink-soft">{t(manualRetryAvailable
              ? 'toast.chatTaskRetryHint'
              : 'toast.chatResumeHint')}</span>
            <button type="button" onClick={onResume} className="h-7 px-3 rounded-md bg-accent text-accent-contrast">
              {t(manualRetryAvailable ? 'toast.chatTaskRetryButton' : 'toast.chatResumeButton')}
            </button>
            <button type="button" onClick={onDismissResume} className="h-7 px-2 text-ink-fade hover:text-ink">
              {t('toast.chatResumeDismiss')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

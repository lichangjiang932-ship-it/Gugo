import { AlertTriangle } from 'lucide-react'
import { buildIncompleteTaskPresentation } from './incompleteTaskPresentation.js'

export default function IncompleteTaskNotice({
  expectsFileReceipt,
  msg,
  retainedCount,
  t,
  verifiedCount,
}) {
  const presentation = buildIncompleteTaskPresentation(msg, t, {
    expectsFileReceipt,
    retainedCount,
    verifiedCount,
  })
  return (
    <section
      className="mt-3 border-l-2 border-l-warning/60 py-2 pl-3 text-ui text-ink"
      data-testid="incomplete-task-notice"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-1 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5 leading-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="font-semibold" data-testid="reply-completion-state">
              {t('chatMessages.incompleteTitle')}
            </strong>
            <code className="rounded bg-ink/5 px-1.5 py-0.5 text-[11px] text-ink-fade">
              {presentation.code}
            </code>
          </div>
          <p data-testid="incomplete-task-reason">
            <span className="font-medium">{t('chatMessages.incompleteReasonLabel')}</span>
            <span className="ml-1 text-ink-soft">{presentation.reason}</span>
          </p>
          <p data-testid="incomplete-task-missing">
            <span className="font-medium">{t('chatMessages.incompleteMissingLabel')}</span>
            <span className="ml-1 text-ink-soft">{presentation.missing.join(t('chatMessages.incompleteListSeparator'))}</span>
          </p>
          <p data-testid="incomplete-task-next-step">
            <span className="font-medium">{t('chatMessages.incompleteNextStepLabel')}</span>
            <span className="ml-1 text-ink-soft">{presentation.nextStep}</span>
          </p>
          {presentation.verificationChecks.length > 0 ? (
            <div className="space-y-1 text-ink-soft" data-testid="incomplete-task-verification-details">
              <span className="font-medium text-ink">
                {t('chatMessages.incompleteVerificationDetailsLabel')}
              </span>
              <ul className="list-disc space-y-1 pl-5">
                {presentation.verificationChecks.map((check, index) => (
                  <li key={`${check.status}:${check.code}:${index}`}>
                    <span>{check.scope}</span>
                    <code className="ml-1 rounded bg-ink/5 px-1 text-xs text-ink-fade">
                      {check.code}
                    </code>
                    {check.diagnostic ? (
                      <p className="whitespace-pre-wrap break-words text-ink-fade">
                        <span>{t('chatMessages.incompleteVerificationDiagnosticLabel')}</span>
                        <span className="ml-1">{check.diagnostic}</span>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {presentation.verifiedCount > 0 || presentation.retainedCount > 0 ? (
            <p className="text-ink-fade" data-testid="incomplete-task-file-state">
              {[
                presentation.verifiedCount > 0
                  ? t('chatMessages.incompleteVerifiedFiles', { count: presentation.verifiedCount })
                  : '',
                presentation.retainedCount > 0
                  ? t('chatMessages.incompletePendingFiles', { count: presentation.retainedCount })
                  : '',
              ].filter(Boolean).join(t('chatMessages.incompleteListSeparator'))}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

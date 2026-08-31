import { AlertTriangle, Download, ExternalLink, FileText } from 'lucide-react'
import { withDownloadToken } from '../../../../lib/jobClient.js'
import { localFileOpenPayload } from '../../../../lib/localFileReferences.js'
import { buildIncompleteTaskPresentation } from './incompleteTaskPresentation.js'

function FileStatusRows({ files, onOpenArtifact, pending, t }) {
  if (!Array.isArray(files) || files.length === 0) return null
  const openReference = (event, reference) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const payload = localFileOpenPayload(reference)
    if (!payload || typeof onOpenArtifact !== 'function') return
    event.preventDefault()
    onOpenArtifact(payload)
  }
  return <ul className="space-y-1.5" data-testid={pending ? 'incomplete-pending-files' : 'incomplete-verified-files'}>{files.map((reference) => {
    const filename = String(reference?.filename || reference?.title || '').trim()
    const href = withDownloadToken(reference?.url)
    if (!filename || !href) return null
    return <li key={reference.identity || reference.id || href} className="flex min-w-0 items-center gap-2 rounded-control border border-ink/10 bg-paper/70 px-2 py-1.5"><FileText className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" /><a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => openReference(event, reference)} className="min-w-0 flex-1 truncate text-sm font-medium text-ink underline decoration-ink/20 underline-offset-2 hover:decoration-ink/60" title={t('chatMessages.incompleteOpenFile', { filename })}>{filename}</a><span className={`shrink-0 text-xs ${pending ? 'text-warning' : 'text-success'}`}>{t(pending ? 'chatMessages.incompleteFilePendingStatus' : 'chatMessages.incompleteFileVerifiedStatus')}</span><ExternalLink className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" /><a href={href} download={filename} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-fade hover:bg-ink/5 hover:text-ink" aria-label={t('chatMessages.incompleteDownloadFile', { filename })} title={t('chatMessages.incompleteDownloadFile', { filename })}><Download className="h-3.5 w-3.5" aria-hidden="true" /></a></li>
  })}</ul>
}

export default function IncompleteTaskNotice({
  expectsFileReceipt,
  msg,
  onOpenArtifact,
  retainedCount,
  retainedLocalFileReferences = [],
  t,
  verifiedCount,
  verifiedLocalFileReferences = [],
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
            <code className="rounded bg-ink/5 px-1.5 py-0.5 text-xs text-ink-fade">
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
            <div className="space-y-1.5 text-ink-fade" data-testid="incomplete-task-file-state">
              <p>
              {[
                presentation.verifiedCount > 0
                  ? t('chatMessages.incompleteVerifiedFiles', { count: presentation.verifiedCount })
                  : '',
                presentation.retainedCount > 0
                  ? t('chatMessages.incompletePendingFiles', { count: presentation.retainedCount })
                  : '',
              ].filter(Boolean).join(t('chatMessages.incompleteListSeparator'))}
              </p>
              <FileStatusRows files={verifiedLocalFileReferences} onOpenArtifact={onOpenArtifact} pending={false} t={t} />
              <FileStatusRows files={retainedLocalFileReferences} onOpenArtifact={onOpenArtifact} pending t={t} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

import { AlertTriangle, CheckCircle2, Download, ExternalLink, FileText } from 'lucide-react'
import { withDownloadToken } from '../../lib/jobClient.js'
import {
  isIncompleteJobDelivery,
  normalizedList,
  record,
  taskVerificationIssues,
  unresolvedRetainedLocalFiles,
} from './jobDeliveryProjection.js'

function evidenceText(value) {
  if (typeof value === 'string') return value.trim()
  if (!record(value)) return ''
  return String(value.summary || value.command || value.path || '').trim()
}

function localFileLabel(value) {
  if (typeof value === 'string') return value.trim()
  if (!record(value)) return ''
  return String(value.filename || value.path || '').trim()
}

function trustedLocalFileUrl(value, kind, fallbackTurnId = '') {
  if (!record(value)) return ''
  const id = String(value.id || '').trim()
  const turnId = String(value.turnId || value.serverTurnId || fallbackTurnId || '').trim()
  const raw = String(value.url || '').trim()
    || (id && turnId ? `/api/local-files/${kind}/${encodeURIComponent(id)}?turnId=${encodeURIComponent(turnId)}` : '')
  if (!raw) return ''
  try {
    const origin = globalThis.location?.origin || 'http://localhost'
    const parsed = new URL(raw, origin)
    if (parsed.origin !== origin
      || !new RegExp(`^/api/local-files/${kind}/[^/]+/?$`).test(parsed.pathname)
      || !parsed.searchParams.get('turnId')) return ''
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return ''
  }
}

function localFileRows(values, kind, turnId) {
  const rows = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const filename = localFileLabel(value)
    const id = record(value) ? String(value.id || value.path || filename).trim() : filename
    if (!filename || seen.has(id)) continue
    seen.add(id)
    rows.push({ id, filename, url: trustedLocalFileUrl(value, kind, turnId) })
  }
  return rows
}

function DeliveryFileRows({ files, pending, t }) {
  if (files.length === 0) return null
  return <ul className="mt-2 space-y-1.5" data-testid={pending ? 'job-retained-files' : 'job-verified-files'}>{files.map((file) => {
    const href = file.url ? withDownloadToken(file.url) : ''
    return <li key={file.id} className="flex min-w-0 items-center gap-2 rounded border border-ink/10 bg-paper/70 px-2 py-1.5 text-xs"><FileText className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" />{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-medium text-ink underline decoration-ink/20 underline-offset-2 hover:decoration-ink/60" title={t('chatMessages.incompleteOpenFile', { filename: file.filename })}>{file.filename}</a> : <span className="min-w-0 flex-1 truncate font-medium text-ink" title={file.filename}>{file.filename}</span>}<span className={`shrink-0 ${pending ? 'text-warning' : 'text-success'}`}>{t(pending ? 'chatMessages.incompleteFilePendingStatus' : 'chatMessages.incompleteFileVerifiedStatus')}</span>{href ? <><ExternalLink className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" /><a href={href} download={file.filename} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-fade hover:bg-ink/5 hover:text-ink" aria-label={t('chatMessages.incompleteDownloadFile', { filename: file.filename })} title={t('chatMessages.incompleteDownloadFile', { filename: file.filename })}><Download className="h-3.5 w-3.5" aria-hidden="true" /></a></> : <span className="shrink-0 text-[11px] text-ink-fade" title={t('chatMessages.incompleteFileUnavailable')}>{t('chatMessages.incompleteFileUnavailable')}</span>}</li>
  })}</ul>
}

function nextActionLabel(value, t) {
  const key = {
    retry_job: 'taskCenter.retry',
    retry_step: 'taskCenter.retryStep',
    provide_input: 'taskSteering.waitingTitle',
    wait_for_wake: 'taskCenter.statuses.waiting',
    resume_execution: 'taskCenter.resumeExecution',
    approve_plan: 'taskSteering.approvePlan',
    review_approval: 'taskCenter.openApprovals',
    retry: 'taskCenter.retry',
    recreate_job: 'taskCenter.retry',
    configure_model: 'modelProviders.manage',
    test_provider: 'modelProviders.manage',
    choose_agent_provider: 'modelProviders.manage',
    enable_provider: 'modelProviders.manage',
    reload_model_provider: 'modelProviders.manage',
    verify_model_request: 'chatMessages.openModelRequestRecovery',
  }[String(value || '').trim()]
  return key ? t(key) : String(value || '').trim().replaceAll('_', ' ')
}

export default function JobDeliveryCard({ delivery, jobStatus, evidence = [], t }) {
  if (!record(delivery)) return null
  const issues = normalizedList([
    ...(Array.isArray(delivery.issues) ? delivery.issues : []),
    ...taskVerificationIssues(delivery.taskVerification),
  ])
  const completed = normalizedList(delivery.completedDeliverables).map((value) => value.toUpperCase())
  const missing = normalizedList(delivery.missingDeliverables).map((value) => value.toUpperCase())
  const missingRequirements = normalizedList(delivery.missingRequirements)
  const deliveryTurnId = String(delivery.turnId || delivery.serverTurnId || '').trim()
  const verifiedFiles = localFileRows(delivery.verifiedLocalFiles, 'verified', deliveryTurnId)
  const retainedFiles = localFileRows(unresolvedRetainedLocalFiles(delivery), 'retained', deliveryTurnId)
  const reason = String(delivery.reason || delivery.incompleteReason || '').trim()
  const incomplete = isIncompleteJobDelivery(delivery, jobStatus)
  const summary = String(incomplete ? reason || delivery.summary : delivery.summary || reason).trim()
  const nextAction = nextActionLabel(delivery.nextAction, t)
  const renderedEvidence = normalizedList(evidence.map(evidenceText))
  return (
    <section className={`rounded-md border p-4 ${incomplete ? 'border-warning/40 bg-warning/5' : 'border-success/40 bg-success/5'}`}>
      <div className="flex items-center gap-2">{incomplete ? <AlertTriangle className="w-4 h-4 text-warning" /> : <CheckCircle2 className="w-4 h-4 text-success" />}<h3 className="font-semibold text-lg text-ink">{t(incomplete ? 'taskCenter.deliveryIncomplete' : 'taskCenter.delivery')}</h3></div>
      {summary && <p className={`mt-2 text-sm font-medium ${incomplete ? 'text-warning' : 'text-ink'}`}>{summary}</p>}
      {reason && reason !== summary && <p className="mt-2 text-xs text-danger">{reason}</p>}
      {completed.length > 0 && <p className="mt-2 text-xs text-success">{t('taskCenter.deliverablesCompleted', { items: completed.join(', ') })}</p>}
      {missing.length > 0 && <p className="mt-2 text-xs text-danger">{t('taskCenter.deliverablesMissing', { items: missing.join(', ') })}</p>}
      {missingRequirements.length > 0 && <p className="mt-2 text-xs text-danger"><span className="font-medium">{t('chatMessages.incompleteMissingLabel')}</span> {missingRequirements.join(', ')}</p>}
      {issues.length > 0 && <ul className="mt-2 space-y-1 border-l-2 border-warning/50 pl-3">{issues.map((issue) => <li key={issue} className="text-xs leading-5 text-warning">{issue}</li>)}</ul>}
      {verifiedFiles.length > 0 && <p className="mt-2 text-xs text-success">{t('chatMessages.incompleteVerifiedFiles', { count: verifiedFiles.length })}</p>}
      <DeliveryFileRows files={verifiedFiles} pending={false} t={t} />
      {retainedFiles.length > 0 && <p className="mt-2 text-xs text-warning">{t('chatMessages.incompletePendingFiles', { count: retainedFiles.length })}</p>}
      <DeliveryFileRows files={retainedFiles} pending t={t} />
      {delivery.text && <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">{delivery.text}</div>}
      {nextAction && <p className="mt-2 text-xs text-accent-ink">→ {nextAction}</p>}
      {renderedEvidence.length > 0 && <details className="mt-3 border-t border-dashed border-ink-fade/40 pt-3"><summary className="cursor-pointer text-xs font-medium text-ink">{t('taskCenter.evidence', { count: renderedEvidence.length })}</summary><div className="mt-2 space-y-2">{renderedEvidence.map((item, index) => <p key={`${index}-${item.slice(0, 24)}`} className="whitespace-pre-wrap break-words text-xs leading-5 text-ink-soft">{item}</p>)}</div></details>}
    </section>
  )
}

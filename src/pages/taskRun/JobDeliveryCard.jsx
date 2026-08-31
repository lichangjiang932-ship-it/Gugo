import { AlertTriangle, CheckCircle2, Download, ExternalLink, FileText } from 'lucide-react'
import { withDownloadToken } from '../../lib/jobClient.js'

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const DELIVERY_FIELDS = [
  'complete',
  'summary',
  'text',
  'reason',
  'incompleteReason',
  'missingRequirements',
  'taskVerification',
  'verifiedLocalFiles',
  'retainedLocalFiles',
  'artifactIds',
  'completedDeliverables',
  'missingDeliverables',
  'issues',
  'acceptance',
  'evidence',
  'nextAction',
]

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function hasDeliveryFields(value) {
  const output = record(value)
  return !!output && DELIVERY_FIELDS.some((field) => Object.hasOwn(output, field))
}

function hasMeaningfulDeliveryValue(value) {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function mergeDeliverySources(sources) {
  const merged = {}
  for (const source of sources) {
    for (const [field, value] of Object.entries(source)) {
      if (hasMeaningfulDeliveryValue(value)) merged[field] = value
    }
  }
  return Object.keys(merged).length > 0 ? merged : null
}

export function resolveCanonicalJobDelivery(job) {
  if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return null
  const steps = Array.isArray(job.steps) ? job.steps : []
  const events = Array.isArray(job.events) ? job.events : []
  const finalOutput = record([...steps].reverse().find((step) => (
    step?.kind === 'finalize' && hasDeliveryFields(step.output)
  ))?.output)
  const terminalPayload = record([...events].reverse().find((event) => (
    event?.type === job.status && hasDeliveryFields(event.payload)
  ))?.payload)
  const diagnosticOutputs = steps
    .filter((step) => hasDeliveryFields(step?.output))
    .map((step) => record(step.output))
    .filter(Boolean)
  const sources = [...diagnosticOutputs, terminalPayload, finalOutput].filter(Boolean)
  return mergeDeliverySources(sources)
}

function normalizedList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

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
  const verification = record(delivery.taskVerification)
  const issues = normalizedList([
    ...(Array.isArray(delivery.issues) ? delivery.issues : []),
    ...(Array.isArray(verification?.issues) ? verification.issues : []),
    verification?.reason,
  ])
  const completed = normalizedList(delivery.completedDeliverables).map((value) => value.toUpperCase())
  const missing = normalizedList(delivery.missingDeliverables).map((value) => value.toUpperCase())
  const missingRequirements = normalizedList(delivery.missingRequirements)
  const deliveryTurnId = String(delivery.turnId || delivery.serverTurnId || '').trim()
  const verifiedFiles = localFileRows(delivery.verifiedLocalFiles, 'verified', deliveryTurnId)
  const retainedFiles = localFileRows(delivery.retainedLocalFiles, 'retained', deliveryTurnId)
  const reason = String(delivery.reason || delivery.incompleteReason || '').trim()
  const summary = String(delivery.summary || reason).trim()
  const nextAction = nextActionLabel(delivery.nextAction, t)
  const renderedEvidence = normalizedList(evidence.map(evidenceText))
  const incomplete = jobStatus !== 'completed'
    || delivery.complete === false
    || missing.length > 0
    || missingRequirements.length > 0
    || issues.length > 0
    || !!reason
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

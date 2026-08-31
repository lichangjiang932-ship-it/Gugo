import { AlertTriangle, CheckCircle2 } from 'lucide-react'

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const DELIVERY_FIELDS = [
  'complete',
  'summary',
  'text',
  'reason',
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
  const diagnosticOutput = record([...steps].reverse().find((step) => (
    hasDeliveryFields(step?.output)
  ))?.output)
  const sources = [diagnosticOutput, terminalPayload, finalOutput].filter(Boolean)
  return sources.length > 0 ? Object.assign({}, ...sources) : null
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
  const issues = normalizedList(delivery.issues)
  const completed = normalizedList(delivery.completedDeliverables).map((value) => value.toUpperCase())
  const missing = normalizedList(delivery.missingDeliverables).map((value) => value.toUpperCase())
  const reason = String(delivery.reason || '').trim()
  const summary = String(delivery.summary || reason).trim()
  const nextAction = nextActionLabel(delivery.nextAction, t)
  const renderedEvidence = normalizedList(evidence.map(evidenceText))
  const incomplete = jobStatus !== 'completed'
    || delivery.complete === false
    || missing.length > 0
    || issues.length > 0
    || !!reason
  return (
    <section className={`rounded-md border p-4 ${incomplete ? 'border-warning/40 bg-warning/5' : 'border-success/40 bg-success/5'}`}>
      <div className="flex items-center gap-2">{incomplete ? <AlertTriangle className="w-4 h-4 text-warning" /> : <CheckCircle2 className="w-4 h-4 text-success" />}<h3 className="font-semibold text-lg text-ink">{t(incomplete ? 'taskCenter.deliveryIncomplete' : 'taskCenter.delivery')}</h3></div>
      {summary && <p className={`mt-2 text-sm font-medium ${incomplete ? 'text-warning' : 'text-ink'}`}>{summary}</p>}
      {reason && reason !== summary && <p className="mt-2 text-xs text-danger">{reason}</p>}
      {completed.length > 0 && <p className="mt-2 text-xs text-success">{t('taskCenter.deliverablesCompleted', { items: completed.join(', ') })}</p>}
      {missing.length > 0 && <p className="mt-2 text-xs text-danger">{t('taskCenter.deliverablesMissing', { items: missing.join(', ') })}</p>}
      {issues.length > 0 && <ul className="mt-2 space-y-1 border-l-2 border-warning/50 pl-3">{issues.map((issue) => <li key={issue} className="text-xs leading-5 text-warning">{issue}</li>)}</ul>}
      {delivery.text && <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">{delivery.text}</div>}
      {nextAction && <p className="mt-2 text-xs text-accent-ink">→ {nextAction}</p>}
      {renderedEvidence.length > 0 && <details className="mt-3 border-t border-dashed border-ink-fade/40 pt-3"><summary className="cursor-pointer text-xs font-medium text-ink">{t('taskCenter.evidence', { count: renderedEvidence.length })}</summary><div className="mt-2 space-y-2">{renderedEvidence.map((item, index) => <p key={`${index}-${item.slice(0, 24)}`} className="whitespace-pre-wrap break-words text-xs leading-5 text-ink-soft">{item}</p>)}</div></details>}
    </section>
  )
}

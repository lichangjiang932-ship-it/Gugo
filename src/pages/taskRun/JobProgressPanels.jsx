import { Activity, CheckCircle2, Clock3, Eye, RotateCcw } from 'lucide-react'
import { withDownloadToken } from '../../lib/jobClient.js'
import { formatTime, stepAcceptance } from './taskRunUtils.js'
import StepDot from './StepDot.jsx'

export default function JobProgressPanels({ job, selectedArtifact, setSelectedArtifact, statusLabel, onRetryStep, t }) {
  const waitingStepId = job.status === 'waiting'
    ? [...(job.events || [])].reverse().find((event) => (
        ['awaiting_user', 'sleeping'].includes(event.type)
      ))?.stepId || null
    : null
  return (
    <div className="grid grid-cols-[1.2fr_0.8fr] gap-4">
      <section className="rounded-md border border-ink/20 p-4"><div className="flex items-center gap-2 mb-3"><Activity className="w-4 h-4 text-running" /><h3 className="font-semibold text-lg text-ink">{t('taskCenter.subtasks')}</h3></div><div className="flex flex-col gap-2">{(job.steps || []).map((step) => <StepCard key={step.id} step={step} waitingStepId={waitingStepId} statusLabel={statusLabel} onRetry={onRetryStep} t={t} />)}</div></section>
      <div className="flex flex-col gap-4">
        <section className="rounded-md border border-ink/20 p-4"><div className="flex items-center gap-2 mb-3"><Clock3 className="w-4 h-4 text-accent-ink" /><h3 className="font-semibold text-lg text-ink">{t('taskCenter.events')}</h3></div><div className="flex flex-col gap-2 max-h-64 overflow-y-auto">{(job.events || []).slice().reverse().map((event) => <JobEvent key={event.id} event={event} t={t} />)}</div></section>
        <section className="rounded-md border border-ink/20 p-4"><div className="flex items-center gap-2 mb-3"><CheckCircle2 className="w-4 h-4 text-success" /><h3 className="font-semibold text-lg text-ink">{t('taskCenter.artifacts')}</h3></div>{(job.artifacts || []).length ? <div className="flex flex-col gap-2">{job.artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} active={selectedArtifact?.id === artifact.id} onSelect={setSelectedArtifact} t={t} />)}</div> : <p className="text-xs text-ink-fade">{t('taskCenter.noArtifacts')}</p>}</section>
      </div>
    </div>
  )
}

function StepCard({ step, waitingStepId, statusLabel, onRetry, t }) {
  const acceptance = stepAcceptance(step)
  const showNextAction = step.id === waitingStepId || ['failed', 'cancelled'].includes(step.status)
  return <div className="rounded-md border border-dashed border-ink-fade/40 p-3"><div className="flex items-center gap-2"><StepDot status={step.status} /><span className="text-sm text-ink">{step.title}</span><span className="ml-auto text-xs text-ink-fade">{statusLabel(step.status)}</span></div>{step.error && <p className="text-xs text-danger mt-2">{step.error}</p>}{step.output?.text && <p className="text-xs text-ink-soft mt-2">{step.output.text}</p>}<DeliveryDiagnostics value={step.output} showNextAction={showNextAction} t={t} />{acceptance.length > 0 && <details className="mt-2 text-xs text-ink-fade"><summary className="cursor-pointer">{t('taskCenter.acceptance')}</summary><ul className="mt-1.5 ml-4 list-disc space-y-1">{acceptance.map((item) => <li key={item}>{item}</li>)}</ul></details>}{step.status === 'failed' && <button type="button" onClick={() => onRetry(step.id)} className="mt-2 text-xs text-danger inline-flex items-center gap-1"><RotateCcw className="w-3 h-3" />{t('taskCenter.retryStep')}</button>}</div>
}

function normalizedList(values, { uppercase = false } = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => uppercase ? value.toUpperCase() : value))]
}

function nextActionLabel(value, t) {
  const key = {
    retry_job: 'taskCenter.retry',
    retry_step: 'taskCenter.retryStep',
    provide_input: 'taskSteering.waitingTitle',
    wait_for_wake: 'taskCenter.statuses.waiting',
    resume_execution: 'taskCenter.resumeExecution',
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

function DeliveryDiagnostics({ value, showNextAction = true, t }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const completed = normalizedList(value.completedDeliverables, { uppercase: true })
  const missing = normalizedList(value.missingDeliverables, { uppercase: true })
  const reason = String(value.reason || '').trim()
  const issues = normalizedList(Array.isArray(value.issues) ? value.issues : value.acceptance?.issues)
    .filter((issue) => issue !== reason)
    .slice(0, 16)
  const nextAction = showNextAction ? nextActionLabel(value.nextAction, t) : ''
  if (completed.length === 0 && missing.length === 0 && issues.length === 0 && !reason && !nextAction) return null
  return <div className="mt-2 rounded border border-ink/10 bg-ink/[0.03] p-2 text-xs space-y-1">{reason && <p className="text-danger">{reason}</p>}{completed.length > 0 && <p className="text-success">{t('taskCenter.deliverablesCompleted', { items: completed.join(', ') })}</p>}{missing.length > 0 && <p className="text-danger">{t('taskCenter.deliverablesMissing', { items: missing.join(', ') })}</p>}{issues.length > 0 && <details className="text-ink-fade"><summary className="cursor-pointer">{t('taskCenter.unresolvedIssues')}</summary><ul className="mt-1 ml-4 list-disc space-y-1">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></details>}{nextAction && <p className="text-accent-ink">→ {nextAction}</p>}</div>
}

function JobEvent({ event, t }) {
  return <div className="text-xs"><p className="text-ink">{event.message}</p><DeliveryDiagnostics value={event.payload} t={t} /><p className="text-ink-fade">{formatTime(event.createdAt)}</p></div>
}

function ArtifactRow({ artifact, active, onSelect, t }) {
  return <div className={`rounded-md border p-2 flex items-center gap-2 ${active ? 'border-accent bg-accent-soft' : 'border-ink/15'}`}><button type="button" onClick={() => onSelect(artifact)} className="flex-1 text-left text-sm text-ink hover:text-accent-ink truncate" title={t('taskCenter.preview')}>{artifact.title || artifact.filename}</button><button type="button" onClick={() => onSelect(artifact)} className="h-7 w-7 inline-flex items-center justify-center rounded border border-ink/20 text-ink-soft" aria-label={t('taskCenter.preview')}><Eye className="w-3.5 h-3.5" /></button><a href={withDownloadToken(artifact.url)} download={artifact.filename || ''} className="text-xs text-accent-ink">{t('taskCenter.download')}</a></div>
}

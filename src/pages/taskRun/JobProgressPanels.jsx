import { Activity, CheckCircle2, Clock3, Eye, RotateCcw } from 'lucide-react'
import { withDownloadToken } from '../../lib/jobClient.js'
import { formatTime, stepAcceptance } from './taskRunUtils.js'
import StepDot from './StepDot.jsx'

export default function JobProgressPanels({ job, selectedArtifact, setSelectedArtifact, statusLabel, onRetryStep, t }) {
  return (
    <div className="grid grid-cols-[1.2fr_0.8fr] gap-4">
      <section className="rounded-md border border-ink/20 p-4"><div className="flex items-center gap-2 mb-3"><Activity className="w-4 h-4 text-ember" /><h3 className="font-hand text-lg text-ink">{t('taskCenter.subtasks')}</h3></div><div className="flex flex-col gap-2">{(job.steps || []).map((step) => <StepCard key={step.id} step={step} statusLabel={statusLabel} onRetry={onRetryStep} t={t} />)}</div></section>
      <div className="flex flex-col gap-4">
        <section className="rounded-md border border-ink/20 p-4"><div className="flex items-center gap-2 mb-3"><Clock3 className="w-4 h-4 text-ember" /><h3 className="font-hand text-lg text-ink">{t('taskCenter.events')}</h3></div><div className="flex flex-col gap-2 max-h-64 overflow-y-auto">{(job.events || []).slice().reverse().map((event) => <div key={event.id} className="text-xs"><p className="text-ink">{event.message}</p><p className="text-ink-fade">{formatTime(event.createdAt)}</p></div>)}</div></section>
        <section className="rounded-md border border-ink/20 p-4"><div className="flex items-center gap-2 mb-3"><CheckCircle2 className="w-4 h-4 text-ember" /><h3 className="font-hand text-lg text-ink">{t('taskCenter.artifacts')}</h3></div>{(job.artifacts || []).length ? <div className="flex flex-col gap-2">{job.artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} active={selectedArtifact?.id === artifact.id} onSelect={setSelectedArtifact} t={t} />)}</div> : <p className="text-xs text-ink-fade">{t('taskCenter.noArtifacts')}</p>}</section>
      </div>
    </div>
  )
}

function StepCard({ step, statusLabel, onRetry, t }) {
  const acceptance = stepAcceptance(step)
  return <div className="rounded-md border border-dashed border-ink-fade/40 p-3"><div className="flex items-center gap-2"><StepDot status={step.status} /><span className="text-sm text-ink">{step.title}</span><span className="ml-auto text-xs text-ink-fade">{statusLabel(step.status)}</span></div>{step.error && <p className="text-xs text-red-600 mt-2">{step.error}</p>}{step.output?.text && <p className="text-xs text-ink-soft mt-2">{step.output.text}</p>}{acceptance.length > 0 && <details className="mt-2 text-xs text-ink-fade"><summary className="cursor-pointer">{t('taskCenter.acceptance')}</summary><ul className="mt-1.5 ml-4 list-disc space-y-1">{acceptance.map((item) => <li key={item}>{item}</li>)}</ul></details>}{step.status === 'failed' && <button type="button" onClick={() => onRetry(step.id)} className="mt-2 text-xs text-ember inline-flex items-center gap-1"><RotateCcw className="w-3 h-3" />{t('taskCenter.retryStep')}</button>}</div>
}

function ArtifactRow({ artifact, active, onSelect, t }) {
  return <div className={`rounded-md border p-2 flex items-center gap-2 ${active ? 'border-ember bg-ember-soft' : 'border-ink/15'}`}><button type="button" onClick={() => onSelect(artifact)} className="flex-1 text-left text-sm text-ink hover:text-ember truncate" title={t('taskCenter.preview')}>{artifact.title || artifact.filename}</button><button type="button" onClick={() => onSelect(artifact)} className="h-7 w-7 inline-flex items-center justify-center rounded border border-ink/20 text-ink-soft" aria-label={t('taskCenter.preview')}><Eye className="w-3.5 h-3.5" /></button><a href={withDownloadToken(artifact.url)} download={artifact.filename || ''} className="text-xs text-ember">{t('taskCenter.download')}</a></div>
}

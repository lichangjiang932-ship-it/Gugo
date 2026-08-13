import { PauseCircle, RotateCcw, Send } from 'lucide-react'
import EditablePlanCard from '../../components/EditablePlanCard.jsx'
import DirectoryRequestCard from './DirectoryRequestCard.jsx'
import { ACTIVE_STATUSES, formatTime } from './taskRunUtils.js'

export default function JobOverviewCard({ controller, statusLabel, onOpenApprovals, t }) {
  const job = controller.selectedJob
  return (
    <div className="rounded-md border border-ink/20 bg-paper-2 p-4">
      <div className="flex items-start justify-between gap-4">
        <div><span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">JOB · {job.id}</span><h2 className="font-semibold text-2xl text-ink mt-1">{job.title}</h2><p className="text-sm text-ink-soft mt-1">{job.prompt}</p></div>
        <div className="flex gap-2">{ACTIVE_STATUSES.has(job.status) && <button type="button" onClick={controller.handleCancel} className="h-9 px-3 border border-ink/40 rounded-md text-sm flex items-center gap-1.5"><PauseCircle className="w-4 h-4" />{t('taskCenter.cancel')}</button>}{['failed', 'cancelled'].includes(job.status) && <button type="button" onClick={controller.handleRetry} className="h-9 px-3 border border-ink/40 rounded-md text-sm flex items-center gap-1.5"><RotateCcw className="w-4 h-4" />{t('taskCenter.retry')}</button>}</div>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-3 text-sm"><Metric label={t('taskCenter.status')} value={statusLabel(job.status)} /><Metric label={t('taskCenter.progress')} value={`${job.progress}%`} /><Metric label={t('taskCenter.createdAt')} value={formatTime(job.createdAt)} /><Metric label={t('taskCenter.updatedAt')} value={formatTime(job.updatedAt)} /></div>
      {ACTIVE_STATUSES.has(job.status) && job.status !== 'cancel_requested' && !controller.pendingPlan && <form onSubmit={controller.handleSteer} className="mt-4 flex gap-2 border-t border-dashed border-ink-fade/40 pt-4"><input value={controller.steering} onChange={(event) => controller.setSteering(event.target.value)} maxLength={20_000} placeholder={t('taskSteering.placeholder')} className="flex-1 h-10 px-3 rounded-md border border-ink/25 bg-paper outline-none focus:border-ember text-sm" /><button type="submit" disabled={controller.steeringSubmitting || !controller.steering.trim()} className="h-10 px-4 rounded-md border border-ember/60 text-ember text-sm inline-flex items-center gap-1.5 disabled:opacity-50"><Send className="w-4 h-4" />{t(controller.steeringSubmitting ? 'taskSteering.sending' : 'taskSteering.send')}</button></form>}
      {job.error && <div className="mt-3 rounded-md border border-dashed border-red-500/50 bg-red-500/5 p-3"><p className="text-[11px] text-red-600">{t('taskCenter.failureReason')}</p><p className="text-sm text-ink mt-1 break-words">{job.error}</p></div>}
      {job.status === 'awaiting_approval' && <div className="mt-3 rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-3 flex items-center gap-3"><p className="text-sm text-ink flex-1">{t('taskCenter.awaitingApproval')}</p><button type="button" onClick={onOpenApprovals} className="h-8 px-3 border border-amber-500/60 rounded-md text-sm text-amber-700">{t('taskCenter.openApprovals')}</button></div>}
      {controller.pendingDirectoryRequest ? <DirectoryRequestCard key={controller.pendingDirectoryRequest.timestamp || controller.pendingDirectoryRequest.question} request={controller.pendingDirectoryRequest} busy={controller.directoryBusy} onAuthorize={controller.handleDirectoryAuthorization} t={t} /> : controller.pendingClarification?.question && <Clarification controller={controller} t={t} />}
      {controller.pendingPlan && <EditablePlanCard key={(controller.pendingPlan.steps || []).map((step) => `${step.id}:${step.title}`).join('|')} plan={controller.pendingPlan} disabled={controller.planApproving} onApprove={controller.handleApprovePlan} t={t} />}
    </div>
  )
}

function Metric({ label, value }) {
  return <div><p className="text-[11px] text-ink-fade">{label}</p><p className="text-ink mt-1">{value}</p></div>
}

function Clarification({ controller, t }) {
  const clarification = controller.pendingClarification
  return <div className="mt-3 rounded-md border border-dashed border-sky-500/50 bg-sky-500/5 p-3"><p className="text-[11px] text-sky-700">{t('taskSteering.waitingTitle')}</p><p className="text-sm text-ink mt-1">{clarification.question}</p>{clarification.why && <p className="text-xs text-ink-soft mt-1">{clarification.why}</p>}{Array.isArray(clarification.options) && <div className="mt-2 flex flex-wrap gap-2">{clarification.options.map((option) => <button type="button" key={option} onClick={() => controller.setSteering(option)} className="px-2.5 py-1 rounded-md border border-sky-500/40 text-xs text-sky-800">{option}</button>)}</div>}</div>
}

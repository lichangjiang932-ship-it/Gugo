import { PauseCircle, RotateCcw, Send } from 'lucide-react'
import EditablePlanCard from '../../components/EditablePlanCard.jsx'
import DirectoryRequestCard from './DirectoryRequestCard.jsx'
import { localizedJobModelFailure } from './jobModelFailurePresentation.js'
import { ACTIVE_STATUSES, formatTime } from './taskRunUtils.js'

export default function JobOverviewCard({
  controller,
  statusLabel,
  onOpenApprovals,
  onConfigureModels,
  onOpenModelRecovery,
  t,
}) {
  const job = controller.selectedJob
  const failureAction = controller.jobFailureRecovery?.action || ''
  const terminalFailure = [...(job.events || [])].reverse().find((event) => event?.type === 'failed')?.payload
  const failureMessage = localizedJobModelFailure(terminalFailure, t, job.error)
  return (
    <div className="rounded-md border border-ink/20 bg-paper-2 p-4">
      <div className="flex items-start justify-between gap-4">
        <div><span className="font-mono text-xs tracking-[0.18em] uppercase text-ink-fade">JOB · {job.id}</span><h2 className="font-semibold text-2xl text-ink mt-1">{job.title}</h2><p className="text-sm text-ink-soft mt-1">{job.prompt}</p></div>
        <div className="flex gap-2">
          {ACTIVE_STATUSES.has(job.status) && <button type="button" onClick={controller.handleCancel} className="h-9 px-3 border border-ink/40 rounded-md text-sm flex items-center gap-1.5"><PauseCircle className="w-4 h-4" />{t('taskCenter.cancel')}</button>}
          {failureAction === 'configure_model' && onConfigureModels && <button type="button" onClick={onConfigureModels} className="h-9 px-3 border border-ink/40 rounded-md text-sm">{t('modelProviders.manage')}</button>}
          {failureAction === 'verify_model_request' && onOpenModelRecovery && <button type="button" onClick={onOpenModelRecovery} className="h-9 px-3 border border-ink/40 rounded-md text-sm">{t('chatMessages.openModelRequestRecovery')}</button>}
          {['failed', 'cancelled'].includes(job.status) && <button type="button" onClick={controller.handleRetry} className="h-9 px-3 border border-ink/40 rounded-md text-sm flex items-center gap-1.5"><RotateCcw className="w-4 h-4" />{t('taskCenter.retry')}</button>}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-3 text-sm"><Metric label={t('taskCenter.status')} value={statusLabel(job.status, job.id)} /><Metric label={t('taskCenter.progress')} value={`${job.progress}%`} /><Metric label={t('taskCenter.createdAt')} value={formatTime(job.createdAt)} /><Metric label={t('taskCenter.updatedAt')} value={formatTime(job.updatedAt)} /></div>
      {ACTIVE_STATUSES.has(job.status) && job.status !== 'cancel_requested' && !controller.pendingPlan && <form onSubmit={controller.handleSteer} className="mt-4 flex gap-2 border-t border-dashed border-ink-fade/40 pt-4"><input value={controller.steering} onChange={(event) => controller.setSteering(event.target.value)} maxLength={20_000} placeholder={t('taskSteering.placeholder')} className="flex-1 h-10 px-3 rounded-md border border-ink/25 bg-paper outline-none focus:border-focus text-sm" /><button type="submit" disabled={controller.steeringSubmitting || !controller.steering.trim()} className="h-10 px-4 rounded-md border border-accent/60 text-accent-ink text-sm inline-flex items-center gap-1.5 disabled:opacity-50"><Send className="w-4 h-4" />{t(controller.steeringSubmitting ? 'taskSteering.sending' : 'taskSteering.send')}</button></form>}
      {job.error && <div className="mt-3 rounded-md border border-dashed border-danger/45 bg-danger/5 p-3"><p className="text-xs font-medium text-danger">{t('taskCenter.failureReason')}</p><p className="text-sm text-ink mt-1 break-words">{failureMessage}</p></div>}
      {job.status === 'awaiting_approval' && <div className="mt-3 rounded-md border border-dashed border-warning/45 bg-warning/5 p-3 flex items-center gap-3"><p className="text-sm text-ink flex-1">{t('taskCenter.awaitingApproval')}</p><button type="button" onClick={onOpenApprovals} className="h-8 px-3 border border-warning/55 rounded-md text-sm text-warning">{t('taskCenter.openApprovals')}</button></div>}
      {controller.pendingDirectoryRequest ? <DirectoryRequestCard key={controller.pendingDirectoryRequest.timestamp || controller.pendingDirectoryRequest.question} request={controller.pendingDirectoryRequest} busy={controller.directoryBusy} onAuthorize={controller.handleDirectoryAuthorization} t={t} /> : controller.pendingClarification?.question && <Clarification controller={controller} t={t} />}
      {controller.pendingPlan && <EditablePlanCard key={(controller.pendingPlan.steps || []).map((step) => `${step.id}:${step.title}`).join('|')} plan={controller.pendingPlan} disabled={controller.planApproving} onApprove={controller.handleApprovePlan} t={t} />}
    </div>
  )
}

function Metric({ label, value }) {
  return <div><p className="text-xs text-ink-fade">{label}</p><p className="text-ink mt-1">{value}</p></div>
}

function Clarification({ controller, t }) {
  const clarification = controller.pendingClarification
  const title = clarification.waitingKind === 'sleeping'
    ? t('taskCenter.statuses.waiting')
    : t('taskSteering.waitingTitle')
  return <div className="mt-3 rounded-md border border-dashed border-running/45 bg-running/5 p-3"><p className="text-xs font-medium text-running">{title}</p><p className="text-sm text-ink mt-1">{clarification.question}</p>{clarification.why && <p className="text-xs text-ink-soft mt-1">{clarification.why}</p>}{clarification.wakeAt && <p className="text-xs text-ink-soft mt-1">{t('taskCenter.wakesAt', { time: formatTime(clarification.wakeAt) })}</p>}{Array.isArray(clarification.options) && <div className="mt-2 flex flex-wrap gap-2">{clarification.options.map((option) => <button type="button" key={option} onClick={() => controller.setSteering(option)} className="px-2.5 py-1 rounded-md border border-running/40 text-xs text-running">{option}</button>)}</div>}</div>
}

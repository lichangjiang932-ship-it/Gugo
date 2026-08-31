import { useLocation, useSearchParams, useNavigate } from '../lib/router.jsx'
import { LayoutList } from 'lucide-react'
import AppLayout from '../components/AppLayout.jsx'
import TaskArtifactPreview from './TaskArtifactPreview.jsx'
import { useToast } from '../components/Toast.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import TaskRunHeader from './taskRun/TaskRunHeader.jsx'
import TaskListSidebar from './taskRun/TaskListSidebar.jsx'
import JobOverviewCard from './taskRun/JobOverviewCard.jsx'
import JobDeliveryCard from './taskRun/JobDeliveryCard.jsx'
import {
  isIncompleteJobDelivery,
  resolveCanonicalJobDelivery,
} from './taskRun/jobDeliveryProjection.js'
import JobProgressPanels from './taskRun/JobProgressPanels.jsx'
import useTaskRunController from './taskRun/useTaskRunController.js'
import { FILTER_KEYS, STATUS_KEYS } from './taskRun/taskRunUtils.js'
import {
  normalizeSettingsReturnTo,
  SETTINGS_TAB_MODELS,
  settingsPathForSection,
} from '../lib/settingsNavigation.js'

export default function TaskRunPanel() {
  const toast = useToast()
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const linkedJobId = searchParams.get('job')
  const controller = useTaskRunController({ linkedJobId, t, toast })
  const filters = FILTER_KEYS.map((key) => ({ key, label: t(`taskCenter.filters.${key}`) }))
  const delivery = resolveCanonicalJobDelivery(controller.selectedJob)
  const selectedDeliveryIncomplete = controller.selectedJob?.status === 'completed'
    && isIncompleteJobDelivery(delivery, controller.selectedJob.status)
  const statusLabel = (status) => STATUS_KEYS.has(status) ? t(`taskCenter.statuses.${status}`) : status
  const jobStatusLabel = (status, jobId) => status === 'completed'
    && selectedDeliveryIncomplete
    && jobId === controller.selectedJob?.id
    ? t('taskCenter.deliveryIncomplete')
    : statusLabel(status)
  const verifyStep = controller.selectedJob?.steps?.find((step) => step.kind === 'verify')
  const evidence = Array.isArray(delivery?.evidence)
    ? delivery.evidence
    : Array.isArray(verifyStep?.output?.evidence) ? verifyStep.output.evidence : []
  const returnJobId = controller.selectedJobId || linkedJobId
  const taskReturnTo = normalizeSettingsReturnTo(returnJobId
    ? `${location.pathname}?${new URLSearchParams({ job: returnJobId })}`
    : location.pathname)
  const openModelSettings = () => navigate(settingsPathForSection(
    SETTINGS_TAB_MODELS,
    [],
    { returnTo: taskReturnTo },
  ))
  const openModelRecovery = controller.modelRecoveryTarget
    ? () => {
        const params = new URLSearchParams({ tab: 'recovery', ...controller.modelRecoveryTarget })
        if (taskReturnTo) params.set('returnTo', taskReturnTo)
        navigate(`/settings?${params}`)
      }
    : null

  return (
    <AppLayout className="h-screen flex bg-paper overflow-hidden">
      <main className="flex-1 min-w-0 flex flex-col">
        <TaskRunHeader
          prompt={controller.prompt}
          setPrompt={controller.setPrompt}
          submitting={controller.submitting}
          error={controller.error}
          errorAction={controller.errorAction}
          modelName={controller.modelSelection.modelName}
          modelReadiness={controller.modelReadiness}
          onConfigureModels={openModelSettings}
          onOpenModelRecovery={openModelRecovery}
          onRetryModelStatus={controller.reloadModelReadiness}
          onCreate={controller.handleCreate}
          t={t}
        />
        <section className="flex-1 min-h-0 grid grid-cols-[320px_minmax(0,1fr)]">
          <TaskListSidebar jobs={controller.jobs} loading={controller.loading} filters={filters} activeFilter={controller.activeFilter} setActiveFilter={controller.setActiveFilter} selectedJobId={controller.selectedJobId} onSelect={controller.selectJob} statusLabel={jobStatusLabel} t={t} />
          <div className="p-5 overflow-y-auto">
            {!controller.selectedJob ? (
              <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-ink-fade"><LayoutList className="w-8 h-8" /><p className="text-sm">{t('taskCenter.select')}</p></div>
            ) : (
              <div className="max-w-4xl mx-auto flex flex-col gap-5">
                <JobOverviewCard
                  controller={controller}
                  statusLabel={jobStatusLabel}
                  onOpenApprovals={() => navigate('/approvals')}
                  onConfigureModels={openModelSettings}
                  onOpenModelRecovery={openModelRecovery}
                  t={t}
                />
                <JobDeliveryCard delivery={delivery} jobStatus={controller.selectedJob.status} evidence={evidence} t={t} />
                <JobProgressPanels job={controller.selectedJob} selectedArtifact={controller.selectedArtifact} setSelectedArtifact={controller.setSelectedArtifact} statusLabel={statusLabel} onRetryStep={controller.handleRetryStep} t={t} />
              </div>
            )}
          </div>
        </section>
      </main>
      {controller.selectedArtifact && <TaskArtifactPreview key={controller.selectedArtifact.id} artifact={controller.selectedArtifact} onClose={() => controller.setSelectedArtifact(null)} />}
    </AppLayout>
  )
}

export { default as DirectoryRequestCard } from './taskRun/DirectoryRequestCard.jsx'

import { useSearchParams, useNavigate } from '../lib/router.jsx'
import { LayoutList } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import TaskArtifactPreview from './TaskArtifactPreview.jsx'
import { useToast } from '../components/Toast.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import TaskRunHeader from './taskRun/TaskRunHeader.jsx'
import TaskListSidebar from './taskRun/TaskListSidebar.jsx'
import JobOverviewCard from './taskRun/JobOverviewCard.jsx'
import JobDeliveryCard from './taskRun/JobDeliveryCard.jsx'
import JobProgressPanels from './taskRun/JobProgressPanels.jsx'
import useTaskRunController from './taskRun/useTaskRunController.js'
import { FILTER_KEYS, STATUS_KEYS } from './taskRun/taskRunUtils.js'

export default function TaskRunPanel() {
  const toast = useToast()
  const { t } = useT()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const controller = useTaskRunController({ linkedJobId: searchParams.get('job'), t, toast })
  const filters = FILTER_KEYS.map((key) => ({ key, label: t(`taskCenter.filters.${key}`) }))
  const statusLabel = (status) => STATUS_KEYS.has(status) ? t(`taskCenter.statuses.${status}`) : status
  const finalStep = controller.selectedJob?.steps?.find((step) => step.kind === 'finalize' && step.status === 'completed')
  const verifyStep = controller.selectedJob?.steps?.find((step) => step.kind === 'verify')
  const evidence = Array.isArray(finalStep?.output?.evidence)
    ? finalStep.output.evidence
    : Array.isArray(verifyStep?.output?.evidence) ? verifyStep.output.evidence : []

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <main className="flex-1 min-w-0 flex flex-col">
        <TaskRunHeader prompt={controller.prompt} setPrompt={controller.setPrompt} submitting={controller.submitting} error={controller.error} onCreate={controller.handleCreate} t={t} />
        <section className="flex-1 min-h-0 grid grid-cols-[320px_minmax(0,1fr)]">
          <TaskListSidebar jobs={controller.jobs} loading={controller.loading} filters={filters} activeFilter={controller.activeFilter} setActiveFilter={controller.setActiveFilter} selectedJobId={controller.selectedJobId} onSelect={controller.selectJob} statusLabel={statusLabel} t={t} />
          <div className="p-5 overflow-y-auto">
            {!controller.selectedJob ? (
              <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-ink-fade"><LayoutList className="w-8 h-8" /><p className="text-sm">{t('taskCenter.select')}</p></div>
            ) : (
              <div className="max-w-4xl mx-auto flex flex-col gap-5">
                <JobOverviewCard controller={controller} statusLabel={statusLabel} onOpenApprovals={() => navigate('/approvals')} t={t} />
                <JobDeliveryCard finalStep={finalStep} evidence={evidence} t={t} />
                <JobProgressPanels job={controller.selectedJob} selectedArtifact={controller.selectedArtifact} setSelectedArtifact={controller.setSelectedArtifact} statusLabel={statusLabel} onRetryStep={controller.handleRetryStep} t={t} />
              </div>
            )}
          </div>
        </section>
      </main>
      {controller.selectedArtifact && <TaskArtifactPreview key={controller.selectedArtifact.id} artifact={controller.selectedArtifact} onClose={() => controller.setSelectedArtifact(null)} />}
    </div>
  )
}

export { default as DirectoryRequestCard } from './taskRun/DirectoryRequestCard.jsx'

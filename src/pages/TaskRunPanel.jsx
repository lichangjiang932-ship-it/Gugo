import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from '../lib/router.jsx'
import { Activity, AlertTriangle, CheckCircle2, Clock3, LayoutList, PauseCircle, RotateCcw, Eye, FolderOpen, LoaderCircle, Send } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import TaskArtifactPreview from './TaskArtifactPreview.jsx'
import { useToast } from '../components/Toast.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  approveJobPlan,
  cancelJob,
  createJob,
  getJob,
  listJobs,
  retryJob,
  retryStep,
  steerJob,
  subscribeToJobEvents,
  withDownloadToken,
} from '../lib/jobClient.js'
import { authorizeRequestedDirectory } from '../lib/jobDirectoryRequest.js'
import EditablePlanCard from '../components/EditablePlanCard.jsx'

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'queued', label: '排队中' },
  { key: 'completed', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '已终止' },
]

const STATUS_LABELS = Object.freeze({
  queued: '排队中',
  planning: '规划中',
  running: '运行中',
  waiting: '等待中',
  awaiting_approval: '等待批准',
  completed: '已完成',
  failed: '失败',
  cancel_requested: '终止中',
  cancelled: '已终止',
})

// ★ awaiting_approval 必须算「进行中」—— 否则等审批的任务在所有筛选下都不可见,
// 用户会以为任务凭空消失了(它其实在收件箱里等着你点批准)。
const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'waiting', 'awaiting_approval', 'cancel_requested'])

function formatTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function filterJob(job, filter) {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE_STATUSES.has(job.status)
  return job.status === filter
}

function StepDot({ status }) {
  const cls =
    status === 'completed'
      ? 'bg-ink'
      : status === 'running'
      ? 'bg-ember'
      : status === 'failed'
      ? 'bg-red-500'
      : status === 'cancelled'
      ? 'bg-ink-fade'
      : 'bg-ink-ghost'
  return <span className={`w-2.5 h-2.5 rounded-full ${cls}`} aria-hidden="true" />
}

function stepAcceptance(step) {
  const acceptance = step?.input?.acceptance
  if (Array.isArray(acceptance)) return acceptance.filter(Boolean)
  return typeof acceptance === 'string' && acceptance.trim() ? [acceptance.trim()] : []
}

export default function TaskRunPanel() {
  const toast = useToast()
  const { t } = useT()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const linkedJobId = searchParams.get('job')
  const [prompt, setPrompt] = useState('')
  const [jobs, setJobs] = useState([])
  const [selectedJobId, setSelectedJobId] = useState(() => linkedJobId || null)
  const [selectedJob, setSelectedJob] = useState(null)
  const [selectedArtifact, setSelectedArtifact] = useState(null)
  const [activeFilter, setActiveFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [steering, setSteering] = useState('')
  const [steeringSubmitting, setSteeringSubmitting] = useState(false)
  const [planApproving, setPlanApproving] = useState(false)
  const [directoryBusy, setDirectoryBusy] = useState('')
  const [error, setError] = useState('')
  const selectedJobIdRef = useRef(selectedJobId)
  const hasActiveJobsRef = useRef(false)

  useEffect(() => {
    selectedJobIdRef.current = selectedJobId
  }, [selectedJobId])

  useEffect(() => {
    hasActiveJobsRef.current = jobs.some((job) => ACTIVE_STATUSES.has(job.status))
  }, [jobs])

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const { jobs: nextJobs } = await listJobs()
        if (!active) return
        setJobs(nextJobs)
        setSelectedJobId((current) => current || nextJobs[0]?.id || null)
      } catch (err) {
        if (active) setError(err.message)
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    if (!selectedJobId) {
      return undefined
    }
    getJob(selectedJobId)
      .then(({ job }) => {
        if (active) setSelectedJob(job)
      })
      .catch((err) => {
        if (active) setError(err.message)
      })
    return () => {
      active = false
    }
  }, [selectedJobId])

  useEffect(() => {
    let active = true
    let refreshTimer = null
    let fallbackTimer = null
    let refreshing = false
    let refreshQueued = false
    let lastIdleRefreshAt = Date.now()

    function scheduleRefresh(delay = 120) {
      if (!active) return
      refreshQueued = true
      if (refreshTimer != null) return
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        refresh()
      }, delay)
    }

    async function refresh() {
      if (!active) return
      if (refreshing) {
        refreshQueued = true
        return
      }
      refreshing = true
      refreshQueued = false
      const jobId = selectedJobIdRef.current
      const [jobsResult, jobResult] = await Promise.allSettled([
        listJobs(),
        jobId ? getJob(jobId) : Promise.resolve({ job: null }),
      ])
      if (active) {
        if (jobsResult.status === 'fulfilled') setJobs(jobsResult.value.jobs)
        if (
          jobResult.status === 'fulfilled'
          && jobResult.value.job
          && jobId === selectedJobIdRef.current
        ) {
          setSelectedJob(jobResult.value.job)
        }
        if (jobsResult.status === 'rejected' && jobResult.status === 'rejected') {
          setError(jobsResult.reason?.message || jobResult.reason?.message || '任务刷新失败')
        }
      }
      refreshing = false
      if (active && refreshQueued) scheduleRefresh(0)
    }

    const unsubscribe = subscribeToJobEvents(
      () => scheduleRefresh(),
      {
        onConnectionChange: ({ state }) => {
          if (state === 'open') scheduleRefresh(0)
        },
      },
    )
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleRefresh(0)
    }
    const handleOnline = () => scheduleRefresh(0)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('online', handleOnline)
    fallbackTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      const shouldRefresh = hasActiveJobsRef.current || now - lastIdleRefreshAt >= 30_000
      if (!shouldRefresh) return
      if (!hasActiveJobsRef.current) lastIdleRefreshAt = now
      scheduleRefresh(0)
    }, 5_000)

    return () => {
      active = false
      unsubscribe()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('online', handleOnline)
      if (refreshTimer != null) window.clearTimeout(refreshTimer)
      if (fallbackTimer != null) window.clearInterval(fallbackTimer)
    }
  }, [])

  const visibleJobs = useMemo(
    () => jobs.filter((job) => filterJob(job, activeFilter)),
    [jobs, activeFilter],
  )

  async function handleCreate(event) {
    event.preventDefault()
    const trimmed = prompt.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError('')
    try {
      const { job } = await createJob(trimmed)
      setPrompt('')
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
      setSelectedJobId(job.id)
      setSelectedJob(job)
    } catch (err) {
      setError(err.message)
      toast.error({ title: t('toast.chatSendFailed'), body: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel() {
    if (!selectedJob) return
    try {
      const { job } = await cancelJob(selectedJob.id)
      setSelectedJob(job)
      setJobs((current) => current.map((item) => item.id === job.id ? job : item))
    } catch (err) {
      setError(err.message)
      toast.error({ title: t('toast.jobAbortFailed'), body: err.message })
    }
  }

  async function handleRetry() {
    if (!selectedJob) return
    const { job } = await retryJob(selectedJob.id)
    setSelectedJob(job)
    setJobs((current) => current.map((item) => item.id === job.id ? job : item))
  }

  async function handleRetryStep(stepId) {
    if (!selectedJob) return
    const { job } = await retryStep(selectedJob.id, stepId)
    setSelectedJob(job)
    setJobs((current) => current.map((item) => item.id === job.id ? job : item))
  }

  async function handleSteer(event) {
    event.preventDefault()
    const content = steering.trim()
    if (!selectedJob || !content || steeringSubmitting) return
    setSteeringSubmitting(true)
    setError('')
    try {
      const result = await steerJob(selectedJob.id, content)
      setSteering('')
      if (result.job) setSelectedJob(result.job)
      toast.success({
        title: t('taskSteering.queuedTitle'),
        body: t('taskSteering.queuedBody'),
      })
    } catch (err) {
      setError(err.message)
      toast.error({ title: t('toast.jobSteerFailed'), body: err.message })
    } finally {
      setSteeringSubmitting(false)
    }
  }

  async function handleApprovePlan(steps) {
    if (!selectedJob || planApproving) return
    setPlanApproving(true)
    setError('')
    try {
      const result = await approveJobPlan(selectedJob.id, { steps })
      if (result.job) setSelectedJob(result.job)
      toast.success({
        title: t('taskSteering.planApproved'),
        body: t('taskSteering.planApprovedBody'),
      })
    } catch (err) {
      setError(err.message)
      toast.error({ title: t('toast.jobPlanApproveFailed'), body: err.message })
    } finally {
      setPlanApproving(false)
    }
  }

  const finalStep = selectedJob?.steps?.find((step) => step.kind === 'finalize' && step.status === 'completed')
  const verifyStep = selectedJob?.steps?.find((step) => step.kind === 'verify')
  const finalEvidence = Array.isArray(finalStep?.output?.evidence)
    ? finalStep.output.evidence
    : Array.isArray(verifyStep?.output?.evidence)
      ? verifyStep.output.evidence
      : []
  const latestSuspension = selectedJob?.status === 'waiting'
    ? [...(selectedJob.events || [])]
        .reverse()
        .find((event) => event.type === 'plan_proposed' || event.type === 'awaiting_user')
    : null

  // ★ 交付诚实度:buildFinalOutput 已经算出 complete / issues,
  //   但面板此前无论如何都画一个绿色对勾 + 「本次交付」。
  //   信号产生了却没接到决策上 —— 正是 PPT 事故的同一个病根。
  const finalIssues = Array.isArray(finalStep?.output?.issues) ? finalStep.output.issues : []
  const finalIncomplete = finalStep?.output?.complete === false || finalIssues.length > 0
  const pendingClarification = latestSuspension?.type === 'awaiting_user'
    ? latestSuspension.payload?.clarification
    : null
  const pendingPlan = latestSuspension?.type === 'plan_proposed'
    ? latestSuspension.payload?.plan
    : null
  const pendingDirectoryRequest = pendingClarification?.request_type === 'directory'
    ? pendingClarification
    : null

  async function handleDirectoryAuthorization({ path, accessMode, usePicker = false }) {
    if (!selectedJob || directoryBusy) return
    setDirectoryBusy(usePicker ? 'picker' : 'grant')
    setError('')
    try {
      const result = await authorizeRequestedDirectory({
        jobId: selectedJob.id,
        path,
        accessMode,
        purpose: pendingDirectoryRequest?.purpose || pendingDirectoryRequest?.why || '',
        usePicker,
      })
      if (result.cancelled) {
        toast.info({ title: t('taskSteering.directoryPickerCancelled') })
        return
      }
      if (result.job) {
        setSelectedJob(result.job)
        setJobs((current) => current.map((item) => item.id === result.job.id ? result.job : item))
      }
      toast.success({
        title: t('taskSteering.directoryGranted'),
        body: result.path,
      })
    } catch (err) {
      setError(err.message)
      toast.error({ title: t('taskSteering.directoryGrantFailed'), body: err.message })
    } finally {
      setDirectoryBusy('')
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="px-7 py-5 border-b border-dashed border-ink-fade/40">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">TASK CENTER · 后台作业台</span>
          <h1 className="font-hand text-[28px] text-ink mt-1.5">把一句话，交给后台继续做完。</h1>
          <form onSubmit={handleCreate} className="mt-4 flex gap-2">
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：生成 30 份行业周报并导出"
              className="flex-1 h-11 px-4 rounded-md border border-ink/30 bg-paper outline-none focus:border-ember text-sm"
            />
            <button
              disabled={submitting || !prompt.trim()}
              className="h-11 px-5 rounded-md bg-ember text-paper font-hand text-sm disabled:opacity-50"
            >
              {submitting ? '创建中…' : '开始任务'}
            </button>
          </form>
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        </header>

        <section className="flex-1 min-h-0 grid grid-cols-[320px_minmax(0,1fr)]">
          <aside className="border-r border-dashed border-ink-fade/40 p-4 overflow-y-auto">
            <div className="flex flex-wrap gap-2 mb-4">
              {FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  onClick={() => setActiveFilter(filter.key)}
                  className={`h-7 px-3 rounded-full border text-xs ${
                    activeFilter === filter.key
                      ? 'bg-ink text-paper border-ink'
                      : 'border-ink-fade/60 text-ink-soft'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            {loading ? (
              <p className="text-sm text-ink-fade">正在加载任务…</p>
            ) : visibleJobs.length === 0 ? (
              <div className="rounded-md border border-dashed border-ink-fade/40 p-4 text-sm text-ink-fade">
                这里还没有任务。上面写一句需求，系统会替你接住长活。
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {visibleJobs.map((job) => (
                  <button
                    key={job.id}
                    onClick={() => {
                      setSelectedArtifact(null)
                      setSelectedJobId(job.id)
                    }}
                    className={`text-left rounded-md border p-3 transition-colors ${
                      selectedJobId === job.id
                        ? 'border-ember bg-ember-soft'
                        : 'border-ink/20 hover:border-ink/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-ink line-clamp-2">{job.title}</span>
                      <span className="text-[10px] text-ink-fade shrink-0">{job.progress}%</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-ink-soft">
                      <span>{STATUS_LABELS[job.status] || job.status}</span>
                      <span>{formatTime(job.updatedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </aside>

          <div className="p-5 overflow-y-auto">
            {!selectedJob ? (
              <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-ink-fade">
                <LayoutList className="w-8 h-8" />
                <p className="text-sm">选中一个任务，右侧会展开它的过程和结果。</p>
              </div>
            ) : (
              <div className="max-w-4xl mx-auto flex flex-col gap-5">
                <div className="rounded-md border border-ink/20 bg-paper-2 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">JOB · {selectedJob.id}</span>
                      <h2 className="font-hand text-2xl text-ink mt-1">{selectedJob.title}</h2>
                      <p className="text-sm text-ink-soft mt-1">{selectedJob.prompt}</p>
                    </div>
                    <div className="flex gap-2">
                      {ACTIVE_STATUSES.has(selectedJob.status) && (
                        <button onClick={handleCancel} className="h-9 px-3 border border-ink/40 rounded-md text-sm flex items-center gap-1.5">
                          <PauseCircle className="w-4 h-4" />
                          终止
                        </button>
                      )}
                      {['failed', 'cancelled'].includes(selectedJob.status) && (
                        <button onClick={handleRetry} className="h-9 px-3 border border-ink/40 rounded-md text-sm flex items-center gap-1.5">
                          <RotateCcw className="w-4 h-4" />
                          重试
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-4 gap-3 text-sm">
                    <div>
                      <p className="text-[11px] text-ink-fade">状态</p>
                      <p className="text-ink mt-1">{STATUS_LABELS[selectedJob.status] || selectedJob.status}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-ink-fade">进度</p>
                      <p className="text-ink mt-1">{selectedJob.progress}%</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-ink-fade">创建时间</p>
                      <p className="text-ink mt-1">{formatTime(selectedJob.createdAt)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-ink-fade">更新时间</p>
                      <p className="text-ink mt-1">{formatTime(selectedJob.updatedAt)}</p>
                    </div>
                  </div>
                  {ACTIVE_STATUSES.has(selectedJob.status) && selectedJob.status !== 'cancel_requested' && !pendingPlan && (
                    <form onSubmit={handleSteer} className="mt-4 flex gap-2 border-t border-dashed border-ink-fade/40 pt-4">
                      <input
                        value={steering}
                        onChange={(event) => setSteering(event.target.value)}
                        maxLength={20_000}
                        placeholder={t('taskSteering.placeholder')}
                        className="flex-1 h-10 px-3 rounded-md border border-ink/25 bg-paper outline-none focus:border-ember text-sm"
                      />
                      <button
                        disabled={steeringSubmitting || !steering.trim()}
                        className="h-10 px-4 rounded-md border border-ember/60 text-ember text-sm inline-flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Send className="w-4 h-4" />
                        {steeringSubmitting ? t('taskSteering.sending') : t('taskSteering.send')}
                      </button>
                    </form>
                  )}
                  {/* ★ job 级失败原因以前存了却从不显示,用户只能看到步骤级错误 ——
                      而「被澄清打断」「预算耗尽」这类原因只记在 job 上 */}
                  {selectedJob.error && (
                    <div className="mt-3 rounded-md border border-dashed border-red-500/50 bg-red-500/5 p-3">
                      <p className="text-[11px] text-red-600">失败原因</p>
                      <p className="text-sm text-ink mt-1 break-words">{selectedJob.error}</p>
                    </div>
                  )}
                  {selectedJob.status === 'awaiting_approval' && (
                    <div className="mt-3 rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-3 flex items-center gap-3">
                      <p className="text-sm text-ink flex-1">这个任务正在等你批准一个操作。</p>
                      <button
                        onClick={() => navigate('/approvals')}
                        className="h-8 px-3 border border-amber-500/60 rounded-md text-sm text-amber-700 hover:bg-amber-500/10 transition-colors shrink-0"
                      >
                        去审批
                      </button>
                    </div>
                  )}
                  {pendingDirectoryRequest ? (
                    <DirectoryRequestCard
                      key={pendingDirectoryRequest.timestamp || pendingDirectoryRequest.question}
                      request={pendingDirectoryRequest}
                      busy={directoryBusy}
                      onAuthorize={handleDirectoryAuthorization}
                      t={t}
                    />
                  ) : pendingClarification?.question && (
                    <div className="mt-3 rounded-md border border-dashed border-sky-500/50 bg-sky-500/5 p-3">
                      <p className="text-[11px] text-sky-700">{t('taskSteering.waitingTitle')}</p>
                      <p className="text-sm text-ink mt-1">{pendingClarification.question}</p>
                      {pendingClarification.why && (
                        <p className="text-xs text-ink-soft mt-1">{pendingClarification.why}</p>
                      )}
                      {Array.isArray(pendingClarification.options) && pendingClarification.options.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {pendingClarification.options.map((option) => (
                            <button
                              key={option}
                              type="button"
                              onClick={() => setSteering(option)}
                              className="px-2.5 py-1 rounded-md border border-sky-500/40 text-xs text-sky-800 hover:bg-sky-500/10"
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {pendingPlan && (
                    <EditablePlanCard
                      key={(pendingPlan.steps || []).map((step) => `${step.id}:${step.title}`).join('|')}
                      plan={pendingPlan}
                      disabled={planApproving}
                      onApprove={handleApprovePlan}
                      t={t}
                    />
                  )}
                </div>

                {finalStep?.output && (
                  <section className={`rounded-md border p-4 ${
                    finalIncomplete
                      ? 'border-amber-400/60 bg-amber-50/60'
                      : 'border-ember/40 bg-ember-soft/40'
                  }`}>
                    <div className="flex items-center gap-2">
                      {finalIncomplete
                        ? <AlertTriangle className="w-4 h-4 text-amber-600" />
                        : <CheckCircle2 className="w-4 h-4 text-ember" />}
                      <h3 className="font-hand text-lg text-ink">
                        {finalIncomplete ? '本次交付（未全部达成）' : '本次交付'}
                      </h3>
                    </div>
                    {finalStep.output.summary && (
                      <p className={`mt-2 text-sm font-medium ${finalIncomplete ? 'text-amber-800' : 'text-ink'}`}>
                        {finalStep.output.summary}
                      </p>
                    )}
                    {finalIssues.length > 0 && (
                      <ul className="mt-2 space-y-1 border-l-2 border-amber-400 pl-3">
                        {finalIssues.map((issue, index) => (
                          <li key={index} className="text-xs leading-5 text-amber-800">{issue}</li>
                        ))}
                      </ul>
                    )}
                    {finalStep.output.text && (
                      <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">
                        {finalStep.output.text}
                      </div>
                    )}
                    {finalEvidence.length > 0 && (
                      <details className="mt-3 border-t border-dashed border-ink-fade/40 pt-3">
                        <summary className="cursor-pointer text-xs font-medium text-ink">
                          查看验收依据（{finalEvidence.length}）
                        </summary>
                        <div className="mt-2 space-y-2">
                          {finalEvidence.map((item, index) => (
                            <p key={`${index}-${item.slice(0, 24)}`} className="whitespace-pre-wrap break-words text-xs leading-5 text-ink-soft">
                              {item}
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                  </section>
                )}

                <div className="grid grid-cols-[1.2fr_0.8fr] gap-4">
                  <section className="rounded-md border border-ink/20 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Activity className="w-4 h-4 text-ember" />
                      <h3 className="font-hand text-lg text-ink">子任务</h3>
                    </div>
                    <div className="flex flex-col gap-2">
                      {(selectedJob.steps || []).map((step) => (
                        <div key={step.id} className="rounded-md border border-dashed border-ink-fade/40 p-3">
                          <div className="flex items-center gap-2">
                            <StepDot status={step.status} />
                            <span className="text-sm text-ink">{step.title}</span>
                            <span className="ml-auto text-xs text-ink-fade">{STATUS_LABELS[step.status] || step.status}</span>
                          </div>
                          {step.error && <p className="text-xs text-red-600 mt-2">{step.error}</p>}
                          {step.output?.text && <p className="text-xs text-ink-soft mt-2">{step.output.text}</p>}
                          {stepAcceptance(step).length > 0 && (
                            <details className="mt-2 text-xs text-ink-fade">
                              <summary className="cursor-pointer">验收标准</summary>
                              <ul className="mt-1.5 ml-4 list-disc space-y-1">
                                {stepAcceptance(step).map((item) => <li key={item}>{item}</li>)}
                              </ul>
                            </details>
                          )}
                          {step.status === 'failed' && (
                            <button
                              onClick={() => handleRetryStep(step.id)}
                              className="mt-2 text-xs text-ember inline-flex items-center gap-1"
                            >
                              <RotateCcw className="w-3 h-3" />
                              重试这个步骤
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>

                  <div className="flex flex-col gap-4">
                    <section className="rounded-md border border-ink/20 p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <Clock3 className="w-4 h-4 text-ember" />
                        <h3 className="font-hand text-lg text-ink">事件流</h3>
                      </div>
                      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                        {(selectedJob.events || []).slice().reverse().map((event) => (
                          <div key={event.id} className="text-xs">
                            <p className="text-ink">{event.message}</p>
                            <p className="text-ink-fade">{formatTime(event.createdAt)}</p>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="rounded-md border border-ink/20 p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <CheckCircle2 className="w-4 h-4 text-ember" />
                        <h3 className="font-hand text-lg text-ink">产物</h3>
                      </div>
                      {(selectedJob.artifacts || []).length ? (
                        <div className="flex flex-col gap-2">
                          {selectedJob.artifacts.map((artifact) => {
                            const active = selectedArtifact?.id === artifact.id
                            return (
                              <div
                                key={artifact.id}
                                className={`rounded-md border p-2 flex items-center gap-2 ${
                                  active ? 'border-ember bg-ember-soft' : 'border-ink/15'
                                }`}
                              >
                                <button
                                  onClick={() => setSelectedArtifact(artifact)}
                                  className="flex-1 text-left text-sm text-ink hover:text-ember truncate"
                                  title="预览"
                                >
                                  {artifact.title || artifact.filename}
                                </button>
                                <button
                                  onClick={() => setSelectedArtifact(artifact)}
                                  className="h-7 w-7 inline-flex items-center justify-center rounded border border-ink/20 text-ink-soft"
                                  aria-label="预览"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                                <a
                                  href={withDownloadToken(artifact.url)}
                                  download={artifact.filename || ''}
                                  className="text-xs text-ember"
                                >
                                  下载
                                </a>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-ink-fade">这个任务还没有生成可下载产物。</p>
                      )}
                    </section>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      {selectedArtifact && (
        <TaskArtifactPreview
          key={selectedArtifact.id}
          artifact={selectedArtifact}
          onClose={() => setSelectedArtifact(null)}
        />
      )}
    </div>
  )
}

export function DirectoryRequestCard({ request, busy, onAuthorize, t }) {
  const [path, setPath] = useState(request.suggested_path || '')
  const [accessMode, setAccessMode] = useState(request.access_mode === 'read_write' ? 'read_write' : 'read_only')
  return (
    <div className="mt-3 rounded-md border border-dashed border-sky-500/50 bg-sky-500/5 p-3" data-testid="directory-request-card">
      <div className="flex items-start gap-2">
        <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
        <div className="min-w-0">
          <p className="text-[11px] text-sky-700">{t('taskSteering.directoryRequestTitle')}</p>
          <p className="mt-1 text-sm text-ink">{request.why || request.purpose || request.question}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 md:flex-row">
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && path.trim() && !busy) onAuthorize({ path, accessMode, usePicker: false }) }}
          placeholder={t('taskSteering.directoryPathPlaceholder')}
          className="h-9 min-w-0 flex-1 rounded-md border border-sky-500/30 bg-paper px-3 font-mono text-xs text-ink outline-none focus:border-sky-600"
        />
        <select
          value={accessMode}
          onChange={(event) => setAccessMode(event.target.value)}
          disabled={!!busy}
          aria-label={t('taskSteering.directoryAccessMode')}
          className="h-9 rounded-md border border-sky-500/30 bg-paper px-2 text-xs text-ink"
        >
          <option value="read_only">{t('taskSteering.directoryReadOnly')}</option>
          <option value="read_write">{t('taskSteering.directoryReadWrite')}</option>
        </select>
        <button type="button" onClick={() => onAuthorize({ path, accessMode, usePicker: false })} disabled={!!busy || !path.trim()} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-sky-600/50 px-3 text-xs text-sky-800 disabled:opacity-40">
          {busy === 'grant' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
          {t('taskSteering.authorizeDirectory')}
        </button>
        <button type="button" onClick={() => onAuthorize({ path, accessMode, usePicker: true })} disabled={!!busy} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-sky-700 px-3 text-xs text-white disabled:opacity-40">
          {busy === 'picker' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
          {t('taskSteering.chooseDirectory')}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-ink-fade">{t('taskSteering.directorySecurityHint')}</p>
    </div>
  )
}

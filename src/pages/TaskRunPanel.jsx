import { useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, Clock3, LayoutList, PauseCircle, RotateCcw, Eye } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import TaskArtifactPreview from './TaskArtifactPreview.jsx'
import {
  cancelJob,
  createJob,
  getJob,
  listJobs,
  retryJob,
  retryStep,
  subscribeToJobEvents,
  withDownloadToken,
} from '../lib/jobClient.js'

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
  completed: '已完成',
  failed: '失败',
  cancel_requested: '终止中',
  cancelled: '已终止',
})

const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'waiting', 'cancel_requested'])

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

export default function TaskRunPanel() {
  const [prompt, setPrompt] = useState('')
  const [jobs, setJobs] = useState([])
  const [selectedJobId, setSelectedJobId] = useState(null)
  const [selectedJob, setSelectedJob] = useState(null)
  const [selectedArtifact, setSelectedArtifact] = useState(null)
  const [activeFilter, setActiveFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

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

  useEffect(() => subscribeToJobEvents(() => {
    Promise.all([
      listJobs(),
      selectedJobId ? getJob(selectedJobId) : Promise.resolve({ job: null }),
    ])
      .then(([jobsPayload, jobPayload]) => {
        setJobs(jobsPayload.jobs)
        if (jobPayload.job) setSelectedJob(jobPayload.job)
      })
      .catch((err) => setError(err.message))
  }), [selectedJobId])

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
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel() {
    if (!selectedJob) return
    const { job } = await cancelJob(selectedJob.id)
    setSelectedJob(job)
    setJobs((current) => current.map((item) => item.id === job.id ? job : item))
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
                </div>

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

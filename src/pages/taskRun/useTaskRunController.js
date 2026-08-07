import { useEffect, useRef, useState } from 'react'
import {
  approveJobPlan, cancelJob, createJob, getJob, listJobs, retryJob, retryStep, steerJob, subscribeToJobEvents,
} from '../../lib/jobClient.js'
import { authorizeRequestedDirectory } from '../../lib/jobDirectoryRequest.js'
import { ACTIVE_STATUSES } from './taskRunUtils.js'

export default function useTaskRunController({ linkedJobId, t, toast }) {
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

  useEffect(() => { selectedJobIdRef.current = selectedJobId }, [selectedJobId])
  useEffect(() => { hasActiveJobsRef.current = jobs.some((job) => ACTIVE_STATUSES.has(job.status)) }, [jobs])
  useEffect(() => {
    let active = true
    listJobs().then(({ jobs: nextJobs }) => {
      if (!active) return
      setJobs(nextJobs)
      setSelectedJobId((current) => current || nextJobs[0]?.id || null)
    }).catch((reason) => { if (active) setError(reason.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    if (!selectedJobId) return undefined
    getJob(selectedJobId).then(({ job }) => { if (active) setSelectedJob(job) }).catch((reason) => { if (active) setError(reason.message) })
    return () => { active = false }
  }, [selectedJobId])

  useEffect(() => {
    let active = true
    let refreshTimer = null
    let fallbackTimer = null
    let refreshing = false
    let refreshQueued = false
    let lastIdleRefreshAt = Date.now()
    const scheduleRefresh = (delay = 120) => {
      if (!active) return
      refreshQueued = true
      if (refreshTimer != null) return
      refreshTimer = window.setTimeout(() => { refreshTimer = null; refresh() }, delay)
    }
    const refresh = async () => {
      if (!active) return
      if (refreshing) { refreshQueued = true; return }
      refreshing = true
      refreshQueued = false
      const jobId = selectedJobIdRef.current
      const [jobsResult, jobResult] = await Promise.allSettled([listJobs(), jobId ? getJob(jobId) : Promise.resolve({ job: null })])
      if (active) {
        if (jobsResult.status === 'fulfilled') setJobs(jobsResult.value.jobs)
        if (jobResult.status === 'fulfilled' && jobResult.value.job && jobId === selectedJobIdRef.current) setSelectedJob(jobResult.value.job)
        if (jobsResult.status === 'rejected' && jobResult.status === 'rejected') setError(jobsResult.reason?.message || jobResult.reason?.message || t('taskCenter.refreshFailed'))
      }
      refreshing = false
      if (active && refreshQueued) scheduleRefresh(0)
    }
    const unsubscribe = subscribeToJobEvents(() => scheduleRefresh(), { onConnectionChange: ({ state }) => { if (state === 'open') scheduleRefresh(0) } })
    const handleVisibilityChange = () => { if (document.visibilityState === 'visible') scheduleRefresh(0) }
    const handleOnline = () => scheduleRefresh(0)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('online', handleOnline)
    fallbackTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (!hasActiveJobsRef.current && now - lastIdleRefreshAt < 30_000) return
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
  }, [t])

  const updateJob = (job) => {
    setSelectedJob(job)
    setJobs((current) => current.map((item) => item.id === job.id ? job : item))
  }
  const handleCreate = async (event) => {
    event.preventDefault()
    const trimmed = prompt.trim()
    if (!trimmed) return
    setSubmitting(true); setError('')
    try {
      const { job } = await createJob(trimmed)
      setPrompt(''); setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]); setSelectedJobId(job.id); setSelectedJob(job)
    } catch (reason) { setError(reason.message); toast.error({ title: t('toast.chatSendFailed'), body: reason.message }) }
    finally { setSubmitting(false) }
  }
  const handleCancel = async () => {
    if (!selectedJob) return
    try { updateJob((await cancelJob(selectedJob.id)).job) }
    catch (reason) { setError(reason.message); toast.error({ title: t('toast.jobAbortFailed'), body: reason.message }) }
  }
  const handleRetry = async () => { if (selectedJob) updateJob((await retryJob(selectedJob.id)).job) }
  const handleRetryStep = async (stepId) => { if (selectedJob) updateJob((await retryStep(selectedJob.id, stepId)).job) }
  const handleSteer = async (event) => {
    event.preventDefault()
    const content = steering.trim()
    if (!selectedJob || !content || steeringSubmitting) return
    setSteeringSubmitting(true); setError('')
    try {
      const result = await steerJob(selectedJob.id, content)
      setSteering(''); if (result.job) setSelectedJob(result.job)
      toast.success({ title: t('taskSteering.queuedTitle'), body: t('taskSteering.queuedBody') })
    } catch (reason) { setError(reason.message); toast.error({ title: t('toast.jobSteerFailed'), body: reason.message }) }
    finally { setSteeringSubmitting(false) }
  }
  const handleApprovePlan = async (steps) => {
    if (!selectedJob || planApproving) return
    setPlanApproving(true); setError('')
    try {
      const result = await approveJobPlan(selectedJob.id, { steps })
      if (result.job) setSelectedJob(result.job)
      toast.success({ title: t('taskSteering.planApproved'), body: t('taskSteering.planApprovedBody') })
    } catch (reason) { setError(reason.message); toast.error({ title: t('toast.jobPlanApproveFailed'), body: reason.message }) }
    finally { setPlanApproving(false) }
  }

  const latestSuspension = selectedJob?.status === 'waiting' ? [...(selectedJob.events || [])].reverse().find((event) => event.type === 'plan_proposed' || event.type === 'awaiting_user') : null
  const pendingClarification = latestSuspension?.type === 'awaiting_user' ? latestSuspension.payload?.clarification : null
  const pendingPlan = latestSuspension?.type === 'plan_proposed' ? latestSuspension.payload?.plan : null
  const pendingDirectoryRequest = pendingClarification?.request_type === 'directory' ? pendingClarification : null
  const handleDirectoryAuthorization = async ({ path, accessMode, usePicker = false }) => {
    if (!selectedJob || directoryBusy) return
    setDirectoryBusy(usePicker ? 'picker' : 'grant'); setError('')
    try {
      const result = await authorizeRequestedDirectory({ jobId: selectedJob.id, path, accessMode, purpose: pendingDirectoryRequest?.purpose || pendingDirectoryRequest?.why || '', usePicker })
      if (result.cancelled) return toast.info({ title: t('taskSteering.directoryPickerCancelled') })
      if (result.job) updateJob(result.job)
      toast.success({ title: t('taskSteering.directoryGranted'), body: result.path })
    } catch (reason) { setError(reason.message); toast.error({ title: t('taskSteering.directoryGrantFailed'), body: reason.message }) }
    finally { setDirectoryBusy('') }
  }

  return {
    prompt, setPrompt, jobs, selectedJobId, selectedJob, selectedArtifact, setSelectedArtifact, activeFilter, setActiveFilter,
    loading, submitting, steering, setSteering, steeringSubmitting, planApproving, directoryBusy, error,
    pendingClarification, pendingPlan, pendingDirectoryRequest, handleCreate, handleCancel, handleRetry, handleRetryStep,
    handleSteer, handleApprovePlan, handleDirectoryAuthorization,
    selectJob: (id) => { setSelectedArtifact(null); setSelectedJobId(id) },
  }
}

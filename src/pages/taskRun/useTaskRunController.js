import { useCallback, useEffect, useRef, useState } from 'react'
import {
  approveJobPlan, cancelJob, createJob, getJob, listJobs, retryJob, retryStep, steerJob, subscribeToJobEvents,
} from '../../lib/jobClient.js'
import { authorizeRequestedDirectory } from '../../lib/jobDirectoryRequest.js'
import { getModelStatus } from '../../lib/modelClient.js'
import {
  readStoredModelSelection,
  resolveInitialModelSelection,
  SELECTED_MODEL_STORAGE_KEY,
} from '../../lib/modelSelection.js'
import {
  modelCatalogStateFromStatus,
  modelOptionsFromStatus,
  modelReadinessMessageKey,
  resolveChatModelReadiness,
} from '../ChatSplit/chatModelReadiness.js'
import { ACTIVE_STATUSES } from './taskRunUtils.js'

const CONFIGURE_MODEL_ACTIONS = new Set([
  'configure_model',
  'test_provider',
  'choose_agent_provider',
])

const CONFIGURE_MODEL_CODES = new Set([
  'MODEL_CONFIG_MISSING',
  'MODEL_PROVIDER_UNVERIFIED',
  'MODEL_PROVIDER_CHAT_ONLY',
  'MODEL_PROVIDER_UNAVAILABLE',
  'MODEL_PROVIDER_AMBIGUOUS',
])

function recoveryField(reason, field) {
  return reason?.[field] ?? reason?.details?.[field]
}

export function taskRunErrorRecovery(reason, { jobId, stepId } = {}) {
  const code = String(reason?.code || '').trim()
  const action = String(reason?.action || '').trim()
  if (action === 'verify_model_request' || code === 'MODEL_REQUEST_OUTCOME_UNKNOWN') {
    const normalizedJobId = String(jobId || recoveryField(reason, 'jobId') || '').trim()
    const normalizedStepId = String(recoveryField(reason, 'stepId') || stepId || '').trim()
    const modelRequestId = String(recoveryField(reason, 'modelRequestId') || '').trim()
    return {
      action: 'verify_model_request',
      target: normalizedJobId && normalizedStepId && modelRequestId
        ? {
            scopeKind: 'job',
            jobId: normalizedJobId,
            stepId: normalizedStepId,
            modelRequestId,
          }
        : null,
    }
  }
  if (action === 'recreate_job'
    || ['MODEL_REQUEST_CONTEXT_DRIFT', 'MODEL_PROVIDER_CONFIG_CHANGED', 'MODEL_PROVIDER_BINDING_MISSING'].includes(code)) {
    return { action: 'recreate_job', target: null }
  }
  if (CONFIGURE_MODEL_ACTIONS.has(action) || CONFIGURE_MODEL_CODES.has(code)) {
    return { action: 'configure_model', target: null }
  }
  return { action: '', target: null }
}

export function taskRunJobFailureRecovery(job) {
  if (!job || job.status !== 'failed') return null
  const event = [...(job.events || [])].reverse().find((candidate) => candidate?.type === 'failed')
  if (!event?.payload
    || typeof event.payload !== 'object'
    || (!event.payload.code && !event.payload.action)) return null
  const failure = {
    ...event.payload,
    stepId: event.payload.stepId || event.stepId || null,
  }
  const recovery = taskRunErrorRecovery(failure, {
    jobId: job.id,
    stepId: event.stepId || null,
  })
  if (!recovery.action) return null
  return {
    message: String(event.message || job.error || '').trim(),
    failure: {
      code: String(failure.code || '').trim() || null,
      action: String(failure.action || '').trim() || null,
      providerId: failure.providerId ?? job.modelProviderId ?? null,
      modelName: failure.modelName ?? job.modelName ?? null,
      configRevision: failure.configRevision ?? job.modelConfigRevision ?? null,
    },
    ...recovery,
  }
}

export function shouldClearTaskErrorAfterJobRefresh(previousJob, nextJob) {
  const previousId = String(previousJob?.id || '').trim()
  const nextId = String(nextJob?.id || '').trim()
  return Boolean(
    previousId
    && previousId === nextId
    && previousJob?.status === 'failed'
    && nextJob?.status !== 'failed',
  )
}

const TASK_MODEL_FAILURES = Object.freeze({
  'provider-unverified': { code: 'MODEL_PROVIDER_UNVERIFIED', action: 'test_provider' },
  'provider-chat-only': { code: 'MODEL_PROVIDER_CHAT_ONLY', action: 'choose_agent_provider' },
  'provider-unavailable': { code: 'MODEL_PROVIDER_UNAVAILABLE', action: 'test_provider' },
})

export function resolveTaskModelPreflight({ status = {}, selection = {}, t = (key) => key } = {}) {
  const modelOptions = modelOptionsFromStatus(status)
  const effectiveSelection = resolveInitialModelSelection(modelOptions, selection)
  const readiness = resolveChatModelReadiness({
    catalogState: modelCatalogStateFromStatus(status, modelOptions),
    modelOptions,
    modelName: effectiveSelection.modelName,
    modelProviderId: effectiveSelection.providerId,
  })
  if (readiness.kind === 'ready') return { ok: true, selection: effectiveSelection, readiness }

  const blockedReadiness = {
    ...readiness,
    canSend: readiness.kind === 'provider-chat-only' ? false : readiness.canSend,
  }
  const failure = TASK_MODEL_FAILURES[readiness.kind] || {
    code: 'MODEL_CONFIG_MISSING',
    action: 'configure_model',
  }
  const error = new Error(t(modelReadinessMessageKey(blockedReadiness) || 'chat.modelPicker.unconfiguredSendBlocked'))
  error.code = failure.code
  error.action = failure.action
  return { ok: false, selection: effectiveSelection, readiness: blockedReadiness, error }
}

function loadingTaskModelReadiness(modelName = '') {
  return { kind: 'loading', canSend: false, modelName: String(modelName || '').trim() }
}

function failedTaskModelReadiness(modelName = '') {
  return { kind: 'error', canSend: false, modelName: String(modelName || '').trim() }
}

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
  const [errorAction, setErrorAction] = useState('')
  const [modelRecoveryTarget, setModelRecoveryTarget] = useState(null)
  const [modelSelection, setModelSelection] = useState(() => readStoredModelSelection())
  const [modelReadiness, setModelReadiness] = useState(() => loadingTaskModelReadiness(modelSelection.modelName))
  const [modelStatusRevision, setModelStatusRevision] = useState(0)
  const selectedJobIdRef = useRef(selectedJobId)
  const previousSelectedJobRef = useRef(null)
  const hasActiveJobsRef = useRef(false)
  const reloadModelReadiness = useCallback(() => {
    const selection = readStoredModelSelection()
    setModelSelection(selection)
    setModelReadiness(loadingTaskModelReadiness(selection.modelName))
    setModelStatusRevision((revision) => revision + 1)
  }, [])

  useEffect(() => { selectedJobIdRef.current = selectedJobId }, [selectedJobId])
  useEffect(() => { hasActiveJobsRef.current = jobs.some((job) => ACTIVE_STATUSES.has(job.status)) }, [jobs])
  useEffect(() => {
    if (shouldClearTaskErrorAfterJobRefresh(previousSelectedJobRef.current, selectedJob)) {
      setError('')
      setErrorAction('')
      setModelRecoveryTarget(null)
    }
    previousSelectedJobRef.current = selectedJob
  }, [selectedJob])
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
    const storedSelection = readStoredModelSelection()
    getModelStatus().then((status) => {
      if (!active) return
      const preflight = resolveTaskModelPreflight({ status, selection: storedSelection, t })
      setModelSelection(preflight.selection)
      setModelReadiness(preflight.readiness)
    }).catch(() => {
      if (!active) return
      setModelSelection(storedSelection)
      setModelReadiness(failedTaskModelReadiness(storedSelection.modelName))
    })
    return () => { active = false }
  }, [modelStatusRevision, t])
  useEffect(() => {
    const refreshStoredSelection = (event) => {
      if (!event || event.key === SELECTED_MODEL_STORAGE_KEY) reloadModelReadiness()
    }
    window.addEventListener('model-providers:changed', reloadModelReadiness)
    window.addEventListener('storage', refreshStoredSelection)
    return () => {
      window.removeEventListener('model-providers:changed', reloadModelReadiness)
      window.removeEventListener('storage', refreshStoredSelection)
    }
  }, [reloadModelReadiness])
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
  const clearTaskError = () => {
    setError('')
    setErrorAction('')
    setModelRecoveryTarget(null)
  }
  const captureError = (reason, context) => {
    const recovery = taskRunErrorRecovery(reason, context)
    setError(reason?.message || String(reason))
    setErrorAction(recovery.action)
    setModelRecoveryTarget(recovery.target)
  }
  const handleCreate = async (event) => {
    event.preventDefault()
    const trimmed = prompt.trim()
    if (!trimmed) return
    setSubmitting(true); clearTaskError()
    try {
      const selection = readStoredModelSelection()
      let status
      try {
        status = await getModelStatus()
      } catch (reason) {
        setModelSelection(selection)
        setModelReadiness(failedTaskModelReadiness(selection.modelName))
        throw reason
      }
      const preflight = resolveTaskModelPreflight({ status, selection, t })
      setModelSelection(preflight.selection)
      setModelReadiness(preflight.readiness)
      if (!preflight.ok) throw preflight.error
      const { job } = await createJob(trimmed, {
        modelName: preflight.selection.modelName || undefined,
        providerId: preflight.selection.providerId || undefined,
      })
      setPrompt(''); setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]); setSelectedJobId(job.id); setSelectedJob(job)
    } catch (reason) {
      captureError(reason)
      toast.error({ title: t('toast.chatSendFailed'), body: reason.message })
    }
    finally { setSubmitting(false) }
  }
  const handleCancel = async () => {
    if (!selectedJob) return
    clearTaskError()
    try { updateJob((await cancelJob(selectedJob.id)).job) }
    catch (reason) { setError(reason.message); toast.error({ title: t('toast.jobAbortFailed'), body: reason.message }) }
  }
  const handleRetry = async () => {
    if (!selectedJob) return
    clearTaskError()
    try { updateJob((await retryJob(selectedJob.id)).job) }
    catch (reason) { captureError(reason, { jobId: selectedJob.id }); toast.error({ title: t('toast.chatSendFailed'), body: reason.message }) }
  }
  const handleRetryStep = async (stepId) => {
    if (!selectedJob) return
    clearTaskError()
    try { updateJob((await retryStep(selectedJob.id, stepId)).job) }
    catch (reason) { captureError(reason, { jobId: selectedJob.id, stepId }); toast.error({ title: t('toast.chatSendFailed'), body: reason.message }) }
  }
  const handleSteer = async (event) => {
    event.preventDefault()
    const content = steering.trim()
    if (!selectedJob || !content || steeringSubmitting) return
    setSteeringSubmitting(true); clearTaskError()
    try {
      const result = await steerJob(selectedJob.id, content)
      setSteering(''); if (result.job) setSelectedJob(result.job)
      toast.success({ title: t('taskSteering.queuedTitle'), body: t('taskSteering.queuedBody') })
    } catch (reason) { setError(reason.message); toast.error({ title: t('toast.jobSteerFailed'), body: reason.message }) }
    finally { setSteeringSubmitting(false) }
  }
  const handleApprovePlan = async (steps) => {
    if (!selectedJob || planApproving) return
    setPlanApproving(true); clearTaskError()
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
  const jobFailureRecovery = taskRunJobFailureRecovery(selectedJob)
  const visibleError = error || jobFailureRecovery?.message || ''
  const visibleErrorAction = error ? errorAction : jobFailureRecovery?.action || ''
  const visibleModelRecoveryTarget = error
    ? modelRecoveryTarget
    : jobFailureRecovery?.target || null
  const handleDirectoryAuthorization = async ({ path, accessMode, authorizationScope }) => {
    if (!selectedJob || directoryBusy) return
    setDirectoryBusy('grant'); clearTaskError()
    try {
      const result = await authorizeRequestedDirectory({
        jobId: selectedJob.id,
        path,
        accessMode,
        scope: authorizationScope,
        purpose: pendingDirectoryRequest?.purpose || pendingDirectoryRequest?.why || '',
      })
      if (result.job) updateJob(result.job)
      toast.success({ title: t('taskSteering.directoryGranted'), body: result.path })
    } catch (reason) { setError(reason.message); toast.error({ title: t('taskSteering.directoryGrantFailed'), body: reason.message }) }
    finally { setDirectoryBusy('') }
  }

  return {
    prompt, setPrompt, jobs, selectedJobId, selectedJob, selectedArtifact, setSelectedArtifact, activeFilter, setActiveFilter,
    loading, submitting, steering, setSteering, steeringSubmitting, planApproving, directoryBusy,
    error: visibleError,
    errorAction: visibleErrorAction,
    modelRecoveryTarget: visibleModelRecoveryTarget,
    modelReadiness,
    modelSelection,
    reloadModelReadiness,
    jobFailureRecovery,
    pendingClarification, pendingPlan, pendingDirectoryRequest, handleCreate, handleCancel, handleRetry, handleRetryStep,
    handleSteer, handleApprovePlan, handleDirectoryAuthorization,
    selectJob: (id) => { clearTaskError(); setSelectedArtifact(null); setSelectedJobId(id) },
  }
}

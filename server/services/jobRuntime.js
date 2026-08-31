import crypto from 'node:crypto'
import { buildExploredPlan } from './jobPlanner.js'
import {
  appendJobEvent, completeJobStep,
  getJob as getJobRow, getJobWithChildren, listJobSteps,
  listJobs, listRecoverableJobs, updateJob, updateJobStep,
} from './jobStore.js'
import { createNotification } from './notificationsStore.js'
import { dispatchHooks } from './hooksService.js'
import { getLatestJobApproval } from './approvalStore.js'
import { getApprovalMode } from './approvalSettingsStore.js'
import { cancelJobWake, claimDueJobWakes, scheduleJobWake } from './jobWakeStore.js'
import {
  acknowledgeJobSteering,
  claimJobSteering,
  releaseAllJobSteeringLeases,
  releaseJobSteeringLease,
} from './jobSteeringStore.js'
import {
  enqueueJobSteeringTransition,
  requestJobCancellationTransition,
  resumeJobAfterApprovalTransition,
  retryJobTransition,
} from './jobRuntimeTransitionStore.js'
import {
  buildFinalOutput,
  deriveJobProgress,
  buildJobOutcomeDiagnostics,
  clearCompletedJobOutcomeDiagnostics,
  clearResumedJobOutcomeDiagnostics,
  findNextRunnableStep,
  persistedJobOutcomeFields,
  resolveWorkflowState,
  stepRequiresPlanApproval,
} from './jobWorkflow.js'
import {
  latestPersistedOutcomeFields,
  persistJobOutcomeDiagnostics,
  projectJobForClient,
} from './jobRuntimeProjection.js'
import { completeManualJobTransition, emitTaskReviewEvent, persistRejectedStepResult, runVerificationRepairLoop } from './jobAcceptanceRuntime.js'
import { applyRuntimeTaskPlanGuard } from './taskPlanGuard.js'
import {
  assertJobPlanApprovalResolved,
  assertJobPlanRetryAllowed,
  buildJobPlanProposalPayload,
  JOB_PLAN_APPROVAL_CONTRACT,
  JOB_PLAN_APPROVAL_VERSION,
  normalizeJobModelSnapshot,
  persistGuardedGeneratedPlan,
  persistGuardedStructuredPlan,
  resolveJobPlanApproval,
} from './jobPlanPolicyRuntime.js'
import { approveRuntimeJobPlan } from './jobPlanApprovalRuntime.js'
import { createJobRuntimeScheduler } from './jobRuntimeScheduler.js'
import { createJobExecutionLeaseCoordinator } from './jobExecutionLeaseRuntime.js'
import { createJobRuntimeCore } from './runtimeCore.js'
import { createJobTickBudgetScope } from './jobTickBudgetScope.js'
import { userCancellationError } from '../utils/toolCancellation.js'
import { resumeJobDirectoryAuthorization } from './jobDirectoryAuthorization.js'
import { lostJobExecutionLease, notifyJobStopHook, notifyJobTerminal } from './jobRuntimeLifecycle.js'
import { isModelReadinessError, resolveAgentModelRuntimeBinding } from './modelReadinessService.js'
import { runPlanningExploration } from './jobPlanningExplorationRuntime.js'
import { loadJobRetryCheckpoints, loadRetryCheckpoint, makeRetryCheckpointResumable } from './jobRetryRuntime.js'
import { runDefaultJobModel } from './jobModelExecutionRuntime.js'
import { createDefaultExecuteStep } from './jobStepExecutionRuntime.js'
import {
  wrapJobModelFailure,
} from './jobModelFailure.js'
import { persistJobStepFailure } from './jobStepFailureRuntime.js'
import { runJobRuntimeTick } from './jobRuntimeTick.js'
export { recoverInterruptedJobs } from './jobRuntimeLifecycle.js'
export { runPlanningExploration, selectPlanningToolSpecs } from './jobPlanningExplorationRuntime.js'
export { createDefaultExecuteStep }
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const RETRYABLE_JOB_STATUSES = new Set(['failed', 'cancelled'])
const RETRYABLE_STEP_STATUSES = new Set(['failed', 'cancelled'])
const JOB_CANCELLED_MESSAGE = '任务已由用户终止'
// ★ 注意:awaiting_approval 故意不在这里。等人的 job 崩溃恢复时若被重排成 queued,
// 会把已经批准执行过的动作重跑一遍(发消息/改日历这类不可撤销动作尤其危险)。
const SUSPENDED_JOB_STATUSES = new Set(['waiting', 'awaiting_approval'])

function hasRejectedCompletedOutcome(step) {
  if (step?.status !== 'completed') return false
  if (step.kind === 'verify') {
    const verdict = String(step.output?.acceptance?.verdict || '').trim().toLowerCase()
    return verdict && verdict !== 'pass'
  }
  return step.kind === 'finalize' && step.output?.complete === false
}

const COMPLETED_TASK_VERIFICATION_STATUSES = new Set([
  'pass',
  'passed',
  'success',
  'succeeded',
  'complete',
  'completed',
  'ok',
])

function hasExplicitIncompleteStepOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false
  if (output.complete === false || String(output.incompleteReason || '').trim()) return true
  if (Array.isArray(output.missingRequirements) && output.missingRequirements.length > 0) return true
  const verification = output.taskVerification
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return false
  return (Array.isArray(verification.checks) ? verification.checks : []).some((check) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) return true
    return !COMPLETED_TASK_VERIFICATION_STATUSES.has(String(check.status || '').trim().toLowerCase())
  })
}

function uniqueJobSteps(steps = []) {
  return [...new Map(
    steps.filter((step) => step?.id).map((step) => [step.id, step]),
  ).values()]
}

function hasDeliveryProjectionFailure(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  if (job?.status !== 'failed' || !steps.length) return false
  const finalize = [...steps].reverse().find((step) => step.kind === 'finalize')
  const allStepsCompleted = steps.every((step) => step.status === 'completed')
  return finalize?.output?.complete === false
    || (allStepsCompleted && buildFinalOutput(job).complete === false)
}

function deliveryProjectionRecoverySteps(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  if (!hasDeliveryProjectionFailure(job)) return []
  const verify = [...steps].reverse().find((step) => step.kind === 'verify')
  const finalize = [...steps].reverse().find((step) => step.kind === 'finalize')
  const priorMutationStepsSettled = steps.every((step) => (
    ['verify', 'finalize'].includes(step.kind) || step.status === 'completed'
  ))
  if (!verify || !priorMutationStepsSettled) return []

  // Verification is the safe repair stage: its prompt permits inspecting and
  // correcting prior work. Finalize must then run again so stale delivery
  // diagnostics cannot immediately return the job to failed. Completed execute
  // steps are intentionally not replayed because they may contain mutations.
  return uniqueJobSteps([verify, finalize].filter((step) => (
    step?.status === 'completed' || RETRYABLE_STEP_STATUSES.has(step?.status)
  )))
}

function deliveryProjectionDiagnosticResetStepIds(job, retrySteps) {
  if (!hasDeliveryProjectionFailure(job)) return []
  const retryStepIds = new Set(retrySteps.map((step) => step.id))
  return (Array.isArray(job?.steps) ? job.steps : [])
    .filter((step) => {
      if (step?.status !== 'completed' || retryStepIds.has(step.id)) return false
      const output = step.output && typeof step.output === 'object' && !Array.isArray(step.output)
        ? step.output
        : null
      if (!output) return false
      const resumed = clearResumedJobOutcomeDiagnostics(output)
      return Object.keys(output).some((key) => !Object.hasOwn(resumed, key))
    })
    .map((step) => step.id)
}

function retryStatusError(code, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = 409
  return error
}

function deliveryProjectionRetryBlocker(job) {
  if (!hasDeliveryProjectionFailure(job)) return null
  const verify = [...job.steps].reverse().find((step) => step.kind === 'verify')
  if (!verify) {
    return 'job delivery cannot be retried safely because the persisted plan has no verify stage; completed mutation steps were not replayed'
  }
  if (!['queued', 'pending', 'completed', 'failed', 'cancelled'].includes(verify.status)) {
    return `job delivery cannot be retried because verify stage is not recoverable from status ${verify.status}`
  }
  return null
}

function assertRetryHasRunnablePath(job, retrySteps) {
  if (retrySteps.length > 0) return
  const hasQueuedWork = job.steps.some((step) => ['queued', 'pending'].includes(step.status))
  if (hasQueuedWork) return
  throw retryStatusError(
    'JOB_RETRY_STATUS_INVALID',
    'job has no retryable step; completed mutation steps cannot be replayed safely and no verify/finalize recovery stage is available',
  )
}
function newId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

// ★ D6: job 进入这些终态事件后,从 jobUserCache 淘汰对应条目(防内存泄漏)。
const TERMINAL_EVENT_TYPES = new Set(['completed', 'failed', 'cancelled', 'aborted'])

const JOB_RUNTIME_TICK_DEPENDENCIES = {
  claimDueJobWakes,
  appendJobEvent,
  listRecoverableJobs,
  SUSPENDED_JOB_STATUSES,
  createJobTickBudgetScope,
  getJobRow,
  getJobWithChildren,
  listJobSteps,
  updateJob,
  updateJobStep,
  clearResumedJobOutcomeDiagnostics,
  latestPersistedOutcomeFields,
  JOB_CANCELLED_MESSAGE,
  deriveJobProgress,
  persistJobOutcomeDiagnostics,
  notifyJobTerminal,
  notifyJobStopHook,
  findNextRunnableStep,
  resolveWorkflowState,
  resolveJobPlanApproval,
  buildJobOutcomeDiagnostics,
  buildJobPlanProposalPayload,
  JOB_PLAN_APPROVAL_CONTRACT,
  JOB_PLAN_APPROVAL_VERSION,
  createNotification,
  isModelReadinessError,
  dispatchHooks,
  buildFinalOutput,
  clearCompletedJobOutcomeDiagnostics,
  userCancellationError,
  claimJobSteering,
  acknowledgeJobSteering,
  releaseJobSteeringLease,
  runVerificationRepairLoop,
  lostJobExecutionLease,
  hasExplicitIncompleteStepOutput,
  scheduleJobWake,
  cancelJobWake,
  persistRejectedStepResult,
  stepRequiresPlanApproval,
  getApprovalMode,
  emitTaskReviewEvent,
  persistJobStepFailure,
  TERMINAL_JOB_STATUSES,
}


export class JobRuntime {
  constructor({
    planner = (prompt, { userId, modelName, modelEnv } = {}) => buildExploredPlan(prompt, {
      userId,
      exploreModel: ({ messages }) => runPlanningExploration({ prompt, messages, userId, modelName, modelEnv }),
      runModel: ({ messages }) => runDefaultJobModel({ messages, userId, modelName, modelEnv }),
    }),
    executeStep = null,
    tickMs = 250,
    maxConcurrency = process.env.JOB_RUNTIME_CONCURRENCY,
    executionLeases = createJobExecutionLeaseCoordinator(),
    runtimeCore = null,
    taskPlanGuard = applyRuntimeTaskPlanGuard,
    modelBindingResolver = resolveAgentModelRuntimeBinding,
  } = {}) {
    this.planner = planner
    this.taskPlanGuard = taskPlanGuard
    this.resolveModelBinding = modelBindingResolver
    this.runtimeCore = runtimeCore || createJobRuntimeCore({ executionLeases })
    this.executeStep = executeStep || createDefaultExecuteStep({ runtimeCore: this.runtimeCore })
    // listeners 改成 Map<listener, userId>;userId === null 表示无过滤(给内部/测试用)。
    this.listeners = new Map()
    this.activeControllers = new Map()
    this.activeJobIds = new Set()
    this.activeTicks = new Set()
    this.shutdownRequested = false
    this.shutdownPromise = null
    this.scheduler = createJobRuntimeScheduler({
      tickMs,
      maxConcurrency,
      runOneTick: () => this.runOneTick(),
      onError: (error) => console.error('[jobs] tick failed:', error?.stack || error),
    })
    // jobId → userId 缓存,避免每次 emit 都查 DB;recover/createJob 时写入。
    this.jobUserCache = new Map()
    this.recover()
  }

  _jobUserId(jobId) {
    if (this.jobUserCache.has(jobId)) return this.jobUserCache.get(jobId)
    const row = getJobRow(jobId)
    const uid = row?.userId || null
    this.jobUserCache.set(jobId, uid)
    return uid
  }

  emit(event) {
    if (!event) return
    const jobId = event.jobId || event.job_id
    const eventOwner = jobId ? this._jobUserId(jobId) : null
    for (const [listener, listenerUserId] of this.listeners) {
      try {
        // 没指定 userId 的订阅者收所有事件(测试/内部用);
        // 指定了的只收自己 job 的事件--事件没归属(eventOwner=null)兜底也只发给同 userId,
        // 防止历史无主 job 被错误推送。
        if (listenerUserId == null) {
          listener(event)
        } else if (eventOwner && eventOwner === listenerUserId) {
          listener(event)
        }
      } catch (err) {
        console.error('[jobs] listener error:', err?.stack || err)
      }
    }
    // ★ D6: job 进入终态后从 jobUserCache 删除对应条目,修内存泄漏(原来只增不清)。
    //   放在 dispatch 之后,保证本条终态事件仍能正确解析 owner。
    if (jobId && TERMINAL_EVENT_TYPES.has(event.type)) {
      this.jobUserCache.delete(jobId)
    }
  }

  /**
   * 订阅事件流。两种调用形式:
   *   subscribe(listener)            → 收所有事件(内部 / 测试)
   *   subscribe(userId, listener)    → 只收该用户名下 job 的事件(SSE 路由)
   */
  subscribe(userIdOrListener, maybeListener) {
    let userId = null
    let listener
    if (typeof userIdOrListener === 'function') {
      listener = userIdOrListener
    } else {
      userId = userIdOrListener
      listener = maybeListener
    }
    this.listeners.set(listener, userId)
    return () => this.listeners.delete(listener)
  }

  recover() {
    releaseAllJobSteeringLeases()
    const jobs = listRecoverableJobs()
    const recovered = []
    for (const candidate of jobs) {
      if (!['planning', 'running', 'awaiting_approval'].includes(candidate.status)) continue
      const scope = { jobId: candidate.id }
      // The observation alone is not authority to recover: another process can
      // claim the job immediately afterwards. Take a short execution lease and
      // fence the requeue in the same ownership transaction.
      if (this.runtimeCore.lease.isActive(scope)) continue
      const recoveryLease = this.runtimeCore.lease.acquire(scope)
      if (!recoveryLease) continue
      try {
        const outcome = this.runtimeCore.lease.runIfOwned(scope, () => {
          const job = getJobRow(candidate.id)
          if (!job) return null
          let event
          if (['planning', 'running'].includes(job.status)) {
            updateJob(job.id, { status: 'queued', error: null, finishedAt: null })
            const recoveredDiagnostics = latestPersistedOutcomeFields(
              listJobSteps(job.id).filter((step) => step.status === 'running'),
            )
            for (const step of listJobSteps(job.id)) {
              if (step.status === 'running') {
                updateJobStep(step.id, {
                  status: 'queued',
                  output: clearResumedJobOutcomeDiagnostics(step.output),
                  error: null,
                  startedAt: null,
                  finishedAt: null,
                })
              }
            }
            event = appendJobEvent({
              jobId: job.id,
              type: 'recovered',
              message: '服务重启后已恢复到队列',
              payload: {
                ...recoveredDiagnostics,
                reason: 'process_restart_recovery',
                nextAction: 'resume_execution',
              },
            })
          } else if (job.status === 'awaiting_approval') {
            const approval = getLatestJobApproval({ jobId: job.id, userId: job.userId })
            if (!approval || approval.status === 'pending') return null
            updateJob(job.id, { status: 'queued', error: null, finishedAt: null })
            const recoveredDiagnostics = latestPersistedOutcomeFields(
              listJobSteps(job.id).filter((step) => step.status === 'running'),
            )
            for (const step of listJobSteps(job.id)) {
              if (step.status === 'running') {
                updateJobStep(step.id, {
                  status: 'queued',
                  output: clearResumedJobOutcomeDiagnostics(step.output),
                  error: null,
                  startedAt: null,
                  finishedAt: null,
                })
              }
            }
            event = appendJobEvent({
              jobId: job.id,
              stepId: approval.stepId || null,
              type: 'approval_recovered',
              message: 'Persisted approval decision found after restart; the interrupted turn was requeued',
              payload: {
                ...recoveredDiagnostics,
                approvalId: approval.id,
                decision: approval.status,
                reason: 'tool_approval_resolved',
                nextAction: 'resume_execution',
              },
            })
          } else {
            return null
          }
          this.jobUserCache.set(job.id, job.userId || null)
          this.emit(event)
          return { ...job, status: 'queued' }
        })
        if (outcome?.owned && outcome.value) recovered.push(outcome.value)
      } finally {
        recoveryLease.release()
      }
    }
    return recovered
  }

  start() {
    if (this.shutdownRequested) return false
    return this.scheduler.start()
  }

  stop() {
    this.scheduler.stop()
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownRequested = true
    this.shutdownPromise = this.scheduler.shutdown().then(() => Promise.allSettled([...this.activeTicks]))
    return this.shutdownPromise
  }

  async createJob(prompt, options = {}) {
    const { userId, requirePlanApproval = false, sourceType = null, sourceId = null, grants = [] } = options
    if (!userId) throw new Error('createJob requires userId')
    const binding = this.resolveModelBinding({
      userId,
      providerId: options.modelProviderId,
      modelName: options.modelName,
      configRevision: options.modelConfigRevision,
      env: options.env || process.env,
    })
    const modelSnapshot = normalizeJobModelSnapshot({
      modelName: binding.modelName,
      modelProviderId: binding.providerId,
      modelConfigRevision: binding.configRevision,
    })
    let plan
    try {
      plan = await this.planner(prompt, {
        userId,
        modelName: modelSnapshot.modelName,
        modelProviderId: modelSnapshot.modelProviderId,
        modelConfigRevision: modelSnapshot.modelConfigRevision,
        modelEnv: binding.env,
      })
    } catch (error) {
      const modelFailure = wrapJobModelFailure(error, modelSnapshot)
      throw modelFailure || error
    }
    const id = newId('job')
    const { event } = await persistGuardedGeneratedPlan({
      id, userId, prompt, sourceType, sourceId, grants,
      plan,
      ...modelSnapshot,
      requirePlanApproval,
      taskPlanGuard: this.taskPlanGuard,
    })
    this.jobUserCache.set(id, userId)
    this.emit(event)
    return this.getJob(id, { userId })
  }

  listJobs({ userId } = {}) {
    return listJobs({ userId }).map((job) => projectJobForClient(
      getJobWithChildren(job.id, { userId }),
    ))
  }

  getJob(id, { userId } = {}) {
    return projectJobForClient(getJobWithChildren(id, { userId }))
  }

  steerJob(jobId, { userId, content } = {}) {
    const transition = enqueueJobSteeringTransition({ jobId, userId, content })
    if (!transition.found) return null
    if (!transition.accepted) {
      return {
        accepted: false,
        error: transition.reason === 'plan_approval_required'
          ? 'approve the proposed plan before steering execution'
          : transition.reason === 'cancelling'
            ? 'job cancellation has already been requested'
            : 'job is already finished',
        job: this.getJob(jobId, { userId }),
      }
    }
    const { message } = transition
    if (transition.requeued) {
      this.emit(appendJobEvent({
        jobId,
        stepId: transition.resumedStepId || null,
        type: 'user_response_received',
        message: 'User response received; the suspended task has been requeued',
        payload: {
          steeringId: message.id,
          ...(transition.resumeDiagnostics || {}),
          nextAction: 'resume_execution',
        },
      }))
    }
    this.emit(appendJobEvent({
      jobId,
      type: 'steering_queued',
      message: 'User steering queued for the next engine iteration',
      payload: { steeringId: message.id },
    }))
    return { accepted: true, message, job: this.getJob(jobId, { userId }) }
  }
  resumeDirectoryAuthorization(jobId, options = {}) {
    const current = this.getJob(jobId, { userId: options.userId })
    if (!current) return null
    const recoveryLease = !this.activeControllers.has(jobId)
      ? this.runtimeCore.lease.acquire({ jobId })
      : null
    if (!recoveryLease) {
      return { resumed: false, error: 'job is currently active', job: current }
    }
    try {
      return resumeJobDirectoryAuthorization({
        jobId,
        ...options,
        getJob: this.getJob.bind(this),
        cancelJobWake,
        emit: this.emit.bind(this),
      })
    } finally {
      recoveryLease.release()
    }
  }

  approvePlan(jobId, {
    userId,
    steps = null,
    proposalEventId = null,
    planDigest = null,
  } = {}) {
    return approveRuntimeJobPlan({
      jobId, userId, steps, proposalEventId, planDigest,
      getJob: this.getJob.bind(this),
      emit: this.emit.bind(this),
      createStepId: () => newId('step'),
    })
  }

  requestCancel(jobId, { userId } = {}) {
    const transition = requestJobCancellationTransition({ jobId, userId })
    if (!transition.found) return null
    if (transition.status === 'cancel_requested') {
      this.activeControllers.get(jobId)?.abort(userCancellationError('JOB_CANCEL_REQUESTED', 'Cancelled by user'))
    }
    if (!transition.changed) return this.getJob(jobId, { userId })
    this.emit(transition.event)
    return this.getJob(jobId, { userId })
  }
  resumeAfterApproval(jobId, { userId, stepId = null } = {}) {
    const job = this.getJob(jobId, { userId })
    if (!job || job.status !== 'awaiting_approval') return job
    // In the original process the durable waiter will resume itself. Only a
    // restarted process, which has no active controller, needs requeueing.
    const scope = { jobId }
    if (this.activeControllers.has(jobId) || this.runtimeCore.lease.isActive(scope)) return job
    const recoveryLease = this.runtimeCore.lease.acquire(scope)
    if (!recoveryLease) return this.getJob(jobId, { userId })
    let transition
    try {
      transition = resumeJobAfterApprovalTransition({
        jobId,
        userId,
        stepId,
        leaseOwnerId: this.runtimeCore.lease.ownerId,
      })
    } finally {
      recoveryLease.release()
    }
    if (!transition.changed) return this.getJob(jobId, { userId })
    this.emit(transition.event)
    return this.getJob(jobId, { userId })
  }

  retryJob(jobId, { userId } = {}) {
    let currentJob = this.getJob(jobId, { userId })
    if (!currentJob) return null
    // A pending plan approval is the authoritative blocker. Surface its
    // stable error before the generic retry-status guard so retry routes
    // cannot obscure the security decision behind JOB_RETRY_STATUS_INVALID.
    assertJobPlanRetryAllowed(currentJob)
    if (!RETRYABLE_JOB_STATUSES.has(currentJob.status)) {
      const error = new Error(`job cannot be retried from status ${currentJob.status}`)
      error.code = 'JOB_RETRY_STATUS_INVALID'
      error.statusCode = 409
      throw error
    }
    const retryLease = !this.activeControllers.has(jobId)
      ? this.runtimeCore.lease.acquire({ jobId })
      : null
    if (!retryLease) {
      const error = new Error('job retry is already active')
      error.code = 'JOB_RETRY_CONFLICT'
      error.statusCode = 409
      throw error
    }
    try {
      currentJob = this.getJob(jobId, { userId })
      if (currentJob) assertJobPlanRetryAllowed(currentJob)
      if (!currentJob || !RETRYABLE_JOB_STATUSES.has(currentJob.status)) {
        const error = new Error(`job cannot be retried from status ${currentJob?.status || 'missing'}`)
        error.code = 'JOB_RETRY_STATUS_INVALID'
        error.statusCode = 409
        throw error
      }
      const deliveryRetryBlocker = deliveryProjectionRetryBlocker(currentJob)
      if (deliveryRetryBlocker) {
        throw retryStatusError('JOB_RETRY_STATUS_INVALID', deliveryRetryBlocker)
      }
      const modelBinding = this.resolveModelBinding({
        userId,
        providerId: currentJob.modelProviderId,
        modelName: currentJob.modelName,
      })
      const modelSnapshot = normalizeJobModelSnapshot({
        modelName: modelBinding.modelName,
        modelProviderId: modelBinding.providerId,
        modelConfigRevision: modelBinding.configRevision,
      })
      const checkpointsByStepId = loadJobRetryCheckpoints({
        runtimeCore: this.runtimeCore,
        job: currentJob,
        modelSnapshot,
      })
      const deliveryRecoverySteps = deliveryProjectionRecoverySteps(currentJob)
      const retriedSteps = uniqueJobSteps([...currentJob.steps.filter((step) => (
        RETRYABLE_STEP_STATUSES.has(step.status) || hasRejectedCompletedOutcome(step)
      )), ...deliveryRecoverySteps])
      assertRetryHasRunnablePath(currentJob, retriedSteps)
      const completedRetryStepIds = deliveryRecoverySteps
        .filter((step) => step.status === 'completed')
        .map((step) => step.id)
      const diagnosticResetStepIds = deliveryProjectionDiagnosticResetStepIds(
        currentJob,
        retriedSteps,
      )
      const retriedDiagnostics = latestPersistedOutcomeFields(retriedSteps)
      const previousDiagnostics = Object.keys(retriedDiagnostics).length > 0
        ? retriedDiagnostics
        : latestPersistedOutcomeFields(currentJob.steps)
      const transition = retryJobTransition({
        jobId,
        userId,
        expectedJobStatus: currentJob.status,
        steps: retriedSteps,
        completedRetryStepIds,
        diagnosticResetStepIds,
        modelSnapshot,
        prepareCheckpoints: () => {
          for (const step of retriedSteps) {
            // A truncated run deliberately keeps its durable checkpoint. Clear
            // only the terminal marker so the next tick resumes after completed
            // tool results. Keeping this inside retryJobTransition also makes
            // checkpoint preparation atomic with the job/step compare-and-swap.
            makeRetryCheckpointResumable({
              runtimeCore: this.runtimeCore,
              checkpoint: checkpointsByStepId.get(step.id),
              jobId,
              stepId: step.id,
              userId,
            })
          }
        },
        event: {
          type: 'retried',
          message: '任务已重新入队',
          payload: {
            previousModelProviderId: currentJob.modelProviderId,
            previousModelConfigRevision: currentJob.modelConfigRevision,
            modelProviderId: modelSnapshot.modelProviderId,
            modelConfigRevision: modelSnapshot.modelConfigRevision,
            ...previousDiagnostics,
            nextAction: 'resume_execution',
          },
        },
      })
      if (!transition.changed) {
        const error = new Error(`job cannot be retried from status ${transition.status || 'missing'}`)
        error.code = 'JOB_RETRY_STATUS_INVALID'
        error.statusCode = 409
        throw error
      }
      this.emit(transition.event)
      return this.getJob(jobId, { userId })
    } finally {
      retryLease.release()
    }
  }

  /**
   * 标记步骤完成并附 evidence。
  * 借鉴 Reasonix mark_step_complete 设计。
  */
  completeStep(jobId, stepId, { userId, evidence = [] } = {}) {
    const initial = this.getJob(jobId, { userId })
    if (!initial) return null
    const completionLease = !this.activeControllers.has(jobId)
      ? this.runtimeCore.lease.acquire({ jobId })
      : null
    if (!completionLease) {
      const error = new Error('job step cannot be completed while the job is active')
      error.code = 'JOB_COMPLETION_CONFLICT'
      error.statusCode = 409
      throw error
    }
    try {
      let completedJob = null
      const completionEvents = []
      let terminalTransition = null
      const outcome = this.runtimeCore.lease.runIfOwned({ jobId }, () => {
        const job = this.getJob(jobId, { userId })
        const step = job?.steps.find((item) => item.id === stepId)
        if (!job || !step) return false
        assertJobPlanApprovalResolved(job)
        if (TERMINAL_JOB_STATUSES.has(job.status)
          || job.cancelRequested
          || job.status === 'cancel_requested') {
          const error = new Error(`job step cannot be completed after job reached ${job.status}`)
          error.code = 'JOB_COMPLETION_STATUS_INVALID'
          error.statusCode = 409
          throw error
        }
        if (!['queued', 'pending', 'running'].includes(step.status)) {
          const error = new Error(`job step cannot be completed from status ${step.status}`)
          error.code = 'JOB_COMPLETION_STATUS_INVALID'
          error.statusCode = 409
          throw error
        }
        if (hasExplicitIncompleteStepOutput(step.output)) {
          const error = new Error(
            step.output.incompleteReason || 'job step still reports incomplete requirements',
          )
          error.code = 'JOB_COMPLETION_INCOMPLETE'
          error.statusCode = 409
          throw error
        }
        const completedAt = Date.now()
        // completeJobStep validates evidence before writing. Keep wake/checkpoint
        // cleanup after that gate so a rejected completion is entirely side-effect free.
        completeJobStep(stepId, {
          evidence,
          output: step.output || {},
          completedAt,
          userId,
        })
        cancelJobWake({ jobId, userId })
        this.runtimeCore.checkpoint.clear({ jobId, stepId, userId })
        const completedStep = this.getJob(jobId, { userId })?.steps.find((item) => item.id === stepId)
        const normalizedEvidence = Array.isArray(completedStep?.output?.evidence)
          ? completedStep.output.evidence
          : []
        completionEvents.push(appendJobEvent({
          jobId,
          type: 'step_completed',
          stepId,
          message: `步骤已完成,${normalizedEvidence.length} 项验证`,
          payload: { evidenceCount: normalizedEvidence.length },
        }))
        const updated = this.getJob(jobId, { userId })
        terminalTransition = completeManualJobTransition({ jobId, userId, updated })
        if (terminalTransition.event) completionEvents.push(terminalTransition.event)
        completedJob = this.getJob(jobId, { userId })
        return true
      })
      if (!outcome?.owned) {
        const error = new Error('job completion lease was lost')
        error.code = 'JOB_COMPLETION_CONFLICT'
        error.statusCode = 409
        throw error
      }
      if (outcome.value) {
        for (const event of completionEvents) this.emit(event)
        if (terminalTransition?.terminal) {
          notifyJobTerminal({
            ...completedJob,
            error: terminalTransition.error,
          }, {
            status: terminalTransition.status,
            body: terminalTransition.message,
            payload: terminalTransition.payload,
          })
          notifyJobStopHook(completedJob, {
            status: terminalTransition.status,
            error: terminalTransition.error,
            stepId,
          })
        }
      }
      return outcome.value ? completedJob : null
    } finally {
      completionLease.release()
    }
  }

  /**
   * 创建结构化计划(带风险/目标/验收标准)。
   * 借鉴 Reasonix submit_plan 设计。
   */
  async createPlan({
    userId,
    title,
    prompt,
    steps,
    modelName,
    modelProviderId = null,
    modelConfigRevision = null,
    env = process.env,
  } = {}) {
    if (!userId) throw new Error('createPlan requires userId')
    const binding = this.resolveModelBinding({
      userId,
      providerId: modelProviderId,
      modelName,
      configRevision: modelConfigRevision,
      env,
    })
    const modelSnapshot = normalizeJobModelSnapshot({
      modelName: binding.modelName,
      modelProviderId: binding.providerId,
      modelConfigRevision: binding.configRevision,
    })
    const id = newId('job')
    const { event } = await persistGuardedStructuredPlan({
      id, userId, title, prompt, steps,
      ...modelSnapshot,
      taskPlanGuard: this.taskPlanGuard,
    })
    this.jobUserCache.set(id, userId)
    this.emit(event)
    return this.getJob(id, { userId })
  }

  retryStep(jobId, stepId, { userId, resetBudget = true } = {}) {
    let job = this.getJob(jobId, { userId })
    let step = job?.steps.find((item) => item.id === stepId)
    if (!job || !step) return null
    assertJobPlanRetryAllowed(job, step)
    let deliveryRecoverySteps = deliveryProjectionRecoverySteps(job)
    let deliveryRecoveryStepIds = new Set(deliveryRecoverySteps.map((item) => item.id))
    if (!RETRYABLE_JOB_STATUSES.has(job.status)
      || (!RETRYABLE_STEP_STATUSES.has(step.status)
        && !hasRejectedCompletedOutcome(step)
        && !deliveryRecoveryStepIds.has(step.id))) {
      const detail = job.status === 'failed' && step.status === 'completed'
        ? '; completed mutation steps are not replayed automatically—retry the verify/finalize stage or the whole job'
        : ''
      throw retryStatusError(
        'JOB_STEP_RETRY_STATUS_INVALID',
        `job step cannot be retried from ${job.status}/${step.status}${detail}`,
      )
    }
    const retryLease = !this.activeControllers.has(jobId)
      ? this.runtimeCore.lease.acquire({ jobId })
      : null
    if (!retryLease) {
      const error = new Error('job retry is already active')
      error.code = 'JOB_RETRY_CONFLICT'
      error.statusCode = 409
      throw error
    }
    try {
      job = this.getJob(jobId, { userId })
      step = job?.steps.find((item) => item.id === stepId)
      if (job && step) assertJobPlanRetryAllowed(job, step)
      const deliveryRetryBlocker = deliveryProjectionRetryBlocker(job)
      if (deliveryRetryBlocker) {
        throw retryStatusError('JOB_STEP_RETRY_STATUS_INVALID', deliveryRetryBlocker)
      }
      deliveryRecoverySteps = deliveryProjectionRecoverySteps(job)
      deliveryRecoveryStepIds = new Set(deliveryRecoverySteps.map((item) => item.id))
      if (!job || !step || !RETRYABLE_JOB_STATUSES.has(job.status)
        || (!RETRYABLE_STEP_STATUSES.has(step.status)
          && !hasRejectedCompletedOutcome(step)
          && !deliveryRecoveryStepIds.has(step.id))) {
        throw retryStatusError(
          'JOB_STEP_RETRY_STATUS_INVALID',
          `job step cannot be retried from ${job?.status || 'missing'}/${step?.status || 'missing'}`,
        )
      }
      const modelBinding = this.resolveModelBinding({
        userId,
        providerId: job.modelProviderId,
        modelName: job.modelName,
      })
      const modelSnapshot = normalizeJobModelSnapshot({
        modelName: modelBinding.modelName,
        modelProviderId: modelBinding.providerId,
        modelConfigRevision: modelBinding.configRevision,
      })
      const retrySteps = deliveryRecoveryStepIds.has(step.id)
        ? deliveryRecoverySteps
        : [step]
      const diagnosticResetStepIds = deliveryProjectionDiagnosticResetStepIds(job, retrySteps)
      const checkpointsByStepId = new Map(retrySteps.map((retryStep) => [
        retryStep.id,
        loadRetryCheckpoint({
          runtimeCore: this.runtimeCore,
          jobId,
          stepId: retryStep.id,
          userId: job.userId,
          modelSnapshot,
        }),
      ]))
      const transition = retryJobTransition({
        jobId,
        userId,
        expectedJobStatus: job.status,
        steps: retrySteps,
        completedRetryStepIds: deliveryRecoverySteps
          .filter((item) => item.status === 'completed')
          .map((item) => item.id),
        diagnosticResetStepIds,
        modelSnapshot,
        prepareCheckpoints: () => {
          // Preserve completed calls, results, and idempotency keys. Ordinary
          // retries get a fresh budget; manually reconciled paid responses keep
          // their counters. This is transactional with the retry state change.
          for (const retryStep of retrySteps) {
            makeRetryCheckpointResumable({
              runtimeCore: this.runtimeCore,
              checkpoint: checkpointsByStepId.get(retryStep.id),
              jobId,
              stepId: retryStep.id,
              userId,
              resetBudget,
            })
          }
        },
        event: {
          stepId,
          type: 'step_retried',
          message: `已重试步骤:${step.title}`,
          payload: {
            previousModelProviderId: job.modelProviderId,
            previousModelConfigRevision: job.modelConfigRevision,
            modelProviderId: modelSnapshot.modelProviderId,
            modelConfigRevision: modelSnapshot.modelConfigRevision,
            ...persistedJobOutcomeFields(step.output),
            nextAction: 'resume_execution',
          },
        },
      })
      if (!transition.changed) {
        const error = new Error(`job step cannot be retried from ${transition.status || 'missing'}/${step.status}`)
        error.code = 'JOB_STEP_RETRY_STATUS_INVALID'
        error.statusCode = 409
        throw error
      }
      this.emit(transition.event)
      return this.getJob(jobId, { userId })
    } finally {
      retryLease.release()
    }
  }

  runOneTick() {
    if (this.shutdownRequested) return Promise.resolve(false)
    let tick
    tick = this._runOneTick().finally(() => this.activeTicks.delete(tick))
    this.activeTicks.add(tick)
    return tick
  }

  async _runOneTick() {
    return runJobRuntimeTick.call(this, JOB_RUNTIME_TICK_DEPENDENCIES)
  }
  async drain({ maxTicks = 1000 } = {}) {
    for (let index = 0; index < maxTicks; index += 1) {
      const didWork = await this.runOneTick()
      if (!didWork) return
    }
    throw new Error('job runtime drain exceeded max ticks')
  }
}

let singletonRuntime = null
let singletonClosePromise = null

export function getJobRuntime() {
  if (!singletonRuntime) {
    singletonClosePromise = null
    singletonRuntime = new JobRuntime()
    singletonRuntime.start()
  }
  return singletonRuntime
}

/** 用自定义 runtime 替换单例，避免路由测试调用真实模型。 */
export function setJobRuntimeForTesting(runtime) {
  singletonRuntime?.stop()
  singletonRuntime = runtime
  return singletonRuntime
}

export function closeJobRuntime() {
  if (!singletonRuntime) return singletonClosePromise || Promise.resolve()
  const runtime = singletonRuntime
  singletonRuntime = null
  singletonClosePromise = runtime.shutdown()
  return singletonClosePromise
}

/**
 * Module-level helper:abort a running job via the singleton runtime.
 * 返回 { ok: true, job } 表示成功(包括幂等的 already-terminal),
 * 返回 null 表示 job 不存在或不属于该 user。
 * 内部复用 requestCancel,后者会:
 *   1. 标 status=cancel_requested、cancelRequested=true
 *   2. 调 activeControllers.get(jobId)?.abort() —— 触发 step 内 signal
 *   3. 发 cancel_requested 事件
 * 工具循环 / executeStep 在 step 之间和 in-flight 时都会检查 signal,
 * 触发后 runOneTick 会把状态推进到 cancelled。
 */
export function abortJob(jobId, { userId } = {}) {
  if (!jobId) return null
  const runtime = getJobRuntime()
  const existing = runtime.getJob(jobId, { userId })
  if (!existing) return null
  const job = runtime.requestCancel(jobId, { userId })
  return job ? { ok: true, job } : null
}

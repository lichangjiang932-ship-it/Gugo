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
  deriveJobProgress,
  buildJobOutcomeDiagnostics,
  findNextRunnableStep,
  resolveWorkflowState,
  stepRequiresPlanApproval,
} from './jobWorkflow.js'
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
import { lostJobExecutionLease, notifyJobStopHook, notifyJobTerminal, recoverInterruptedJobs } from './jobRuntimeLifecycle.js'
import { isModelReadinessError, resolveAgentModelRuntimeBinding } from './modelReadinessService.js'
import { runPlanningExploration } from './jobPlanningExplorationRuntime.js'
import { loadJobRetryCheckpoints, loadRetryCheckpoint, makeRetryCheckpointResumable } from './jobRetryRuntime.js'
import { runDefaultJobModel } from './jobModelExecutionRuntime.js'
import { createDefaultExecuteStep } from './jobStepExecutionRuntime.js'
import {
  wrapJobModelFailure,
} from './jobModelFailure.js'
import { persistJobStepFailure } from './jobStepFailureRuntime.js'
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

function persistJobOutcomeDiagnostics(jobId, {
  userId = null,
  stepId = null,
  reason = null,
  nextAction = null,
} = {}) {
  const snapshot = getJobWithChildren(jobId, { userId })
  if (!snapshot) return null
  const diagnostics = buildJobOutcomeDiagnostics(snapshot, { reason, nextAction })
  const targetStep = (stepId
    ? snapshot.steps.find((step) => step.id === stepId)
    : null)
    || [...snapshot.steps].reverse().find((step) => step.kind === 'finalize')
    || snapshot.steps.at(-1)
  if (targetStep) {
    const priorOutput = targetStep.output && typeof targetStep.output === 'object' && !Array.isArray(targetStep.output)
      ? targetStep.output
      : {}
    updateJobStep(targetStep.id, { output: { ...priorOutput, ...diagnostics } })
  }
  return diagnostics
}

function persistedOutcomeFields(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return {}
  return {
    ...(String(output.reason || '').trim() ? { reason: String(output.reason).trim() } : {}),
    ...(Array.isArray(output.artifactIds) ? { artifactIds: output.artifactIds } : {}),
    ...(Array.isArray(output.completedDeliverables)
      ? { completedDeliverables: output.completedDeliverables }
      : {}),
    ...(Array.isArray(output.missingDeliverables)
      ? { missingDeliverables: output.missingDeliverables }
      : {}),
    ...(Array.isArray(output.issues) ? { issues: output.issues } : {}),
  }
}

function hasRejectedCompletedOutcome(step) {
  if (step?.status !== 'completed') return false
  if (step.kind === 'verify') {
    const verdict = String(step.output?.acceptance?.verdict || '').trim().toLowerCase()
    return verdict && verdict !== 'pass'
  }
  return step.kind === 'finalize' && step.output?.complete === false
}
function newId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

// ★ D6: job 进入这些终态事件后,从 jobUserCache 淘汰对应条目(防内存泄漏)。
const TERMINAL_EVENT_TYPES = new Set(['completed', 'failed', 'cancelled', 'aborted'])

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
            for (const step of listJobSteps(job.id)) {
              if (step.status === 'running') {
                updateJobStep(step.id, { status: 'queued', error: null, startedAt: null, finishedAt: null })
              }
            }
            event = appendJobEvent({
              jobId: job.id,
              type: 'recovered',
              message: '服务重启后已恢复到队列',
            })
          } else if (job.status === 'awaiting_approval') {
            const approval = getLatestJobApproval({ jobId: job.id, userId: job.userId })
            if (!approval || approval.status === 'pending') return null
            updateJob(job.id, { status: 'queued', error: null, finishedAt: null })
            for (const step of listJobSteps(job.id)) {
              if (step.status === 'running') {
                updateJobStep(step.id, { status: 'queued', error: null, startedAt: null, finishedAt: null })
              }
            }
            event = appendJobEvent({
              jobId: job.id,
              type: 'approval_recovered',
              message: 'Persisted approval decision found after restart; the interrupted turn was requeued',
              payload: { approvalId: approval.id, decision: approval.status },
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
    return listJobs({ userId })
  }

  getJob(id, { userId } = {}) {
    return getJobWithChildren(id, { userId })
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
        type: 'user_response_received',
        message: 'User response received; the suspended task has been requeued',
        payload: { steeringId: message.id },
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
      if (!currentJob || !RETRYABLE_JOB_STATUSES.has(currentJob.status)) {
        const error = new Error(`job cannot be retried from status ${currentJob?.status || 'missing'}`)
        error.code = 'JOB_RETRY_STATUS_INVALID'
        error.statusCode = 409
        throw error
      }
      assertJobPlanRetryAllowed(currentJob)
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
      const retriedSteps = currentJob.steps.filter((step) => (
        RETRYABLE_STEP_STATUSES.has(step.status) || hasRejectedCompletedOutcome(step)
      ))
      const previousDiagnostics = persistedOutcomeFields(
        [...retriedSteps].reverse().find((step) => step.output)?.output,
      )
      const transition = retryJobTransition({
        jobId,
        userId,
        expectedJobStatus: currentJob.status,
        steps: retriedSteps,
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
    if (!RETRYABLE_JOB_STATUSES.has(job.status)
      || (!RETRYABLE_STEP_STATUSES.has(step.status) && !hasRejectedCompletedOutcome(step))) {
      const error = new Error(`job step cannot be retried from ${job.status}/${step.status}`)
      error.code = 'JOB_STEP_RETRY_STATUS_INVALID'
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
      job = this.getJob(jobId, { userId })
      step = job?.steps.find((item) => item.id === stepId)
      if (!job || !step || !RETRYABLE_JOB_STATUSES.has(job.status)
        || (!RETRYABLE_STEP_STATUSES.has(step.status) && !hasRejectedCompletedOutcome(step))) {
        const error = new Error(`job step cannot be retried from ${job?.status || 'missing'}/${step?.status || 'missing'}`)
        error.code = 'JOB_STEP_RETRY_STATUS_INVALID'
        error.statusCode = 409
        throw error
      }
      assertJobPlanRetryAllowed(job, step)
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
      const checkpoint = loadRetryCheckpoint({
        runtimeCore: this.runtimeCore,
        jobId,
        stepId,
        userId: job.userId,
        modelSnapshot,
      })
      const transition = retryJobTransition({
        jobId,
        userId,
        expectedJobStatus: job.status,
        steps: [step],
        modelSnapshot,
        prepareCheckpoints: () => {
          // Preserve completed calls, results, and idempotency keys. Ordinary
          // retries get a fresh budget; manually reconciled paid responses keep
          // their counters. This is transactional with the retry state change.
          makeRetryCheckpointResumable({
            runtimeCore: this.runtimeCore,
            checkpoint,
            jobId,
            stepId,
            userId,
            resetBudget,
          })
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
            ...persistedOutcomeFields(step.output),
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
    for (const wake of claimDueJobWakes()) {
      this.jobUserCache.set(wake.jobId, wake.userId)
      this.emit(appendJobEvent({
        jobId: wake.jobId,
        stepId: wake.stepId,
        type: 'wake_fired',
        message: 'Scheduled wake time reached; resuming the same durable job',
        payload: { wakeAt: wake.wakeAt, reason: wake.reason },
      }))
    }
    const jobs = listRecoverableJobs()
    const runnableJobs = jobs.filter((candidate) => (
      !SUSPENDED_JOB_STATUSES.has(candidate.status) && !this.activeJobIds.has(candidate.id)
    ))
    const candidates = [
      ...runnableJobs.filter((candidate) => candidate.status === 'cancel_requested'),
      ...runnableJobs.filter((candidate) => candidate.status === 'queued'),
      ...runnableJobs.filter((candidate) => !['cancel_requested', 'queued'].includes(candidate.status)),
    ]
    const job = candidates.find((candidate) => this.runtimeCore.lease.claim({ jobId: candidate.id }))
    if (!job) return false
    const tickBudget = createJobTickBudgetScope(job)
    const controller = new AbortController()
    this.activeJobIds.add(job.id)
    this.activeControllers.set(job.id, controller)
    const leaseScope = { jobId: job.id }
    const releaseExecutionLease = this.runtimeCore.lease.hold(leaseScope, controller)
    const commitOwned = (callback, { allowCancellation = false } = {}) => {
      const outcome = this.runtimeCore.lease.runIfOwned(leaseScope, () => {
        const current = getJobRow(job.id)
        if (!current) return false
        // requestCancel intentionally does not wait for the execution lease so
        // it can interrupt a long-running model/tool call. Once that durable
        // request exists, an older tick must not overwrite it with completed,
        // failed, waiting, or running state.
        if (!allowCancellation
          && (current.cancelRequested || current.status === 'cancel_requested')) {
          return false
        }
        callback(current)
        return true
      })
      return outcome?.owned === true && outcome.value === true
    }
    const leaseIsOwned = () => this.runtimeCore.lease.owns(leaseScope)
    try {
    const abandonedSteps = ['planning', 'running'].includes(job.status)
      ? listJobSteps(job.id).filter((step) => step.status === 'running')
      : []
    if (abandonedSteps.length > 0) {
      if (!commitOwned(() => {
        for (const step of abandonedSteps) {
          updateJobStep(step.id, { status: 'queued', startedAt: null, finishedAt: null })
        }
        this.emit(appendJobEvent({
          jobId: job.id,
          type: 'recovered',
          message: 'Expired execution owner was replaced; resuming from the durable checkpoint',
        }))
      })) return true
    }
    if (job.cancelRequested || job.status === 'cancel_requested') {
      if (!commitOwned(() => {
        for (const step of listJobSteps(job.id)) {
          if (['queued', 'running'].includes(step.status)) {
            updateJobStep(step.id, {
              status: 'cancelled',
              error: JOB_CANCELLED_MESSAGE,
              finishedAt: Date.now(),
            })
          }
        }
        updateJob(job.id, {
          status: 'cancelled',
          error: JOB_CANCELLED_MESSAGE,
          progress: deriveJobProgress(listJobSteps(job.id)),
          finishedAt: Date.now(),
        })
        const diagnostics = persistJobOutcomeDiagnostics(job.id, {
          userId: job.userId,
          reason: JOB_CANCELLED_MESSAGE,
          nextAction: 'retry_job',
        })
        this.emit(appendJobEvent({
          jobId: job.id,
          type: 'cancelled',
          message: JOB_CANCELLED_MESSAGE,
          payload: {
            code: 'JOB_CANCEL_REQUESTED',
            cancellationReason: 'user_requested',
            ...(diagnostics || {}),
          },
        }))
      }, { allowCancellation: true })) return true
      notifyJobTerminal({ ...job, error: JOB_CANCELLED_MESSAGE }, {
        status: 'cancelled',
        body: JOB_CANCELLED_MESSAGE,
      })
      notifyJobStopHook(job, { status: 'cancelled', error: JOB_CANCELLED_MESSAGE })
      return true
    }

    const approvalCandidate = findNextRunnableStep(listJobSteps(job.id))
    if (approvalCandidate && approvalCandidate.kind !== 'plan') {
      let pausedForPlanApproval = false
      if (!commitOwned(() => {
        const currentJob = getJobWithChildren(job.id)
        const authorization = resolveJobPlanApproval(currentJob)
        if (!authorization.required || authorization.authorized) return

        pausedForPlanApproval = true
        updateJob(job.id, { status: 'waiting', error: null, finishedAt: null })
        if (authorization.needsNewProposal) {
          const proposalPayload = buildJobPlanProposalPayload(currentJob, {
            planGuard: authorization.proposal?.payload?.planGuard || null,
            reason: authorization.reason,
            supersedesProposalEventId: authorization.proposal?.id || null,
          })
          this.emit(appendJobEvent({
            jobId: job.id,
            type: 'plan_proposed',
            message: 'Plan changed after approval; review the refreshed plan before execution',
            payload: proposalPayload,
          }))
        } else {
          this.emit(appendJobEvent({
            jobId: job.id,
            type: 'plan_approval_required',
            message: 'A durable approval for the current plan is required before execution',
            payload: {
              contract: JOB_PLAN_APPROVAL_CONTRACT,
              version: JOB_PLAN_APPROVAL_VERSION,
              proposalEventId: authorization.proposal?.id || null,
              planDigest: authorization.currentPlanDigest,
              reason: authorization.reason,
            },
          }))
        }
      })) return true
      if (pausedForPlanApproval) {
        try {
          createNotification({
            userId: job.userId,
            kind: 'job',
            title: job.title || job.id,
            body: '计划需要重新确认，批准后才会继续执行。',
            link: `/task?job=${encodeURIComponent(job.id)}`,
            data: { jobId: job.id, status: 'waiting', planProposed: true },
          })
        } catch (error) {
          console.error('[jobs] refreshed plan notification failed:', error?.stack || error)
        }
        return true
      }
    }

    let modelBinding
    try {
      modelBinding = this.resolveModelBinding({
        userId: job.userId,
        providerId: job.modelProviderId,
        modelName: job.modelName,
        configRevision: job.modelConfigRevision,
        requirePersistedBinding: true,
      })
    } catch (error) {
      if (!isModelReadinessError(error)) throw error
      const message = error?.message || '任务绑定的模型 Provider 已不可用'
      if (!commitOwned(() => {
        updateJob(job.id, { status: 'failed', error: message, finishedAt: Date.now() })
        const diagnostics = persistJobOutcomeDiagnostics(job.id, {
          userId: job.userId,
          reason: message,
          nextAction: error.action || 'retry_job',
        })
        this.emit(appendJobEvent({
          jobId: job.id,
          type: 'failed',
          message,
          payload: {
            code: error.code,
            action: error.action || null,
            providerId: error.providerId || job.modelProviderId || null,
            modelName: error.modelName || job.modelName || null,
            configRevision: error.configRevision ?? job.modelConfigRevision ?? null,
            nextAction: error.action || 'retry_job',
            ...(diagnostics || {}),
          },
        }))
      })) return true
      notifyJobTerminal({ ...job, error: message }, { status: 'failed', body: message })
      notifyJobStopHook(job, { status: 'failed', error: message })
      return true
    }

    if (job.status === 'queued') {
      let promptHook = null
      if (!job.startedAt) {
        try {
          promptHook = await dispatchHooks({
            userId: job.userId,
            event: 'user_prompt_submit',
            tool: 'job',
            args: { prompt: job.prompt, jobId: job.id },
            sessionId: job.id,
            requestId: job.id,
            hookInvocationId: `job:${job.id}:user_prompt_submit`,
          })
        } catch (error) {
          promptHook = { allow: false, reason: error?.message || 'job prompt hook failed' }
        }
        if (lostJobExecutionLease(controller.signal) || !leaseIsOwned()) return true
        if (!promptHook.allow) {
          const reason = promptHook.reason || 'job prompt rejected by hook'
          if (!commitOwned(() => {
            updateJob(job.id, { status: 'failed', error: reason, finishedAt: Date.now() })
            const diagnostics = persistJobOutcomeDiagnostics(job.id, {
              userId: job.userId,
              reason,
              nextAction: 'retry_job',
            })
            this.emit(appendJobEvent({
              jobId: job.id,
              type: 'failed',
              message: reason,
              payload: diagnostics,
            }))
          })) return true
          notifyJobTerminal({ ...job, error: reason }, { status: 'failed', body: reason })
          notifyJobStopHook(job, { status: 'failed', error: reason })
          return true
        }
      }
      if (!commitOwned(() => {
        if (typeof promptHook?.replacementArgs?.prompt === 'string') {
          updateJob(job.id, { prompt: promptHook.replacementArgs.prompt })
        }
        updateJob(job.id, { status: 'running', startedAt: job.startedAt || Date.now() })
        this.emit(appendJobEvent({
          jobId: job.id,
          type: 'started',
          message: '任务开始执行',
        }))
      })) return true
    }

    const currentSteps = listJobSteps(job.id)
    const nextStep = findNextRunnableStep(currentSteps)
    if (!nextStep) {
      const resolution = resolveWorkflowState(currentSteps)
      const completed = resolution.state === 'completed'
      if (!commitOwned(() => {
        updateJob(job.id, completed
          ? { status: 'completed', progress: 100, finishedAt: Date.now() }
          : {
              status: 'failed',
              error: resolution.reason,
              progress: deriveJobProgress(currentSteps),
              finishedAt: Date.now(),
            })
        const diagnostics = completed ? null : persistJobOutcomeDiagnostics(job.id, {
          userId: job.userId,
          reason: resolution.reason,
          nextAction: 'retry_job',
        })
        this.emit(appendJobEvent({
          jobId: job.id,
          type: completed ? 'completed' : 'failed',
          message: completed ? '任务已完成' : resolution.reason,
          ...(diagnostics ? { payload: diagnostics } : {}),
        }))
      })) return true
      notifyJobTerminal({
        ...job,
        error: completed ? null : resolution.reason,
      }, {
        status: completed ? 'completed' : 'failed',
        body: completed ? '任务已完成' : resolution.reason,
      })
      notifyJobStopHook(job, {
        status: completed ? 'completed' : 'failed',
        error: completed ? null : resolution.reason,
      })
      return true
    }

    if (!commitOwned(() => {
      updateJobStep(nextStep.id, {
        status: 'running',
        startedAt: nextStep.startedAt || Date.now(),
      })
      this.emit(appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: 'step_started',
        message: `开始:${nextStep.title}`,
      }))
    })) return true

    try {
      // 直接传 freshJob(已经包含 userId),不再做权限过滤--
      // tick 是服务端内部调度,不是面向用户的查询。
      const freshJob = getJobWithChildren(job.id)
      if (freshJob?.cancelRequested || freshJob?.status === 'cancel_requested') {
        controller.abort(userCancellationError('JOB_CANCEL_REQUESTED', 'Cancelled by user'))
      }
      const executeCurrentStep = (stepToExecute) => tickBudget.run(() => this.executeStep({
        job: getJobWithChildren(job.id) || freshJob,
        step: stepToExecute,
        signal: controller.signal,
        modelEnv: modelBinding.env,
        claimSteering: () => claimJobSteering({ jobId: job.id, userId: job.userId }),
        acknowledgeSteering: (leaseId) => {
          const count = acknowledgeJobSteering({ jobId: job.id, userId: job.userId, leaseId })
          if (count > 0) {
            this.emit(appendJobEvent({
              jobId: job.id,
              stepId: nextStep.id,
              type: 'steering_consumed',
              message: 'User steering injected into the engine loop',
              payload: { count },
            }))
          }
          return count
        },
        releaseSteering: (leaseId) => releaseJobSteeringLease({
          jobId: job.id,
          userId: job.userId,
          leaseId,
        }),
        commitCheckpoint: (save) => {
          const outcome = this.runtimeCore.lease.runIfOwned(leaseScope, save)
          return outcome?.owned ? outcome.value : null
        },
      }))
      let result = await executeCurrentStep(nextStep)
      if (lostJobExecutionLease(controller.signal) || !leaseIsOwned()) return true

      const repair = await runVerificationRepairLoop({
        initialResult: result,
        nextStep,
        job,
        executeCurrentStep,
        leaseIsValid: () => !lostJobExecutionLease(controller.signal) && leaseIsOwned(),
        commitOwned,
        checkpoint: this.runtimeCore.checkpoint,
        emit: this.emit.bind(this),
      })
      if (repair.leaseLost) return true
      result = repair.result
      const { repairAttempt } = repair
      // ★ 截断(需澄清 / 预算耗尽):不是失败也不是成功,如实标记并通知用户,
      // 不能再像以前那样被吞成 ok:true 假装完成。
      if (result?.paused) {
        const clarification = result.clarification || {}
        const question = clarification.question || 'The task needs more information before it can continue.'
        const wakeAt = Number(clarification.wakeAt)
        const sleeping = Number.isFinite(wakeAt)
        if (!commitOwned(() => {
          updateJobStep(nextStep.id, {
            status: 'queued',
            output: result?.output ?? null,
            error: null,
            startedAt: null,
            finishedAt: null,
          })
          updateJob(job.id, {
            status: 'waiting',
            error: null,
            progress: deriveJobProgress(listJobSteps(job.id)),
            finishedAt: null,
          })
          if (sleeping) {
            scheduleJobWake({
              jobId: job.id,
              stepId: nextStep.id,
              userId: job.userId,
              wakeAt,
              reason: clarification.why || null,
            })
          }
          const diagnostics = persistJobOutcomeDiagnostics(job.id, {
            userId: job.userId,
            stepId: nextStep.id,
            reason: clarification.why || question,
            nextAction: sleeping ? 'wait_for_wake' : 'provide_input',
          })
          this.emit(appendJobEvent({
            jobId: job.id,
            stepId: nextStep.id,
            type: sleeping ? 'sleeping' : 'awaiting_user',
            message: question,
            payload: sleeping
              ? { wakeAt, reason: clarification.why || null, ...(diagnostics || {}) }
              : { clarification, ...(diagnostics || {}) },
          }))
        })) return true
        if (sleeping) return true
        try {
          createNotification({
            userId: job.userId,
            kind: 'job',
            title: job.title || job.id,
            body: question,
            link: `/task?job=${encodeURIComponent(job.id)}`,
            data: { jobId: job.id, status: 'waiting', clarification },
          })
        } catch (error) {
          // ★ 通知插入失败以前只 console.error 就完事了。
          //
          // 但 waiting 是个「看起来像死了」的状态:job 不再被 tick 调度,
          // 界面上没有任何动静。用户唯一能知道「它在等我回话」的渠道就是这条通知 ——
          // 通知没发出去,用户就只会觉得任务做到一半没后续了。
          // 至少把失败本身落成一个事件,让任务详情页能显示出来。
          console.error('[jobs] clarification notification failed:', error?.stack || error)
          try {
            this.emit(appendJobEvent({
              jobId: job.id,
              stepId: nextStep.id,
              type: 'notification_failed',
              message: `${question}（提醒发送失败，请留意本页面）`,
              payload: {
                notificationKind: 'job_clarification',
                clarification,
              },
            }))
          } catch {
            /* 事件也写不进去就真没别的办法了,不要再往上抛 */
          }
        }
        return true
      }
      if (result?.truncated) {
        const why = result.paused
          ? `需要澄清:${result.clarification?.question || '模型请求用户补充信息'}`
          : result.interrupted
            ? `中断:${result.reason || '模型调用出错'}（已保留部分进展，可点重试从断点继续）`
            : result.noProgress
              ? `无进展:${result.reason || '工具调用反复失败或重复'}`
              : `预算耗尽:${result.reason || '工具调用次数达上限'}`
        if (!commitOwned(() => {
          updateJobStep(nextStep.id, {
            status: 'failed',
            output: result?.output ?? null,
            error: why,
            finishedAt: Date.now(),
          })
          updateJob(job.id, {
            status: 'failed',
            error: why,
            progress: deriveJobProgress(listJobSteps(job.id)),
            finishedAt: Date.now(),
          })
          cancelJobWake({ jobId: job.id, userId: job.userId })
          const diagnostics = persistJobOutcomeDiagnostics(job.id, {
            userId: job.userId,
            stepId: nextStep.id,
            reason: why,
            nextAction: 'retry_step',
          })
          this.emit(appendJobEvent({
            jobId: job.id,
            stepId: nextStep.id,
            type: 'failed',
            message: why,
            payload: {
              code: result.interrupted
                ? 'JOB_STEP_INTERRUPTED'
                : result.noProgress
                  ? 'JOB_STEP_NO_PROGRESS'
                  : 'JOB_STEP_BUDGET_EXHAUSTED',
              retryable: true,
              ...(diagnostics || {}),
            },
          }))
        })) return true
        // ★ 不再删 checkpoint。
        //
        // 原来无论什么原因截断都把 checkpoint 删掉,于是「有一份完整可用的断点」
        // 和「retryStep 从零重跑」同时成立 —— 预算已经烧掉一半的 job 重试时
        // 又要把所有 read 重做一遍,然后再次超预算。
        // 现在保留断点,retryStep 才能真的「从停下的地方继续」。
        // (用户主动取消的路径仍然删除,见下面的 cancelled 分支。)
        this.runtimeCore.approval.release({ jobId: job.id, userId: job.userId })
        notifyJobTerminal({ ...job, error: why }, { status: 'failed', body: why })
        notifyJobStopHook(job, { status: 'failed', error: why, stepId: nextStep.id })
        return true
      }
      if (result?.ok === false) {
        persistRejectedStepResult({
          result,
          repairAttempt,
          job,
          nextStep,
          runtimeCore: this.runtimeCore,
          commitOwned,
          emit: this.emit.bind(this),
        })
        return true
      }
      const requiresPlanApproval = stepRequiresPlanApproval(nextStep, getApprovalMode({ userId: job.userId }))
      if (!commitOwned(() => {
        updateJobStep(nextStep.id, {
          status: 'completed',
          output: result?.output ?? null,
          finishedAt: Date.now(),
        })
        this.runtimeCore.checkpoint.clear({ jobId: job.id, stepId: nextStep.id, userId: job.userId })
        cancelJobWake({ jobId: job.id, userId: job.userId })
        const updatedSteps = listJobSteps(job.id)
        updateJob(job.id, { progress: deriveJobProgress(updatedSteps) })
        emitTaskReviewEvent({ emit: this.emit.bind(this), jobId: job.id, stepId: nextStep.id, acceptance: result?.acceptance, repairAttempt })
        this.emit(appendJobEvent({
          jobId: job.id,
          stepId: nextStep.id,
          type: 'step_completed',
          message: `完成:${nextStep.title}`,
        }))
        if (requiresPlanApproval) {
          const plannedJob = this.getJob(job.id, { userId: job.userId })
          const proposalPayload = buildJobPlanProposalPayload(plannedJob, {
            planGuard: nextStep.input?.planGuard || null,
          })
          updateJob(job.id, { status: 'waiting', error: null, finishedAt: null })
          this.emit(appendJobEvent({
            jobId: job.id,
            stepId: nextStep.id,
            type: 'plan_proposed',
            message: 'Plan proposed; waiting for explicit approval before execution',
            payload: proposalPayload,
          }))
        }
      })) return true
      if (requiresPlanApproval) {
        try {
          createNotification({
            userId: job.userId,
            kind: 'job',
            title: job.title || job.id,
            body: '计划已准备好，批准后才会开始执行。',
            link: `/task?job=${encodeURIComponent(job.id)}`,
            data: { jobId: job.id, status: 'waiting', planProposed: true },
          })
        } catch (error) {
          console.error('[jobs] plan notification failed:', error?.stack || error)
        }
        return true
      }
    } catch (error) {
      if (lostJobExecutionLease(controller.signal, error) || !leaseIsOwned()) return true
      const latestJob = getJobWithChildren(job.id)
      const cancelled = controller.signal.aborted || latestJob?.cancelRequested || latestJob?.status === 'cancel_requested'
      if (cancelled) {
        if (!commitOwned(() => {
          for (const step of listJobSteps(job.id)) {
            if (['queued', 'running'].includes(step.status)) {
              updateJobStep(step.id, {
                status: 'cancelled',
                error: JOB_CANCELLED_MESSAGE,
                finishedAt: Date.now(),
              })
            }
          }
          updateJob(job.id, {
            status: 'cancelled',
            error: JOB_CANCELLED_MESSAGE,
            progress: deriveJobProgress(listJobSteps(job.id)),
            finishedAt: Date.now(),
          })
          this.runtimeCore.checkpoint.clear({ jobId: job.id, stepId: nextStep.id, userId: job.userId })
          cancelJobWake({ jobId: job.id, userId: job.userId })
          const diagnostics = persistJobOutcomeDiagnostics(job.id, {
            userId: job.userId,
            stepId: nextStep.id,
            reason: JOB_CANCELLED_MESSAGE,
            nextAction: 'retry_job',
          })
          this.emit(appendJobEvent({
            jobId: job.id,
            stepId: nextStep.id,
            type: 'cancelled',
            message: JOB_CANCELLED_MESSAGE,
            payload: {
              code: 'JOB_CANCEL_REQUESTED',
              cancellationReason: 'user_requested',
              ...(diagnostics || {}),
            },
          }))
        }, { allowCancellation: true })) return true
        notifyJobTerminal({ ...job, error: JOB_CANCELLED_MESSAGE }, {
          status: 'cancelled',
          body: JOB_CANCELLED_MESSAGE,
        })
        notifyJobStopHook(job, {
          status: 'cancelled',
          error: JOB_CANCELLED_MESSAGE,
          stepId: nextStep.id,
        })
        return true
      }
      persistJobStepFailure({
        commitOwned,
        emit: this.emit.bind(this),
        error,
        job,
        step: nextStep,
      })
    } finally {
      if (this.activeControllers.get(job.id) === controller) {
        this.activeControllers.delete(job.id)
      }
    }

    return true
    } finally {
      releaseExecutionLease()
      if (this.activeControllers.get(job.id) === controller) {
        this.activeControllers.delete(job.id)
      }
      this.activeJobIds.delete(job.id)
      const finalJob = getJobRow(job.id)
      if (finalJob && TERMINAL_JOB_STATUSES.has(finalJob.status)) tickBudget.release()
    }
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

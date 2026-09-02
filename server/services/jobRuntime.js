import { buildExploredPlan } from './jobPlanner.js'
import {
  appendJobEvent,
  getJob as getJobRow, getJobWithChildren, listJobSteps,
  listRecoverableJobs, updateJob, updateJobStep,
} from './jobStore.js'
import { createNotification } from './notificationsStore.js'
import { dispatchHooks } from './hooksService.js'
import { getLatestJobApproval } from './approvalStore.js'
import { getApprovalMode } from './approvalSettingsStore.js'
import {
  cancelJobWake,
  claimDueJobWakes,
  scheduleJobWake,
} from './jobWakeStore.js'
import { blockClaimedAutoRetryWakeTransition } from './jobRuntimeTransitionStore.js'
import {
  acknowledgeJobSteering,
  claimJobSteering,
  releaseAllJobSteeringLeases,
  releaseJobSteeringLease,
} from './jobSteeringStore.js'
import {
  buildFinalOutput,
  deriveJobProgress,
  buildJobOutcomeDiagnostics,
  clearCompletedJobOutcomeDiagnostics,
  clearResumedJobOutcomeDiagnostics,
  findNextRunnableStep,
  resolveWorkflowState,
  stepRequiresPlanApproval,
} from './jobWorkflow.js'
import {
  latestPersistedOutcomeFields,
  persistJobOutcomeDiagnostics,
} from './jobRuntimeProjection.js'
import { emitTaskReviewEvent, persistRejectedStepResult, runVerificationRepairLoop } from './jobAcceptanceRuntime.js'
import { applyRuntimeTaskPlanGuard } from './taskPlanGuard.js'
import {
  buildJobPlanProposalPayload,
  JOB_PLAN_APPROVAL_CONTRACT,
  JOB_PLAN_APPROVAL_VERSION,
  resolveJobPlanApproval,
} from './jobPlanPolicyRuntime.js'
import { createJobRuntimeScheduler } from './jobRuntimeScheduler.js'
import { createJobExecutionLeaseCoordinator } from './jobExecutionLeaseRuntime.js'
import { createJobRuntimeCore } from './runtimeCore.js'
import { createJobTickBudgetScope } from './jobTickBudgetScope.js'
import { userCancellationError } from '../utils/toolCancellation.js'
import { lostJobExecutionLease, notifyJobStopHook, notifyJobTerminal } from './jobRuntimeLifecycle.js'
import { isModelReadinessError, resolveAgentModelRuntimeBinding } from './modelReadinessService.js'
import { runPlanningExploration } from './jobPlanningExplorationRuntime.js'
import { runDefaultJobModel } from './jobModelExecutionRuntime.js'
import { createDefaultExecuteStep } from './jobStepExecutionRuntime.js'
import { persistJobStepFailure } from './jobStepFailureRuntime.js'
import { runJobRuntimeTick } from './jobRuntimeTick.js'
import { hasExplicitIncompleteStepOutput } from './jobRetryEligibility.js'
import {
  approveRuntimePlan,
  createRuntimeJob,
  createRuntimePlan,
  getRuntimeJob,
  listRuntimeJobs,
  requestRuntimeJobCancel,
  resumeRuntimeAfterApproval,
  resumeRuntimeDirectoryAuthorization,
  steerRuntimeJob,
} from './jobRuntimeCommands.js'
import {
  completeRuntimeStep,
  retryRuntimeJob,
  retryRuntimeStep,
  TERMINAL_JOB_STATUSES,
} from './jobRuntimeRetryCommands.js'
export { recoverInterruptedJobs } from './jobRuntimeLifecycle.js'
export { runPlanningExploration, selectPlanningToolSpecs } from './jobPlanningExplorationRuntime.js'
export { createDefaultExecuteStep }
const JOB_CANCELLED_MESSAGE = '任务已由用户终止'
// ★ 注意:awaiting_approval 故意不在这里。等人的 job 崩溃恢复时若被重排成 queued,
// 会把已经批准执行过的动作重跑一遍(发消息/改日历这类不可撤销动作尤其危险)。
const SUSPENDED_JOB_STATUSES = new Set(['waiting', 'awaiting_approval'])

// ★ D6: job 进入这些终态事件后,从 jobUserCache 淘汰对应条目(防内存泄漏)。
const TERMINAL_EVENT_TYPES = new Set(['completed', 'failed', 'cancelled', 'aborted'])

const JOB_RUNTIME_TICK_DEPENDENCIES = {
  claimDueJobWakes,
  blockClaimedAutoRetryWakeTransition,
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
              code: 'JOB_PROCESS_RESTART_RECOVERED',
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
              code: 'JOB_APPROVAL_RECOVERED',
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
    return createRuntimeJob(this, prompt, options)
  }

  listJobs(options = {}) {
    return listRuntimeJobs(this, options)
  }

  getJob(id, options = {}) {
    return getRuntimeJob(this, id, options)
  }

  steerJob(jobId, options = {}) {
    return steerRuntimeJob(this, jobId, options)
  }

  resumeDirectoryAuthorization(jobId, options = {}) {
    return resumeRuntimeDirectoryAuthorization(this, jobId, options)
  }

  approvePlan(jobId, options = {}) {
    return approveRuntimePlan(this, jobId, options)
  }

  requestCancel(jobId, options = {}) {
    return requestRuntimeJobCancel(this, jobId, options)
  }

  resumeAfterApproval(jobId, options = {}) {
    return resumeRuntimeAfterApproval(this, jobId, options)
  }

  retryJob(jobId, options = {}) {
    return retryRuntimeJob(this, jobId, options)
  }

  completeStep(jobId, stepId, options = {}) {
    return completeRuntimeStep(this, jobId, stepId, options)
  }

  async createPlan(options = {}) {
    return createRuntimePlan(this, options)
  }

  retryStep(jobId, stepId, options = {}) {
    return retryRuntimeStep(this, jobId, stepId, options)
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

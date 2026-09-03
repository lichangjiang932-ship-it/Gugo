import { getJob as getJobRow } from './jobStore.js'
import { applyRuntimeTaskPlanGuard } from './taskPlanGuard.js'
import { createJobRuntimeScheduler } from './jobRuntimeScheduler.js'
import { createJobExecutionLeaseCoordinator } from './jobExecutionLeaseRuntime.js'
import { createJobRuntimeCore } from './runtimeCore.js'
import { resolveAgentModelRuntimeBinding } from './modelReadinessService.js'
import { createDefaultJobPlanner } from './jobRuntimeDefaultPlanner.js'
import { createDefaultExecuteStep } from './jobStepExecutionRuntime.js'
import { runJobRuntimeTick } from './jobRuntimeTick.js'
import { DEFAULT_JOB_RUNTIME_TICK_DEPENDENCIES } from './jobRuntimeTickDependencies.js'
import { recoverRuntimeJobs } from './jobRuntimeRecovery.js'
import { createJobRuntimeEventHub } from './jobRuntimeEventHub.js'
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
} from './jobRuntimeRetryCommands.js'
export { recoverInterruptedJobs } from './jobRuntimeLifecycle.js'
export { runPlanningExploration, selectPlanningToolSpecs } from './jobPlanningExplorationRuntime.js'
export { createDefaultExecuteStep }
export class JobRuntime {
  constructor({
    planner = createDefaultJobPlanner(),
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
    this.eventHub = createJobRuntimeEventHub({
      resolveJobOwner: (jobId) => getJobRow(jobId)?.userId || null,
    })
    this.recover()
  }

  cacheJobOwner(jobId, userId) {
    this.eventHub.cacheJobOwner(jobId, userId)
  }

  emit(event) {
    this.eventHub.emit(event)
  }

  /**
   * 订阅事件流。两种调用形式:
   *   subscribe(listener)            → 收所有事件(内部 / 测试)
   *   subscribe(userId, listener)    → 只收该用户名下 job 的事件(SSE 路由)
   */
  subscribe(userIdOrListener, maybeListener) {
    if (arguments.length === 1) {
      return this.eventHub.subscribe(userIdOrListener)
    }
    return this.eventHub.subscribe(userIdOrListener, maybeListener)
  }

  get eventListenerCount() {
    return this.eventHub.listenerCount()
  }

  recover() {
    return recoverRuntimeJobs({
      lease: this.runtimeCore.lease,
      cacheJobOwner: (jobId, userId) => this.cacheJobOwner(jobId, userId),
      emit: (event) => this.emit(event),
    })
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
    return runJobRuntimeTick.call(this, DEFAULT_JOB_RUNTIME_TICK_DEPENDENCIES)
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

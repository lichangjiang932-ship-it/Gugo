import crypto from 'node:crypto'
import { buildInitialPlan } from './jobPlanner.js'
import {
  appendJobArtifact,
  appendJobEvent,
  appendJobSteps,
  createJob as persistJob,
  getJob as getJobRow,
  getJobWithChildren,
  listJobSteps,
  listJobs,
  listRecoverableJobs,
  updateJob,
  updateJobStep,
} from './jobStore.js'
import { createDocx } from './artifactGen.js'
import { callBackgroundModel } from './modelProxy.js'
import { getRuntimeSkill } from './skillRegistry.js'

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const RECOVERABLE_JOB_STATUSES = new Set(['planning', 'running', 'waiting'])

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function parseSkillPrompt(prompt = '') {
  const match = String(prompt).match(/^\/([a-z0-9_-]+)\s*(.*)$/i)
  if (!match) return { skillId: null, userPrompt: String(prompt || '').trim() }
  return {
    skillId: match[1],
    userPrompt: match[2].trim(),
  }
}

export function createDefaultExecuteStep({
  runModel = async ({ messages, signal }) => callBackgroundModel({ messages, signal }),
  createDocxImpl = createDocx,
} = {}) {
  return async function defaultExecuteStep({ job, step, signal }) {
    if (step.kind === 'plan') {
      return {
        ok: true,
        output: { summary: `已规划任务：${job.title}` },
      }
    }

    if (step.kind === 'finalize') {
      const generatedTexts = (job.steps || [])
        .filter((item) => ['execute', 'batch_item'].includes(item.kind))
        .map((item) => item.output?.text)
        .filter(Boolean)
      if (!generatedTexts.length) {
        return {
          ok: true,
          output: { summary: '没有可汇总的文本结果' },
        }
      }
      const artifact = await createDocxImpl({
        title: job.title,
        paragraphs: generatedTexts.map((text, index) => ({
          heading: index === 0 ? 1 : 2,
          text,
        })),
      })
      appendJobArtifact({
        id: artifact.id,
        jobId: job.id,
        userId: job.userId,
        stepId: step.id,
        type: artifact.type,
        title: artifact.title || job.title,
        url: artifact.url,
        filename: artifact.filename,
      })
      return {
        ok: true,
        output: {
          summary: '已汇总任务结果',
          artifactId: artifact.id,
        },
      }
    }

    const { skillId, userPrompt } = parseSkillPrompt(job.prompt)
    const skill = skillId ? getRuntimeSkill(skillId, { userId: job.userId }) : null
    const messages = []
    if (skill?.systemPrompt) messages.push({ role: 'system', content: skill.systemPrompt })
    const promptSuffix = step.kind === 'batch_item'
      ? `\n\n这是批量任务中的第 ${step.input?.index || 1} / ${step.input?.total || 1} 项，请只完成这一项。`
      : ''
    const finalPrompt = `${userPrompt || job.prompt}${promptSuffix}`
    messages.push({ role: 'user', content: finalPrompt })
    const text = await runModel({
      job,
      step,
      messages,
      userPrompt: finalPrompt,
      skill,
      signal,
    })
    return {
      ok: true,
      output: { text },
    }
  }
}

function deriveProgress(steps = []) {
  if (!steps.length) return 0
  const completed = steps.filter((step) => step.status === 'completed').length
  return Math.round((completed / steps.length) * 100)
}

function withStableStepIds(jobId, steps = []) {
  return steps.map((step, index) => ({
    ...step,
    id: `${jobId}:${step.id || index}`,
    sortOrder: index,
  }))
}

export function recoverInterruptedJobs(jobs = []) {
  return jobs
    .filter((job) => RECOVERABLE_JOB_STATUSES.has(job.status))
    .map((job) => ({ ...job, status: 'queued' }))
}

export class JobRuntime {
  constructor({
    planner = buildInitialPlan,
    executeStep = createDefaultExecuteStep(),
    tickMs = 250,
  } = {}) {
    this.planner = planner
    this.executeStep = executeStep
    this.tickMs = tickMs
    this.timer = null
    // listeners 改成 Map<listener, userId>;userId === null 表示无过滤(给内部/测试用)。
    this.listeners = new Map()
    this.activeControllers = new Map()
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
      // 没指定 userId 的订阅者收所有事件(测试/内部用);
      // 指定了的只收自己 job 的事件——事件没归属(eventOwner=null)兜底也只发给同 userId,
      // 防止历史无主 job 被错误推送。
      if (listenerUserId == null) {
        listener(event)
      } else if (eventOwner && eventOwner === listenerUserId) {
        listener(event)
      }
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
    const jobs = listRecoverableJobs()
    const recovered = recoverInterruptedJobs(jobs)
    for (const job of recovered) {
      this.jobUserCache.set(job.id, job.userId || null)
      updateJob(job.id, { status: 'queued' })
      for (const step of listJobSteps(job.id)) {
        if (step.status === 'running') updateJobStep(step.id, { status: 'queued' })
      }
      const event = appendJobEvent({
        jobId: job.id,
        type: 'recovered',
        message: '服务重启后已恢复到队列',
      })
      this.emit(event)
    }
    return recovered
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.runOneTick().catch((error) => {
        console.error('[jobs] tick failed:', error?.stack || error)
      })
    }, this.tickMs)
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  async createJob(prompt, { userId } = {}) {
    if (!userId) throw new Error('createJob requires userId')
    const plan = this.planner(prompt)
    const id = newId('job')
    persistJob({
      id,
      userId,
      title: plan.title,
      prompt: plan.prompt || String(prompt || '').trim(),
      status: 'queued',
    })
    this.jobUserCache.set(id, userId)
    appendJobSteps(id, withStableStepIds(id, plan.steps))
    const event = appendJobEvent({
      jobId: id,
      type: 'created',
      message: '任务已创建',
      payload: { stepCount: plan.steps.length },
    })
    this.emit(event)
    return this.getJob(id, { userId })
  }

  listJobs({ userId } = {}) {
    return listJobs({ userId })
  }

  getJob(id, { userId } = {}) {
    return getJobWithChildren(id, { userId })
  }

  requestCancel(jobId, { userId } = {}) {
    const job = this.getJob(jobId, { userId })
    if (!job || TERMINAL_JOB_STATUSES.has(job.status)) return job
    updateJob(jobId, { status: 'cancel_requested', cancelRequested: true })
    this.activeControllers.get(jobId)?.abort()
    const event = appendJobEvent({
      jobId,
      type: 'cancel_requested',
      message: '已请求终止任务',
    })
    this.emit(event)
    return this.getJob(jobId, { userId })
  }

  retryJob(jobId, { userId } = {}) {
    const currentJob = this.getJob(jobId, { userId })
    if (!currentJob) return null
    for (const step of currentJob.steps) {
      if (['failed', 'cancelled'].includes(step.status)) {
        updateJobStep(step.id, {
          status: 'queued',
          error: null,
          finishedAt: null,
        })
      }
    }
    updateJob(jobId, {
      status: 'queued',
      cancelRequested: false,
      finishedAt: null,
      error: null,
      progress: deriveProgress(this.getJob(jobId, { userId }).steps),
    })
    const event = appendJobEvent({
      jobId,
      type: 'retried',
      message: '任务已重新入队',
    })
    this.emit(event)
    return this.getJob(jobId, { userId })
  }

  retryStep(jobId, stepId, { userId } = {}) {
    const job = this.getJob(jobId, { userId })
    const step = job?.steps.find((item) => item.id === stepId)
    if (!job || !step) return null
    updateJobStep(stepId, {
      status: 'queued',
      error: null,
      finishedAt: null,
    })
    updateJob(jobId, {
      status: 'queued',
      cancelRequested: false,
      finishedAt: null,
      error: null,
    })
    const event = appendJobEvent({
      jobId,
      stepId,
      type: 'step_retried',
      message: `已重试步骤：${step.title}`,
    })
    this.emit(event)
    return this.getJob(jobId, { userId })
  }

  async runOneTick() {
    const jobs = listRecoverableJobs()
    const job = jobs[0]
    if (!job) return false

    if (job.cancelRequested || job.status === 'cancel_requested') {
      for (const step of listJobSteps(job.id)) {
        if (['queued', 'running'].includes(step.status)) {
          updateJobStep(step.id, {
            status: 'cancelled',
            finishedAt: Date.now(),
          })
        }
      }
      updateJob(job.id, {
        status: 'cancelled',
        progress: deriveProgress(listJobSteps(job.id)),
        finishedAt: Date.now(),
      })
      const event = appendJobEvent({
        jobId: job.id,
        type: 'cancelled',
        message: '任务已终止',
      })
      this.emit(event)
      return true
    }

    if (job.status === 'queued') {
      updateJob(job.id, { status: 'running', startedAt: job.startedAt || Date.now() })
      const event = appendJobEvent({
        jobId: job.id,
        type: 'started',
        message: '任务开始执行',
      })
      this.emit(event)
    }

    const nextStep = listJobSteps(job.id).find((step) => step.status === 'queued')
    if (!nextStep) {
      updateJob(job.id, {
        status: 'completed',
        progress: 100,
        finishedAt: Date.now(),
      })
      const event = appendJobEvent({
        jobId: job.id,
        type: 'completed',
        message: '任务已完成',
      })
      this.emit(event)
      return true
    }

    updateJobStep(nextStep.id, {
      status: 'running',
      startedAt: nextStep.startedAt || Date.now(),
    })
    this.emit(appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'step_started',
      message: `开始：${nextStep.title}`,
    }))

    const controller = new AbortController()
    this.activeControllers.set(job.id, controller)
    try {
      // 直接传 freshJob(已经包含 userId),不再做权限过滤——
      // tick 是服务端内部调度,不是面向用户的查询。
      const freshJob = getJobWithChildren(job.id)
      const result = await this.executeStep({
        job: freshJob,
        step: nextStep,
        signal: controller.signal,
      })
      if (result?.ok === false) {
        throw new Error(result.error || '步骤执行失败')
      }
      updateJobStep(nextStep.id, {
        status: 'completed',
        output: result?.output ?? null,
        finishedAt: Date.now(),
      })
      const updatedSteps = listJobSteps(job.id)
      updateJob(job.id, { progress: deriveProgress(updatedSteps) })
      this.emit(appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: 'step_completed',
        message: `完成：${nextStep.title}`,
      }))
    } catch (error) {
      const latestJob = getJobWithChildren(job.id)
      const cancelled = controller.signal.aborted || latestJob?.cancelRequested || latestJob?.status === 'cancel_requested'
      if (cancelled) {
        for (const step of listJobSteps(job.id)) {
          if (['queued', 'running'].includes(step.status)) {
            updateJobStep(step.id, {
              status: 'cancelled',
              finishedAt: Date.now(),
            })
          }
        }
        updateJob(job.id, {
          status: 'cancelled',
          progress: deriveProgress(listJobSteps(job.id)),
          finishedAt: Date.now(),
        })
        this.emit(appendJobEvent({
          jobId: job.id,
          stepId: nextStep.id,
          type: 'cancelled',
          message: '任务已终止',
        }))
        return true
      }
      updateJobStep(nextStep.id, {
        status: 'failed',
        error: error?.message || String(error),
        finishedAt: Date.now(),
      })
      updateJob(job.id, {
        status: 'failed',
        error: error?.message || String(error),
        finishedAt: Date.now(),
      })
      this.emit(appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: 'failed',
        message: error?.message || '步骤执行失败',
      }))
    } finally {
      if (this.activeControllers.get(job.id) === controller) {
        this.activeControllers.delete(job.id)
      }
    }

    return true
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

export function getJobRuntime() {
  if (!singletonRuntime) {
    singletonRuntime = new JobRuntime()
    singletonRuntime.start()
  }
  return singletonRuntime
}

export function closeJobRuntime() {
  singletonRuntime?.stop()
  singletonRuntime = null
}

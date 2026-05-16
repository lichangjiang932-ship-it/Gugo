import crypto from 'node:crypto'
import { buildInitialPlan } from './jobPlanner.js'
import {
  appendJobEvent,
  appendJobSteps,
  createJob as persistJob,
  getJobWithChildren,
  listJobSteps,
  listJobs,
  listRecoverableJobs,
  updateJob,
  updateJobStep,
} from './jobStore.js'

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const RECOVERABLE_JOB_STATUSES = new Set(['planning', 'running', 'waiting'])

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function defaultExecuteStep({ job, step }) {
  if (step.kind === 'plan') {
    return Promise.resolve({
      ok: true,
      output: { summary: `已规划任务：${job.title}` },
    })
  }
  if (step.kind === 'finalize') {
    return Promise.resolve({
      ok: true,
      output: { summary: '已汇总任务结果' },
    })
  }
  return Promise.resolve({
    ok: true,
    output: { text: step.title },
  })
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
    executeStep = defaultExecuteStep,
    tickMs = 250,
  } = {}) {
    this.planner = planner
    this.executeStep = executeStep
    this.tickMs = tickMs
    this.timer = null
    this.listeners = new Set()
    this.recover()
  }

  emit(event) {
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  recover() {
    const jobs = listRecoverableJobs()
    const recovered = recoverInterruptedJobs(jobs)
    for (const job of recovered) {
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

  async createJob(prompt) {
    const plan = this.planner(prompt)
    const id = newId('job')
    const job = persistJob({
      id,
      title: plan.title,
      prompt: plan.prompt || String(prompt || '').trim(),
      status: 'queued',
    })
    appendJobSteps(id, withStableStepIds(id, plan.steps))
    const event = appendJobEvent({
      jobId: id,
      type: 'created',
      message: '任务已创建',
      payload: { stepCount: plan.steps.length },
    })
    this.emit(event)
    return this.getJob(id)
  }

  listJobs() {
    return listJobs()
  }

  getJob(id) {
    return getJobWithChildren(id)
  }

  requestCancel(jobId) {
    const job = this.getJob(jobId)
    if (!job || TERMINAL_JOB_STATUSES.has(job.status)) return job
    updateJob(jobId, { status: 'cancel_requested', cancelRequested: true })
    const event = appendJobEvent({
      jobId,
      type: 'cancel_requested',
      message: '已请求终止任务',
    })
    this.emit(event)
    return this.getJob(jobId)
  }

  retryJob(jobId) {
    const job = this.getJob(jobId)
    if (!job) return null
    for (const step of job.steps) {
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
      progress: deriveProgress(this.getJob(jobId).steps),
    })
    const event = appendJobEvent({
      jobId,
      type: 'retried',
      message: '任务已重新入队',
    })
    this.emit(event)
    return this.getJob(jobId)
  }

  retryStep(jobId, stepId) {
    const job = this.getJob(jobId)
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
    return this.getJob(jobId)
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

    try {
      const freshJob = this.getJob(job.id)
      const result = await this.executeStep({ job: freshJob, step: nextStep })
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


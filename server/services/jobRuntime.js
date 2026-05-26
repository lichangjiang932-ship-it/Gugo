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
import { callBackgroundModel, callBackgroundModelWithTools } from '../adapters/modelProxy.js'
import { getRuntimeSkill } from './skillRegistry.js'
import { runToolsLoop } from './jobTools.js'
import { createNotification } from './notificationsStore.js'

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
  runModelWithTools = async ({ messages, tools, signal }) =>
    callBackgroundModelWithTools({ messages, tools, signal }),
  createDocxImpl = createDocx,
  enableServerTools = true,
} = {}) {
  return async function defaultExecuteStep({ job, step, signal }) {
    if (step.kind === 'plan') {
      return {
        ok: true,
        output: { summary: `已规划任务:${job.title}` },
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
    // ★ tools loop 系统提示:鼓励模型在用户明确要 PPT/Word/Excel 时调工具落盘
    if (enableServerTools) {
      messages.push({
        role: 'system',
        content: [
          '你可以调用以下工具直接生成文件:create_pptx (PowerPoint)、create_docx (Word)、create_xlsx (Excel)。',
          '当用户的需求需要可下载的文档/表格/演示稿时,直接调用对应工具并把内容完整填好,不要把内容写成纯文本回答。',
          '如果只需要文字答案,正常回答即可。',
          '',
          '【高级 PPT 必守规则】(create_pptx 时强制)',
          '1. 配色、版式、字体由系统控制,你只给文字 + 数据,不要在 bullet 里堆 emoji/装饰符号。',
          '2. 标题 ≤ 14 字、结论式("X 增长 Y%" 而不是 "X 的情况");bullet ≤ 30 字、动词开头、含数字。',
          '3. 单页 bullet ≤ 4 条,超出请拆页。短句胜过长段。',
          '4. 必须用 layout 字段控制版式:cover(封面) / section(章节页) / kpi(数据卡 — 传 kpi 数组) / chart(图表 — 传 chart 字段) / statement(单点结论大字) / split(双栏对比) / process(横向流程) / quote(引用) / bullets(常规要点) / end(感谢页)。',
          '5. 6 页以上的 deck 至少含 1 个 layout="section" 章节分隔 + 至少 1 个 kpi 或 chart。',
          '6. cover 不要叫"封面";直接用真实主题作 title,系统会自动用 deck title 显示大字。',
          '7. theme 字段按主题选: noir(默认/科技) / paper(文档/品牌) / ocean(金融/咨询) / forest(可持续/医疗)。',
          '',
          '【代码工作流】',
          '代码理解：遇到"这个函数/类在哪"先调 find_symbol；需要全文搜索用 grep_code；看依赖用 list_imports。不要盲用 bash_exec("grep -r ...")。',
          '代码编辑：多文件/不可分割的改动优先用 apply_patch（原子，任一失败自动回滚）。不确定时先传 dry_run=true 预览。',
          '反思节奏：多步任务先 manage_todos 拆分；每完成一个关键动作后调一次 reflect 复盘（事实/下一步/confidence）。',
          '遇阶求助：出现歧义、缺信息、需授权、有风险决策时，调 request_clarification 问用户而不是编造。问具体可决策的细节，能给选项就给。',
        ].join('\n'),
      })
    }
    const promptSuffix = step.kind === 'batch_item'
      ? `\n\n这是批量任务中的第 ${step.input?.index || 1} / ${step.input?.total || 1} 项,请只完成这一项。`
      : ''
    const finalPrompt = `${userPrompt || job.prompt}${promptSuffix}`
    messages.push({ role: 'user', content: finalPrompt })

    if (enableServerTools) {
      const result = await runToolsLoop({
        job,
        step,
        messages,
        runModel: runModelWithTools,
        signal,
      })
      return {
        ok: true,
        output: {
          text: result.text,
          artifactIds: result.artifactIds,
          toolIterations: result.iterations,
        },
      }
    }

    // 兼容路径:enableServerTools=false 时退回纯文本(老行为)
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

function notifyJobTerminal(job, { status, body }) {
  if (!job?.id || !job.userId) return
  try {
    createNotification({
      userId: job.userId,
      kind: 'job',
      title: job.title || job.id,
      body,
      link: `/?job=${encodeURIComponent(job.id)}`,
      data: {
        jobId: job.id,
        status,
        error: job.error || null,
      },
    })
  } catch (err) {
    console.error('[jobs] notification failed:', err?.stack || err)
  }
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
    const tick = async () => {
      try {
        await this.runOneTick()
      } catch (error) {
        console.error('[jobs] tick failed:', error?.stack || error)
      }
      if (this.timer) {
        this.timer = setTimeout(tick, this.tickMs)
        this.timer.unref()
      }
    }
    this.timer = setTimeout(tick, this.tickMs)
    this.timer.unref()
  }

  stop() {
    if (!this.timer) return
    clearTimeout(this.timer)
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

  /**
   * 标记步骤完成并附 evidence。
   * 借鉴 Reasonix mark_step_complete 设计。
   */
  completeStep(jobId, stepId, { userId, evidence = [] } = {}) {
    const job = this.getJob(jobId, { userId })
    if (!job) return null
    updateJobStep(stepId, {
      status: 'completed',
      output_json: JSON.stringify({ evidence, completedAt: Date.now() }),
      updated_at: Date.now(),
    })
    this.emit({
      jobId,
      type: 'step_completed',
      stepId,
      message: `步骤已完成,${evidence.length} 项验证`,
      at: Date.now(),
    })
    // 检查是否所有步骤完成
    const updated = this.getJob(jobId, { userId })
    if (updated?.steps?.every((s) => s.status === 'completed')) {
      updateJob(jobId, { status: 'completed', progress: 100, finishedAt: Date.now() })
    }
    return updated
  }

  /**
   * 创建结构化计划(带风险/目标/验收标准)。
   * 借鉴 Reasonix submit_plan 设计。
   */
  createPlan({ userId, title, prompt, steps } = {}) {
    if (!userId) throw new Error('createPlan requires userId')
    const id = `job-${crypto.randomUUID()}`
    const t = Date.now()
    // steps 可以是 [{ id, title, action, risk, targets, acceptance, verification }]
    const persistedSteps = steps.map((s, i) => ({
      id: s.id || `step-${i + 1}`,
      job_id: id,
      parent_step_id: null,
      title: s.title || s.id,
      kind: 'plan_step',
      status: 'pending',
      sort_order: i + 1,
      input_json: JSON.stringify({
        action: s.action || '',
        risk: s.risk || 'low',
        targets: Array.isArray(s.targets) ? s.targets : [],
        acceptance: s.acceptance || '',
        verification: Array.isArray(s.verification) ? s.verification : [],
      }),
      output_json: null,
      error: null,
      created_at: t,
      updated_at: t,
      started_at: null,
    }))

    persistJob({
      id,
      userId,
      title,
      prompt,
      status: 'planning',
      progress: 0,
      now: t,
    })
    appendJobSteps(id, persistedSteps)
    this.jobUserCache.set(id, userId)
    return this.getJob(id, { userId })
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
      message: `已重试步骤:${step.title}`,
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
      notifyJobTerminal(job, { status: 'cancelled', body: '任务已终止' })
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
      notifyJobTerminal(job, { status: 'completed', body: '任务已完成' })
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
      message: `开始:${nextStep.title}`,
    }))

    const controller = new AbortController()
    this.activeControllers.set(job.id, controller)
    try {
      // 直接传 freshJob(已经包含 userId),不再做权限过滤--
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
        message: `完成:${nextStep.title}`,
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
        notifyJobTerminal(job, { status: 'cancelled', body: '任务已终止' })
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
      notifyJobTerminal(
        { ...job, error: error?.message || String(error) },
        { status: 'failed', body: error?.message || '步骤执行失败' },
      )
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

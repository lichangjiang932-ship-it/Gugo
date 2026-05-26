import { createNotification } from './notificationsStore.js'
import { getJobRuntime } from './jobRuntime.js'
import { getPlugin } from '../plugins/pluginRegistry.js'
import {
  getCronJob,
  listEnabledCronJobs,
  markCronJobRun,
} from './cronStore.js'

const MAX_TIMEOUT_MS = 2_147_483_647
const CRON_SEARCH_LIMIT_MS = 366 * 24 * 60 * 60 * 1000

function normalizeAfter(after) {
  if (after instanceof Date) return after.getTime()
  const numeric = Number(after)
  return Number.isFinite(numeric) ? numeric : Date.now()
}

function assertValidTimestamp(ts, message) {
  if (!Number.isFinite(ts) || Number.isNaN(ts)) throw new Error(message)
  return ts
}

function parseCronNumber(value, min, max, { weekday = false } = {}) {
  if (!/^\d+$/.test(value)) return null
  const num = Number(value)
  const upper = weekday ? 7 : max
  if (num < min || num > upper) return null
  return weekday && num === 7 ? 0 : num
}

function parseCronField(field, min, max, { weekday = false } = {}) {
  const source = String(field || '').trim()
  if (!source) throw new Error('cron field is empty')
  const values = new Set()
  const upper = weekday ? 7 : max

  for (const rawPart of source.split(',')) {
    const part = rawPart.trim()
    if (!part) throw new Error('cron field has an empty segment')
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const base = stepMatch ? stepMatch[1] : part
    const step = stepMatch ? Number(stepMatch[2]) : 1
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid cron step: ${part}`)

    let start
    let end
    if (base === '*') {
      start = min
      end = max
    } else if (base.includes('-')) {
      const [lo, hi, extra] = base.split('-')
      if (extra !== undefined) throw new Error(`invalid cron range: ${part}`)
      start = parseCronNumber(lo, min, max, { weekday })
      end = parseCronNumber(hi, min, max, { weekday })
      if (start == null || end == null) throw new Error(`cron range out of bounds: ${part}`)
      if (weekday && hi === '7') end = 7
      if (start > end) throw new Error(`cron range must be ascending: ${part}`)
    } else {
      const value = parseCronNumber(base, min, max, { weekday })
      if (value == null) throw new Error(`cron value out of bounds: ${part}`)
      values.add(value)
      continue
    }

    if (start < min || end > upper) throw new Error(`cron value out of bounds: ${part}`)
    for (let value = start; value <= end; value += step) {
      values.add(weekday && value === 7 ? 0 : value)
    }
  }

  if (values.size === 0) throw new Error('cron field produced no values')
  return values
}

function nextCronRun(expr, after) {
  const parts = String(expr || '').trim().split(/\s+/).filter(Boolean)
  if (![5, 6].includes(parts.length)) {
    throw new Error('cron expression must have 5 or 6 fields')
  }

  const hasSeconds = parts.length === 6
  const fields = hasSeconds ? parts : ['0', ...parts]
  const [secExpr, minExpr, hourExpr, domExpr, monthExpr, dowExpr] = fields
  const seconds = parseCronField(secExpr, 0, 59)
  const minutes = parseCronField(minExpr, 0, 59)
  const hours = parseCronField(hourExpr, 0, 23)
  const days = parseCronField(domExpr, 1, 31)
  const months = parseCronField(monthExpr, 1, 12)
  const weekdays = parseCronField(dowExpr, 0, 6, { weekday: true })
  const domRestricted = domExpr !== '*'
  const dowRestricted = dowExpr !== '*'

  const stepMs = hasSeconds ? 1000 : 60_000
  const start = new Date(after + stepMs)
  if (hasSeconds) {
    start.setMilliseconds(0)
  } else {
    start.setSeconds(0, 0)
  }
  const end = start.getTime() + CRON_SEARCH_LIMIT_MS

  for (let ts = start.getTime(); ts <= end; ts += stepMs) {
    const d = new Date(ts)
    if (!seconds.has(d.getSeconds())) continue
    if (!minutes.has(d.getMinutes())) continue
    if (!hours.has(d.getHours())) continue
    if (!months.has(d.getMonth() + 1)) continue

    const matchesDom = days.has(d.getDate())
    const matchesDow = weekdays.has(d.getDay())
    const matchesDay = domRestricted && dowRestricted
      ? matchesDom || matchesDow
      : matchesDom && matchesDow
    if (!matchesDay) continue
    return ts
  }

  throw new Error('cron expression has no run within 366 days')
}

export function parseSchedule(scheduleType, scheduleValue, { after = Date.now() } = {}) {
  const type = String(scheduleType || '').trim()
  const value = String(scheduleValue || '').trim()
  const base = normalizeAfter(after)

  if (type === 'at') {
    const ts = assertValidTimestamp(new Date(value).getTime(), 'scheduleValue must be a valid ISO date')
    return ts > base ? ts : null
  }

  if (type === 'every') {
    const ms = Number(value)
    if (!Number.isFinite(ms) || ms <= 0) throw new Error('scheduleValue must be a positive millisecond interval')
    return base + ms
  }

  if (type === 'cron') {
    return nextCronRun(value, base)
  }

  throw new Error('scheduleType must be at, every, or cron')
}

function nextRunForJob(job, after = Date.now()) {
  if (!job?.enabled) return null
  return parseSchedule(job.scheduleType, job.scheduleValue, { after })
}

async function runAgentSession(job) {
  const payload = job.execPayload || {}
  const prompt = String(payload.prompt || '').trim()
  if (!prompt) throw new Error('agent_session requires execPayload.prompt')
  const agentId = payload.agentId || job.agentId || null
  const runtime = getJobRuntime()
  const finalPrompt = [
    '**Automated scheduled task.**',
    agentId ? `Agent ID: ${agentId}` : '',
    '',
    prompt,
  ].filter(Boolean).join('\n')
  const backgroundJob = await runtime.createJob(finalPrompt, { userId: job.userId })
  return { backgroundJobId: backgroundJob?.id || null, agentId }
}

async function runDirectNotify(job) {
  const payload = job.execPayload || {}
  const notification = createNotification({
    userId: job.userId,
    kind: 'info',
    title: String(payload.title || job.title || 'Scheduled notification').trim(),
    body: payload.body == null ? '' : String(payload.body),
    link: payload.link || null,
    data: {
      ...(payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {}),
      cronJobId: job.id,
      cronKind: job.kind,
    },
  })
  return { notificationId: notification.id }
}

async function runPluginAction(job) {
  const payload = job.execPayload || {}
  const pluginId = payload.pluginId || payload.plugin_id || ''
  const actionId = payload.actionId || payload.action_id || ''
  const plugin = pluginId ? getPlugin(pluginId) : null

  // YMA 当前 plugin 层只有静态 manifest / entry preview，尚无工具 handler 注册表。
  // 按 S2 要求先做非失败 no-op，保留足够信息给未来 runtime 接上。
  return {
    pluginId: pluginId || null,
    actionId: actionId || null,
    stubbed: true,
    pluginFound: !!plugin,
  }
}

export class CronScheduler {
  constructor() {
    this.timers = new Map()
    this.started = false
    this.runningHeartbeatAgents = new Set()
  }

  start() {
    if (this.started) return
    this.started = true
    this.loadJobs()
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.started = false
    this.runningHeartbeatAgents.clear()
  }

  loadJobs() {
    if (!this.started) return
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const job of listEnabledCronJobs()) this.rearm(job)
  }

  rearm(jobOrId) {
    if (!this.started) return
    const job = typeof jobOrId === 'string' ? getCronJob(jobOrId) : jobOrId
    const id = job?.id
    if (!id) return
    this.disarm(id)
    if (!job.enabled || !job.nextRunAt) return
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, job.nextRunAt - Date.now()))
    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.tick(id).catch((err) => {
        console.error('[cron] tick failed:', err?.stack || err)
      })
    }, delay)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  disarm(jobId) {
    const timer = this.timers.get(jobId)
    if (timer) clearTimeout(timer)
    this.timers.delete(jobId)
  }

  async execute(job) {
    if (job.execType === 'agent_session') return runAgentSession(job)
    if (job.execType === 'direct_notify') return runDirectNotify(job)
    if (job.execType === 'plugin_action') return runPluginAction(job)
    throw new Error(`unsupported execType: ${job.execType}`)
  }

  async tick(jobId, { manual = false } = {}) {
    const job = getCronJob(jobId)
    if (!job) return { status: 'missing' }
    this.disarm(jobId)

    if (!job.enabled && !manual) {
      return { status: 'disabled' }
    }

    const startedAt = Date.now()
    const finish = (status, error = null, extra = {}) => {
      const fresh = getCronJob(jobId)
      const nextRunAt = fresh?.enabled ? nextRunForJob(fresh, Date.now()) : null
      const updated = markCronJobRun(jobId, {
        lastRunAt: startedAt,
        lastStatus: status,
        lastError: error,
        nextRunAt,
      })
      this.rearm(updated)
      return { status, job: updated, ...extra }
    }

    if (job.kind === 'heartbeat' && this.runningHeartbeatAgents.has(job.agentId)) {
      return finish('skipped', 'heartbeat already running for this agent')
    }

    let heartbeatLocked = false
    try {
      if (job.kind === 'heartbeat') {
        this.runningHeartbeatAgents.add(job.agentId)
        heartbeatLocked = true
      }
      const result = await this.execute(job)
      return finish('success', null, { result })
    } catch (err) {
      return finish('error', err?.message || String(err))
    } finally {
      if (heartbeatLocked) this.runningHeartbeatAgents.delete(job.agentId)
    }
  }
}

let singletonScheduler = null

export function getCronScheduler() {
  if (!singletonScheduler) singletonScheduler = new CronScheduler()
  return singletonScheduler
}

export function closeCronScheduler() {
  singletonScheduler?.stop()
  singletonScheduler = null
}

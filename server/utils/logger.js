/**
 * 统一 server 端日志出口。
 *
 * 两套 API 并存（互不冲突）：
 *
 * 1) logger.{debug,info,warn,error}（#38 引入，替换零散 console.log）
 *    - LOG_LEVEL env 控制最低输出级别（debug < info < warn < error），默认 info
 *    - debug/info → console.log，warn → console.warn，error → console.error
 *    - 输出格式：[<ISO 时间>] [<level>] <msg ...>
 *
 * 2) logWarn/logError（D4 审计引入，结构化可观测）
 *    - 多处 catch 之前只在 dev 打 warn、生产静默；这两个**始终输出**（不看 NODE_ENV），
 *      不改控制流，仅补可观测性。
 *    - 输出形如：[warn] scope=memory.inject msg="..." userId=u1
 *
 * 3) 关联上下文（C2 新增）：AsyncLocalStorage 贯穿一次请求 / 一个 job / 一轮 turn，
 *    logWarn/logError 自动把当前上下文（requestId / userId / sessionId / turnId /
 *    jobId / traceId）合并进结构化 meta。显式传入的 meta 优先。
 *    - withLogContext(ctx, fn) 进入一段上下文；getLogContext() 读当前上下文
 *    - newTraceId() 生成短 trace id；HTTP 层用 req.headers['x-request-id'] 或自动生成
 *
 * 纯函数，无 DB，无 IO（除 stdout/stderr），符合 utils/ 红线。
 */

/* eslint-disable no-console */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

function resolveThreshold() {
  const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase()
  return LEVELS[raw] ?? LEVELS.info
}

function format(level, args) {
  const ts = new Date().toISOString()
  return [`[${ts}] [${level}]`, ...args]
}

function emit(level, sink, args) {
  if (LEVELS[level] < resolveThreshold()) return
  sink(...format(level, args))
}

export const logger = {
  debug: (...args) => emit('debug', console.log, args),
  info: (...args) => emit('info', console.log, args),
  warn: (...args) => emit('warn', console.warn, args),
  error: (...args) => emit('error', console.error, args),
}

/* ── 关联上下文（C2） ── */

const LOG_CONTEXT_STORE = new AsyncLocalStorage()

/**
 * 在一段异步流程内设置日志关联上下文。上下文沿 await 链自动传递，
 * 期间任何 logWarn/logError 都会带上这些键（除非显式 meta 覆盖同名键）。
 */
export function withLogContext(context, fn) {
  const parent = LOG_CONTEXT_STORE.getStore() || {}
  return LOG_CONTEXT_STORE.run({ ...parent, ...(context || {}) }, fn)
}

/** 读取当前日志上下文（无上下文时返回空对象，保证调用方可安全展开）。 */
export function getLogContext() {
  return LOG_CONTEXT_STORE.getStore() || {}
}

/** 生成短 trace id（16 hex），供一次 job / 一轮 turn / 一个请求做全链路关联。 */
export function newTraceId() {
  return String(randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 16)
}

function withContextMeta(meta = {}) {
  const context = getLogContext()
  if (!Object.keys(context).length) return meta
  // 显式 meta 优先于上下文：调用方明确写下的字段不能被上下文覆盖。
  return { ...context, ...(meta || {}) }
}

/* ── 结构化可观测（D4） ── */

function serializeMeta(meta = {}) {
  const parts = []
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  return parts.join(' ')
}

function errToString(err) {
  if (err instanceof Error) return err.stack || err.message
  return typeof err === 'string' ? err : JSON.stringify(err)
}

export function logWarn(scope, message, meta = {}, sink = console) {
  const metaStr = serializeMeta(withContextMeta(meta))
  sink.warn(`[warn] scope=${scope} msg=${JSON.stringify(String(message))}${metaStr ? ' ' + metaStr : ''}`)
}

export function logError(scope, error, meta = {}, sink = console) {
  const metaStr = serializeMeta(withContextMeta(meta))
  sink.error(`[error] scope=${scope} msg=${JSON.stringify(errToString(error))}${metaStr ? ' ' + metaStr : ''}`)
}

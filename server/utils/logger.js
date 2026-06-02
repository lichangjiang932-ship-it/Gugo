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
 * 纯函数，无 DB，无 IO（除 stdout/stderr），符合 utils/ 红线。
 */

/* eslint-disable no-console */

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
  const metaStr = serializeMeta(meta)
  sink.warn(`[warn] scope=${scope} msg=${JSON.stringify(String(message))}${metaStr ? ' ' + metaStr : ''}`)
}

export function logError(scope, error, meta = {}, sink = console) {
  const metaStr = serializeMeta(meta)
  sink.error(`[error] scope=${scope} msg=${JSON.stringify(errToString(error))}${metaStr ? ' ' + metaStr : ''}`)
}

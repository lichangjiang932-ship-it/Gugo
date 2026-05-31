/**
 * 统一 server 端日志出口。
 *
 * 替换零散的 console.log。AGENTS.md §2.5#7 承诺存在但之前并未实现。
 *
 * - LOG_LEVEL env 控制最低输出级别（debug < info < warn < error），默认 info
 * - debug/info → console.log，warn → console.warn，error → console.error
 * - 输出格式：[<ISO 时间>] [<level>] <msg ...>
 * - 纯函数，无 DB，无 IO（除 stdout/stderr），符合 utils/ 红线
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

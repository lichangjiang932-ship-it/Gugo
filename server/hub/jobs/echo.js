/**
 * server/hub/jobs/echo.js
 *
 * Demo job handler。把 payload.text 原样写回 hub_jobs.last_error 字段，
 * 作为端到端通路的 round-trip 验证（last_error 在这里被复用为「最近输出」）。
 *
 * handler 签名：async (job) => string | null
 *   - 返回值会被写入 last_error（命名只是历史负担，骨架阶段够用）
 *   - 抛错则 markFailed
 */

export async function echoHandler(job) {
  const text = job?.payload?.text
  if (typeof text !== 'string') {
    throw new Error('echo: payload.text must be a string')
  }
  return `echo:${text}`
}

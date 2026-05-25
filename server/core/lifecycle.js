/**
 * server/core/lifecycle.js
 *
 * 进程级启动 / 关闭编排。把原本散落在 appServer.js 里的 boot / shutdown 步骤集中过来。
 *
 * 设计要点：
 * - 纯过程式编排，不引入新的全局状态（DB / jobRuntime / mcp 各自保持原状）
 * - 失败不阻塞启动（seed 失败 → log），关闭幂等
 * - 给未来的 Manager facade（SessionManager / SkillManager / ...）留 hook 点
 */

import { closeDb } from '../db.js'
import { closeJobRuntime } from '../services/jobRuntime.js'
import { shutdownAll as shutdownMcpAll } from '../mcp/mcpManager.js'
import { seedSystemSkills } from '../services/seedSystemSkills.js'

const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * 启动期初始化。所有可恢复失败都吞掉，只 log。
 * 返回值预留：未来 Manager 实例化后会从这里返回 ManagerRegistry。
 */
export function bootstrap({ silent = process.env.NODE_ENV === 'production' } = {}) {
  try {
    seedSystemSkills()
  } catch (err) {
    console.error('[server] seedSystemSkills failed:', err.message)
  }
  if (!silent) console.log('[lifecycle] bootstrap complete')
  return {}
}

/**
 * 优雅关闭。供 SIGINT / SIGTERM 信号处理器调用。
 *   1. 关闭 HTTP server（停止接受新请求）
 *   2. 关闭 JobRuntime（等当前 step 跑完）
 *   3. 关闭 MCP（关 stdio / sse transport）
 *   4. 关闭 DB（flush WAL）
 *   5. 超时强退
 */
export function gracefulShutdown(server, { silent = process.env.NODE_ENV === 'production', exit = true } = {}) {
  if (!silent) console.log('\n[lifecycle] shutdown signal received')

  let done = false
  const finish = (code) => {
    if (done) return
    done = true
    if (!silent) console.log('[lifecycle] shutdown complete')
    if (exit) process.exit(code)
  }

  server.close(() => {
    if (!silent) console.log('[lifecycle] http server closed')
    try { closeJobRuntime() } catch { /* ignore */ }
    try { shutdownMcpAll() } catch { /* ignore */ }
    try { closeDb() } catch { /* ignore */ }
    if (!silent) console.log('[lifecycle] db closed')
    finish(0)
  })

  setTimeout(() => {
    console.error('[lifecycle] forced exit (timeout)')
    finish(1)
  }, SHUTDOWN_TIMEOUT_MS)
}

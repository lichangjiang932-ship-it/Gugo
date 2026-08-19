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

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb } from '../db.js'
import { closeJobRuntime } from '../services/jobRuntime.js'
import { logger } from '../utils/logger.js'
import { closeCronScheduler } from '../services/cronScheduler.js'
import { shutdownAll as shutdownMcpAll } from '../mcp/mcpManager.js'
import { seedSystemSkills } from '../services/seedSystemSkills.js'
import { initPlugins, shutdownRuntimePlugins } from '../plugins/pluginRegistry.js'
import { getEnabledIntegrationCredentials, listEnabledIntegrationCredentials } from '../services/integrationsStore.js'
import { setVisionAssistResolver } from '../adapters/visionAssist.js'
import { socialBridgeManager } from '../services/socialBridgeManager.js'
import { warnShellTrust } from '../utils/bashGuard.js'
import { registerBrowserTools } from '../services/browserTools.js'
import { registerConnectorTools } from '../services/connectorTools.js'
import { shutdownBrowsers } from '../adapters/browserAutomation.js'
import { initCodexPluginSkills } from '../adapters/codexPluginSkills.js'
import { closeTurnRecoveryRuntime, startTurnRecoveryRuntime } from '../services/turnRecoveryRuntime.js'
import { recoverInterruptedSubagentRuns } from '../services/subagentRuntime.js'
import { restoreEnabledRuntimePlugins } from '../services/runtimePluginControlService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '../../plugins')

const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * 启动期初始化。所有可恢复失败都吞掉，只 log。
 * 返回值预留：未来 Manager 实例化后会从这里返回 ManagerRegistry。
 */
export function bootstrap({ silent = process.env.NODE_ENV === 'production' } = {}) {
  // ★ C-P1.3: shell 开启时打信任声明 warn(黑名单非安全边界)
  warnShellTrust()
  registerBrowserTools()
  registerConnectorTools()
  try {
    seedSystemSkills()
  } catch (err) {
    console.error('[server] seedSystemSkills failed:', err.message)
  }
  try {
    initPlugins({ rootDir: DEFAULT_PLUGIN_ROOT, silent })
  } catch (err) {
    // 加载失败绝不阻塞主进程启动
    console.error('[server] initPlugins failed:', err.message)
  }
  void restoreEnabledRuntimePlugins().then((results) => {
    for (const result of results) {
      if (!result.ok) logger.warn(`[plugins] runtime restore failed for ${result.pluginId}: ${result.error}`)
    }
  }).catch((err) => {
    // Runtime plugin recovery is optional and must never block the server.
    console.error('[server] restore runtime plugins failed:', err?.message || err)
  })
  try {
    initCodexPluginSkills()
  } catch (err) {
    console.error('[server] initCodexPluginSkills failed:', err.message)
  }
  // 视觉副驾 resolver：让 modelProxy 能按 userId 拉 DB 里的副驾配置
  try {
    setVisionAssistResolver((userId) => {
      if (!userId) return null
      return getEnabledIntegrationCredentials({ userId, provider: 'vision_assist' })
    })
  } catch (err) {
    console.error('[server] setVisionAssistResolver failed:', err.message)
  }
  try {
    const integrations = listEnabledIntegrationCredentials({ kind: 'social' })
    for (const integration of integrations) {
      socialBridgeManager.startIntegration(integration).catch((err) => {
        console.error(`[bridge] start ${integration.provider} failed:`, err?.message || err)
      })
    }
  } catch (err) {
    console.error('[server] start social bridge failed:', err.message)
  }
  try {
    startTurnRecoveryRuntime()
  } catch (err) {
    console.error('[server] start turn recovery failed:', err.message)
  }
  try {
    recoverInterruptedSubagentRuns()
  } catch (err) {
    console.error('[server] recover subagent runs failed:', err.message)
  }
  if (!silent) logger.info('[lifecycle] bootstrap complete')
  return {}
}

/**
 * 优雅关闭。供 SIGINT / SIGTERM 信号处理器调用。
 *   1. 关闭 HTTP server（停止接受新请求）
 *   2. 停止 cron / turn recovery，并排空 JobRuntime 当前 step
 *   3. 卸载 runtime plugins（此时不会再有 Job 回调进入插件）
 *   4. 关闭 social bridge / browser / MCP transport
 *   5. 关闭 DB（flush WAL）
 *   6. 超时强退
 */
export function gracefulShutdown(server, { silent = process.env.NODE_ENV === 'production', exit = true } = {}) {
  if (!silent) logger.info('\n[lifecycle] shutdown signal received')

  return new Promise((resolve) => {
    let done = false
    let timeoutId = null
    const finish = (code) => {
      if (done) return
      done = true
      if (timeoutId) clearTimeout(timeoutId)
      if (!silent) logger.info('[lifecycle] shutdown complete')
      resolve(code)
      if (exit) process.exit(code)
    }
    let runtimeClosePromise = null
    const closeRuntime = () => {
      if (runtimeClosePromise) return runtimeClosePromise
      runtimeClosePromise = (async () => {
        let exitCode = 0
        if (!silent) logger.info('[lifecycle] http server closed')
        try { closeCronScheduler() } catch { /* ignore */ }
        try { closeTurnRecoveryRuntime() } catch { /* ignore */ }
        try { await closeJobRuntime() } catch { /* ignore */ }
        try {
          await shutdownRuntimePlugins()
        } catch (error) {
          exitCode = 1
          console.error('[lifecycle] runtime plugin shutdown failed:', error?.message || error)
        }
        try { await socialBridgeManager.stopAll() } catch { /* ignore */ }
        try { shutdownBrowsers() } catch { /* ignore */ }
        try { shutdownMcpAll() } catch { /* ignore */ }
        try { closeDb() } catch { /* ignore */ }
        if (!silent) logger.info('[lifecycle] db closed')
        finish(exitCode)
      })()
      return runtimeClosePromise
    }

    timeoutId = setTimeout(() => {
      if (done) return
      console.error('[lifecycle] forced exit (timeout)')
      finish(1)
    }, SHUTDOWN_TIMEOUT_MS)
    timeoutId.unref?.()

    try {
      if (server && typeof server.close === 'function') {
        server.close(() => { void closeRuntime() })
      } else {
        void closeRuntime()
      }
    } catch {
      void closeRuntime()
    }
  })
}

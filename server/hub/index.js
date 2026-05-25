#!/usr/bin/env node
/**
 * server/hub/index.js
 *
 * Hub 独立进程入口。
 *
 * 启动方式：
 *   HUB_ENABLED=1 node server/hub/index.js
 *   或 npm run hub  （包装脚本会自带 HUB_ENABLED=1 检查由本文件做）
 *
 * 关键约束：
 *   1. 默认不启动：未设 HUB_ENABLED=1 直接 exit 0，避免被误拉起
 *   2. 只操作 hub_* 表（通过 server/hub/hubDb.js）
 *   3. 不引入主进程任何业务模块；和主进程通过 SQLite 文件解耦
 *   4. tick loop 默认 30s，可 HUB_TICK_MS 覆盖
 */

import { closeDb } from '../db.js'
import { runHubMigrations, claimNextPending, markDone, markFailed } from './hubDb.js'
import { getHandler, listHandlers } from './jobRegistry.js'

const DEFAULT_TICK_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 10_000

let _tickTimer = null
let _running = false
let _shuttingDown = false

function log(...args) {
  console.log('[hub]', ...args)
}

function logErr(...args) {
  console.error('[hub]', ...args)
}

/**
 * 跑一个 tick：拉一条 pending 跑完。返回是否真的跑了一条。
 */
export async function runOnce() {
  if (_running) return false
  _running = true
  try {
    const job = claimNextPending()
    if (!job) return false
    const handler = getHandler(job.name)
    if (!handler) {
      markFailed(job.id, `no handler registered for "${job.name}"`)
      logErr(`job ${job.id} (${job.name}) failed: no handler`)
      return true
    }
    try {
      const result = await handler(job)
      markDone(job.id, { lastError: result == null ? null : String(result) })
      log(`job ${job.id} (${job.name}) done`)
    } catch (err) {
      markFailed(job.id, err?.message || String(err))
      logErr(`job ${job.id} (${job.name}) failed:`, err?.message || err)
    }
    return true
  } finally {
    _running = false
  }
}

async function tick() {
  if (_shuttingDown) return
  try {
    // 一次 tick 内尽量把队列清空，避免堆积
    let processed = 0
    while (await runOnce()) {
      processed += 1
      if (processed >= 20) break // 防止饿死 shutdown 信号
    }
  } catch (err) {
    logErr('tick error:', err?.message || err)
  } finally {
    if (!_shuttingDown) {
      _tickTimer = setTimeout(tick, getTickMs())
    }
  }
}

function getTickMs() {
  const raw = Number(process.env.HUB_TICK_MS)
  if (Number.isFinite(raw) && raw >= 100) return raw
  return DEFAULT_TICK_MS
}

export function startHub() {
  runHubMigrations()
  log(`booted, handlers=[${listHandlers().join(', ')}], tick=${getTickMs()}ms`)
  _tickTimer = setTimeout(tick, getTickMs())
}

export function shutdownHub({ exit = true } = {}) {
  if (_shuttingDown) return
  _shuttingDown = true
  log('shutdown signal received')

  if (_tickTimer) {
    clearTimeout(_tickTimer)
    _tickTimer = null
  }

  const finish = (code) => {
    try { closeDb() } catch { /* ignore */ }
    log('shutdown complete')
    if (exit) process.exit(code)
  }

  // 等当前 runOnce() 跑完，最多 SHUTDOWN_TIMEOUT_MS
  const start = Date.now()
  const wait = () => {
    if (!_running) return finish(0)
    if (Date.now() - start > SHUTDOWN_TIMEOUT_MS) {
      logErr('forced exit (timeout)')
      return finish(1)
    }
    setTimeout(wait, 100)
  }
  wait()
}

function isMain() {
  try {
    const entry = process.argv[1] || ''
    return entry.endsWith('server/hub/index.js') || entry.endsWith('hub/index.js')
  } catch {
    return false
  }
}

if (isMain()) {
  if (process.env.HUB_ENABLED !== '1') {
    console.log('[hub] HUB_ENABLED!=1, exiting (set HUB_ENABLED=1 to start)')
    process.exit(0)
  }
  process.on('SIGINT', () => shutdownHub())
  process.on('SIGTERM', () => shutdownHub())
  startHub()
}

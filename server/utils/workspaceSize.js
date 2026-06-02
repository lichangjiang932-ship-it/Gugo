/**
 * Workspace 总大小巡检 (C-P2.4,降级处理)。
 *
 * 用户决定不设硬磁盘配额。这里只做轻量可观测:workspace 总大小超过阈值
 * (env WORKSPACE_SIZE_WARN_BYTES,默认 1GB)时打一条 warn 日志,**不阻断任何写入**。
 *
 * 节流:同一进程内默认 5 分钟最多 warn 一次,避免每次写文件都遍历 + 刷屏。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_THRESHOLD_BYTES = 1024 * 1024 * 1024 // 1 GB
const WARN_THROTTLE_MS = 5 * 60 * 1000
const MAX_ENTRIES = 50_000 // 防御性:超大目录树不要无限遍历

// 进程级默认节流状态
const defaultState = {}

function dirSize(root) {
  let total = 0
  let count = 0
  const stack = [root]
  while (stack.length) {
    if (count > MAX_ENTRIES) break
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      count += 1
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          // 文件可能在遍历中被删,忽略
        }
      }
    }
  }
  return total
}

export function getWorkspaceSizeThreshold(env = process.env) {
  const raw = Number(env.WORKSPACE_SIZE_WARN_BYTES)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_THRESHOLD_BYTES
  return raw
}

export function checkWorkspaceSize(
  root,
  {
    thresholdBytes = getWorkspaceSizeThreshold(),
    logger = console,
    state = defaultState,
    now = Date.now,
  } = {},
) {
  const totalBytes = dirSize(root)
  const exceeded = totalBytes > thresholdBytes
  if (exceeded) {
    const t = now()
    if (!state.lastWarnAt || t - state.lastWarnAt >= WARN_THROTTLE_MS) {
      state.lastWarnAt = t
      logger.warn(
        `[workspaceSize] workspace 总大小 ${totalBytes} 字节已超过阈值 ${thresholdBytes} 字节` +
          `(WORKSPACE_SIZE_WARN_BYTES)。仅告警,不阻断写入。`,
      )
    }
  }
  return { totalBytes, exceeded, thresholdBytes }
}

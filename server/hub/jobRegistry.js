/**
 * server/hub/jobRegistry.js
 *
 * name → handler 注册表。Hub 进程启动时初始化，tick loop 按 job.name 查表。
 * 新增 handler：在 jobs/ 下写一个文件，然后在这里 register。
 */

import { echoHandler } from './jobs/echo.js'

const registry = new Map()

export function register(name, handler) {
  if (!name || typeof handler !== 'function') {
    throw new Error('register: name + function handler required')
  }
  registry.set(name, handler)
}

export function getHandler(name) {
  return registry.get(name) || null
}

export function listHandlers() {
  return Array.from(registry.keys())
}

// 默认注册
register('echo', echoHandler)

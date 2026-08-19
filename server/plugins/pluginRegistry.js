/**
 * server/plugins/pluginRegistry.js
 *
 * 内存级 plugin 注册表。bootstrap 阶段 initPlugins 调一次，后续 list/get 同步读。
 * 严格只读：listPlugins / getPlugin 返回浅拷贝，外部不能改内部缓存。
 */

import { loadPlugins } from './pluginLoader.js'
import { logger } from '../utils/logger.js'
import { createRuntimePluginRegistry } from './runtimePluginRegistry.js'

let CURRENT = []
let LAST_ERRORS = []
let INITIALIZED = false
const RUNTIME = createRuntimePluginRegistry()

/**
 * @param {{ rootDir?: string, silent?: boolean }} [opts]
 * @returns {{ plugins: object[], errors: object[] }}
 */
export function initPlugins({ rootDir = './plugins', silent = process.env.NODE_ENV === 'production' } = {}) {
  const { plugins, errors } = loadPlugins({ rootDir })
  CURRENT = plugins
  LAST_ERRORS = errors
  INITIALIZED = true
  if (!silent) {
    logger.info(`[plugins] loaded ${plugins.length} plugin(s) from ${rootDir}`)
    for (const e of errors) console.warn(`[plugins] skip ${e.dir}: ${e.message}`)
  }
  return { plugins: CURRENT.slice(), errors: LAST_ERRORS.slice() }
}

/**
 * @param {{ type?: string }} [opts]
 */
export function listPlugins({ type } = {}) {
  const out = type ? CURRENT.filter((p) => p.type === type) : CURRENT
  return out.map((p) => ({ ...p }))
}

/**
 * @param {string} id
 */
export function getPlugin(id) {
  if (!id) return null
  const hit = CURRENT.find((p) => p.id === id)
  return hit ? { ...hit } : null
}

export function getLoadErrors() {
  return LAST_ERRORS.slice()
}

export function isInitialized() {
  return INITIALIZED
}

/** Install a process-local runtime plugin with reversible side effects. */
export function registerPlugin(manifest, setup) {
  return RUNTIME.registerPlugin(manifest, setup)
}

/** Uninstall a runtime plugin after checking active dependants. */
export function unregisterPlugin(id) {
  return RUNTIME.unregisterPlugin(id)
}

export function listRuntimePlugins() {
  return RUNTIME.listPlugins()
}

export function getRuntimePlugin(id) {
  return RUNTIME.getPlugin(id)
}

export function getPluginService(name) {
  return RUNTIME.getService(name)
}

export function bindRuntimePluginsToLoop(loopEvents, context = {}) {
  return RUNTIME.bindLoopEvents(loopEvents, context)
}

export function shutdownRuntimePlugins() {
  return RUNTIME.shutdown()
}

// 仅供测试使用：重置内部状态
export function _resetForTests() {
  CURRENT = []
  LAST_ERRORS = []
  INITIALIZED = false
}

export function _resetRuntimePluginsForTests() {
  return RUNTIME.shutdown()
}

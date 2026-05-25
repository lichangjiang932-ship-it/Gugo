/**
 * server/plugins/pluginRegistry.js
 *
 * 内存级 plugin 注册表。bootstrap 阶段 initPlugins 调一次，后续 list/get 同步读。
 * 严格只读：listPlugins / getPlugin 返回浅拷贝，外部不能改内部缓存。
 */

import { loadPlugins } from './pluginLoader.js'

let CURRENT = []
let LAST_ERRORS = []
let INITIALIZED = false

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
    console.log(`[plugins] loaded ${plugins.length} plugin(s) from ${rootDir}`)
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

// 仅供测试使用：重置内部状态
export function _resetForTests() {
  CURRENT = []
  LAST_ERRORS = []
  INITIALIZED = false
}

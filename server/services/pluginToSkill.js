/**
 * server/services/pluginToSkill.js
 *
 * 把 type='skill-bundle' 的 plugin 安装为 skillStore 中的 skill。
 *
 * 设计原则（沿用 plugin loader 风格）：
 *  - 纯函数式入口，所有失败都包装成 { ok:false, reason:string }，不抛错
 *  - 严格只读 plugin 目录，禁 ..、绝对路径、symlink 跳出
 *  - 只读 plugin 目录下的 skill.json + prompts/*（递归，但限定后缀），不执行任何代码
 */

import fs from 'node:fs'
import path from 'node:path'
import { getPlugin } from '../plugins/pluginRegistry.js'
import { validateSkillPack, installValidatedSkillPack } from './skillImport.js'

const ALLOWED_EXTS = new Set(['.md', '.txt', '.json'])
const MAX_FILES = 64
const MAX_FILE_BYTES = 256 * 1024 // 256KB 单文件上限，防御性

/**
 * 判断 child 是否真的位于 parent 目录内（解析 symlink 后）。
 * realpathSync 在路径不存在时会抛错，调用方需自己捕获。
 */
function ensureInside(parent, child) {
  const realParent = fs.realpathSync(parent)
  const realChild = fs.realpathSync(child)
  if (realChild === realParent) return true
  return realChild.startsWith(realParent + path.sep)
}

/**
 * 递归收集 dir 下所有允许后缀文件，返回 { ok, files, reason }。
 * 路径以 `relRoot` 为根做相对化，符合 skillImport 的 files map 形态。
 */
function collectFiles(rootDir, relRoot = '') {
  const files = {}
  const stack = [{ abs: rootDir, rel: relRoot }]
  let count = 0

  while (stack.length) {
    const { abs, rel } = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch (err) {
      return { ok: false, reason: `读取目录失败: ${err.message}` }
    }
    for (const ent of entries) {
      const entAbs = path.join(abs, ent.name)
      const entRel = rel ? `${rel}/${ent.name}` : ent.name

      // 路径越界守卫
      try {
        if (!ensureInside(rootDir, entAbs)) {
          return { ok: false, reason: `路径越界: ${entRel}` }
        }
      } catch (err) {
        return { ok: false, reason: `路径解析失败 ${entRel}: ${err.message}` }
      }

      if (ent.isDirectory()) {
        stack.push({ abs: entAbs, rel: entRel })
        continue
      }
      if (!ent.isFile()) continue // 跳过 symlink/socket 等
      const ext = path.extname(ent.name).toLowerCase()
      if (!ALLOWED_EXTS.has(ext)) continue

      let stat
      try {
        stat = fs.statSync(entAbs)
      } catch (err) {
        return { ok: false, reason: `stat 失败 ${entRel}: ${err.message}` }
      }
      if (stat.size > MAX_FILE_BYTES) {
        return { ok: false, reason: `文件过大 ${entRel} (>${MAX_FILE_BYTES}B)` }
      }
      let content
      try {
        content = fs.readFileSync(entAbs, 'utf8')
      } catch (err) {
        return { ok: false, reason: `读文件失败 ${entRel}: ${err.message}` }
      }
      files[entRel] = content
      count += 1
      if (count > MAX_FILES) {
        return { ok: false, reason: `plugin 文件数超限 (>${MAX_FILES})` }
      }
    }
  }
  return { ok: true, files }
}

/**
 * 把一个 skill-bundle plugin 安装为 skillStore 的 skill。
 *
 * @param {{ pluginId: string, userId: string, existingIds?: string[] }} opts
 * @returns {{ ok: true, skill: object } | { ok: false, reason: string }}
 */
export function installPluginAsSkill({ pluginId, userId, existingIds = [] } = {}) {
  if (!pluginId || typeof pluginId !== 'string') {
    return { ok: false, reason: '缺少 pluginId' }
  }
  if (!userId || typeof userId !== 'string') {
    return { ok: false, reason: '缺少 userId' }
  }

  const plugin = getPlugin(pluginId)
  if (!plugin) {
    return { ok: false, reason: `plugin not found: ${pluginId}` }
  }
  if (plugin.type !== 'skill-bundle') {
    return { ok: false, reason: `plugin 类型必须是 skill-bundle (got ${plugin.type})` }
  }
  if (!plugin.rootDir || typeof plugin.rootDir !== 'string') {
    return { ok: false, reason: 'plugin 缺少 rootDir' }
  }

  let pluginDirReal
  try {
    pluginDirReal = fs.realpathSync(plugin.rootDir)
  } catch (err) {
    return { ok: false, reason: `plugin 目录不可访问: ${err.message}` }
  }

  // 必备文件：skill.json + prompts/system.md
  const skillJsonAbs = path.join(pluginDirReal, 'skill.json')
  const systemMdAbs = path.join(pluginDirReal, 'prompts', 'system.md')
  if (!fs.existsSync(skillJsonAbs)) {
    return { ok: false, reason: 'plugin 缺少 skill.json' }
  }
  if (!fs.existsSync(systemMdAbs)) {
    return { ok: false, reason: 'plugin 缺少 prompts/system.md' }
  }

  // 收集 skill.json + prompts/ 下所有允许后缀文件
  const files = {}

  try {
    files['skill.json'] = fs.readFileSync(skillJsonAbs, 'utf8')
  } catch (err) {
    return { ok: false, reason: `读 skill.json 失败: ${err.message}` }
  }

  const promptsDir = path.join(pluginDirReal, 'prompts')
  if (fs.existsSync(promptsDir) && fs.statSync(promptsDir).isDirectory()) {
    const collected = collectFiles(promptsDir, 'prompts')
    if (!collected.ok) return collected
    Object.assign(files, collected.files)
  }

  if (!files['prompts/system.md']) {
    return { ok: false, reason: 'prompts/system.md 收集失败' }
  }

  const validation = validateSkillPack(files)
  if (!validation.ok) return validation

  try {
    return installValidatedSkillPack({ files, existingIds, userId })
  } catch (err) {
    return { ok: false, reason: `安装失败: ${err.message}` }
  }
}

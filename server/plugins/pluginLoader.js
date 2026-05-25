/**
 * server/plugins/pluginLoader.js
 *
 * 同步扫描 plugins/ 顶层目录，每个子目录尝试读 plugin.json → validate →
 * 解析 entry 文件存在性。失败不抛，错误收集到 errors[]。
 *
 * 严格只读：本阶段（v0.1）从不执行任何 plugin 代码，entry 只是登记为资源路径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { validateManifest } from './pluginManifest.js'

/**
 * @param {{ rootDir?: string }} [opts]
 * @returns {{ plugins: object[], errors: { dir: string, message: string }[] }}
 */
export function loadPlugins({ rootDir = './plugins' } = {}) {
  const plugins = []
  const errors = []
  const seenIds = new Set()

  const abs = path.resolve(rootDir)
  if (!fs.existsSync(abs)) {
    return { plugins, errors }
  }

  let entries
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch (err) {
    errors.push({ dir: abs, message: `readdir failed: ${err.message}` })
    return { plugins, errors }
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const pluginDir = path.join(abs, ent.name)
    const manifestPath = path.join(pluginDir, 'plugin.json')

    if (!fs.existsSync(manifestPath)) {
      errors.push({ dir: ent.name, message: 'plugin.json missing' })
      continue
    }

    let raw
    try {
      raw = fs.readFileSync(manifestPath, 'utf8')
    } catch (err) {
      errors.push({ dir: ent.name, message: `read manifest failed: ${err.message}` })
      continue
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      errors.push({ dir: ent.name, message: `manifest is not valid JSON: ${err.message}` })
      continue
    }

    const { ok, errors: vErrs, manifest } = validateManifest(parsed)
    if (!ok) {
      errors.push({ dir: ent.name, message: `manifest invalid: ${vErrs.join('; ')}` })
      continue
    }

    if (seenIds.has(manifest.id)) {
      errors.push({ dir: ent.name, message: `duplicate plugin id: ${manifest.id}` })
      continue
    }

    const entryAbs = path.join(pluginDir, manifest.entry)
    // 防越界
    if (!entryAbs.startsWith(pluginDir + path.sep) && entryAbs !== pluginDir) {
      errors.push({ dir: ent.name, message: 'entry escapes plugin directory' })
      continue
    }
    if (!fs.existsSync(entryAbs) || !fs.statSync(entryAbs).isFile()) {
      errors.push({ dir: ent.name, message: `entry file not found: ${manifest.entry}` })
      continue
    }

    seenIds.add(manifest.id)
    plugins.push({
      ...manifest,
      dir: ent.name,
      rootDir: pluginDir,
      entryPath: entryAbs,
    })
  }

  return { plugins, errors }
}

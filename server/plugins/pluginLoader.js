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
import { assertPluginCompatibility } from '../../shared/pluginCompatibility.js'
import { PLUGIN_API_VERSION, PLUGIN_HOST_VERSION } from './pluginHostContract.js'
import { verifyPluginEntryIntegrity } from './pluginIntegrity.js'
import { validateManifest } from './pluginManifest.js'

function canonicalPath(target) {
  return fs.realpathSync.native?.(target) || fs.realpathSync(target)
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate)
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  )
}

/**
 * @param {{ rootDir?: string, resolveDependencies?: boolean, includeDirectories?: string[] | null }} [opts]
 * @returns {{ plugins: object[], errors: { dir: string, message: string }[] }}
 */
export function loadPlugins({
  rootDir = './plugins',
  hostVersion = PLUGIN_HOST_VERSION,
  apiVersion = PLUGIN_API_VERSION,
  resolveDependencies = true,
  includeDirectories = null,
} = {}) {
  const plugins = []
  const errors = []
  const seenIds = new Set()
  if (
    includeDirectories !== null
    && (
      !Array.isArray(includeDirectories)
      || includeDirectories.some((entry) => typeof entry !== 'string' || !entry)
    )
  ) {
    throw new TypeError('plugin loader includeDirectories must be null or an array of names')
  }
  const includedDirectorySet = includeDirectories === null
    ? null
    : new Set(includeDirectories)

  const abs = path.resolve(rootDir)
  if (!fs.existsSync(abs)) {
    return { plugins, errors }
  }

  let canonicalRoot
  try {
    canonicalRoot = canonicalPath(abs)
  } catch (err) {
    errors.push({ dir: abs, message: `realpath failed: ${err.message}` })
    return { plugins, errors }
  }

  let entries
  try {
    entries = fs.readdirSync(canonicalRoot, { withFileTypes: true })
  } catch (err) {
    errors.push({ dir: canonicalRoot, message: `readdir failed: ${err.message}` })
    return { plugins, errors }
  }
  entries.sort((left, right) => {
    if (left.name === right.name) return 0
    return left.name < right.name ? -1 : 1
  })

  for (const ent of entries) {
    if (includedDirectorySet && !includedDirectorySet.has(ent.name)) continue
    if (!ent.isDirectory()) continue
    const pluginDir = path.join(canonicalRoot, ent.name)
    let canonicalPluginDir
    try {
      canonicalPluginDir = canonicalPath(pluginDir)
    } catch (err) {
      errors.push({ dir: ent.name, message: `plugin directory realpath failed: ${err.message}` })
      continue
    }
    if (!isWithinDirectory(canonicalRoot, canonicalPluginDir)) {
      errors.push({ dir: ent.name, message: 'plugin directory escapes plugin root' })
      continue
    }
    const manifestPath = path.join(pluginDir, 'plugin.json')

    if (!fs.existsSync(manifestPath)) {
      errors.push({ dir: ent.name, message: 'plugin.json missing' })
      continue
    }

    let canonicalManifestPath
    try {
      canonicalManifestPath = canonicalPath(manifestPath)
    } catch (err) {
      errors.push({ dir: ent.name, message: `read manifest failed: ${err.message}` })
      continue
    }
    if (!isWithinDirectory(canonicalPluginDir, canonicalManifestPath)) {
      errors.push({ dir: ent.name, message: 'plugin.json escapes plugin directory' })
      continue
    }

    let raw
    try {
      raw = fs.readFileSync(canonicalManifestPath, 'utf8')
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

    const entryAbs = path.resolve(canonicalPluginDir, manifest.entry)
    // 防越界
    if (!isWithinDirectory(canonicalPluginDir, entryAbs)) {
      errors.push({ dir: ent.name, message: 'entry escapes plugin directory' })
      continue
    }
    let canonicalEntryPath
    try {
      canonicalEntryPath = canonicalPath(entryAbs)
    } catch {
      errors.push({ dir: ent.name, message: `entry file not found: ${manifest.entry}` })
      continue
    }
    if (!isWithinDirectory(canonicalPluginDir, canonicalEntryPath)) {
      errors.push({ dir: ent.name, message: 'entry escapes plugin directory through symlink' })
      continue
    }
    if (!fs.statSync(canonicalEntryPath).isFile()) {
      errors.push({ dir: ent.name, message: `entry file not found: ${manifest.entry}` })
      continue
    }
    if (manifest.integrity) {
      try {
        verifyPluginEntryIntegrity({
          integrity: manifest.integrity,
          bytes: fs.readFileSync(canonicalEntryPath),
        })
      } catch (err) {
        errors.push({
          dir: ent.name,
          message: `entry integrity check failed [${err.code || 'PLUGIN_INTEGRITY_FAILED'}]: ${err.message}`,
        })
        continue
      }
    }
    try {
      assertPluginCompatibility(manifest, {
        hostVersion,
        apiVersion,
        checkDependencies: false,
      })
    } catch (err) {
      errors.push({
        dir: ent.name,
        message: `plugin compatibility check failed [${err.code || 'PLUGIN_COMPATIBILITY_FAILED'}]: ${err.message}`,
      })
      continue
    }

    seenIds.add(manifest.id)
    plugins.push({
      ...manifest,
      dir: ent.name,
      rootDir: canonicalPluginDir,
      entryPath: canonicalEntryPath,
    })
  }

  if (!resolveDependencies) return { plugins, errors }
  const resolved = resolvePluginDependencyCompatibility(plugins, { hostVersion, apiVersion })
  errors.push(...resolved.errors.map(({ dir, message }) => ({ dir, message })))
  return { plugins: resolved.plugins, errors }
}

export function resolvePluginDependencyCompatibility(plugins, {
  hostVersion = PLUGIN_HOST_VERSION,
  apiVersion = PLUGIN_API_VERSION,
} = {}) {
  const compatible = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  const errors = []
  let changed = true
  while (changed) {
    changed = false
    for (const plugin of compatible.values()) {
      try {
        assertPluginCompatibility(plugin, {
          hostVersion,
          apiVersion,
          resolveDependencyVersion: (dependencyId) => compatible.get(dependencyId)?.version || null,
        })
      } catch (err) {
        compatible.delete(plugin.id)
        errors.push({
          pluginId: plugin.id,
          dir: plugin.dir,
          message: `plugin compatibility check failed [${err.code || 'PLUGIN_COMPATIBILITY_FAILED'}]: ${err.message}`,
        })
        changed = true
      }
    }
  }

  return { plugins: plugins.filter((plugin) => compatible.has(plugin.id)), errors }
}

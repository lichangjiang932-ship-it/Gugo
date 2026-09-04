/**
 * 同步扫描 plugins/ 顶层目录；严格只读，不执行 plugin entry。
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

function recordPluginError(errors, dir, message) {
  errors.push({ dir, message })
  return null
}

function loadPluginDirectory({ canonicalRoot, entry, errors, seenIds, hostVersion, apiVersion }) {
  const pluginDir = path.join(canonicalRoot, entry.name)
  let canonicalPluginDir
  try {
    canonicalPluginDir = canonicalPath(pluginDir)
  } catch (error) {
    return recordPluginError(errors, entry.name, `plugin directory realpath failed: ${error.message}`)
  }
  if (!isWithinDirectory(canonicalRoot, canonicalPluginDir)) {
    return recordPluginError(errors, entry.name, 'plugin directory escapes plugin root')
  }
  const manifestPath = path.join(pluginDir, 'plugin.json')
  if (!fs.existsSync(manifestPath)) return recordPluginError(errors, entry.name, 'plugin.json missing')

  let canonicalManifestPath
  try {
    canonicalManifestPath = canonicalPath(manifestPath)
  } catch (error) {
    return recordPluginError(errors, entry.name, `read manifest failed: ${error.message}`)
  }
  if (!isWithinDirectory(canonicalPluginDir, canonicalManifestPath)) {
    return recordPluginError(errors, entry.name, 'plugin.json escapes plugin directory')
  }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(canonicalManifestPath, 'utf8'))
  } catch (error) {
    const kind = error instanceof SyntaxError ? 'manifest is not valid JSON' : 'read manifest failed'
    return recordPluginError(errors, entry.name, `${kind}: ${error.message}`)
  }
  const validated = validateManifest(parsed)
  if (!validated.ok) {
    return recordPluginError(errors, entry.name, `manifest invalid: ${validated.errors.join('; ')}`)
  }
  const { manifest } = validated
  if (seenIds.has(manifest.id)) {
    return recordPluginError(errors, entry.name, `duplicate plugin id: ${manifest.id}`)
  }

  const entryAbs = path.resolve(canonicalPluginDir, manifest.entry)
  if (!isWithinDirectory(canonicalPluginDir, entryAbs)) {
    return recordPluginError(errors, entry.name, 'entry escapes plugin directory')
  }
  let canonicalEntryPath
  try {
    canonicalEntryPath = canonicalPath(entryAbs)
  } catch {
    return recordPluginError(errors, entry.name, `entry file not found: ${manifest.entry}`)
  }
  if (!isWithinDirectory(canonicalPluginDir, canonicalEntryPath)) {
    return recordPluginError(errors, entry.name, 'entry escapes plugin directory through symlink')
  }
  if (!fs.statSync(canonicalEntryPath).isFile()) {
    return recordPluginError(errors, entry.name, `entry file not found: ${manifest.entry}`)
  }
  if (manifest.integrity) {
    try {
      verifyPluginEntryIntegrity({
        integrity: manifest.integrity,
        bytes: fs.readFileSync(canonicalEntryPath),
      })
    } catch (error) {
      return recordPluginError(
        errors,
        entry.name,
        `entry integrity check failed [${error.code || 'PLUGIN_INTEGRITY_FAILED'}]: ${error.message}`,
      )
    }
  }
  try {
    assertPluginCompatibility(manifest, { hostVersion, apiVersion, checkDependencies: false })
  } catch (error) {
    return recordPluginError(
      errors,
      entry.name,
      `plugin compatibility check failed [${error.code || 'PLUGIN_COMPATIBILITY_FAILED'}]: ${error.message}`,
    )
  }
  seenIds.add(manifest.id)
  return {
    ...manifest,
    dir: entry.name,
    rootDir: canonicalPluginDir,
    entryPath: canonicalEntryPath,
  }
}

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
  if (includeDirectories !== null && (
    !Array.isArray(includeDirectories)
    || includeDirectories.some((entry) => typeof entry !== 'string' || !entry)
  )) {
    throw new TypeError('plugin loader includeDirectories must be null or an array of names')
  }
  const includedDirectorySet = includeDirectories === null ? null : new Set(includeDirectories)
  const abs = path.resolve(rootDir)
  if (!fs.existsSync(abs)) return { plugins, errors }

  let canonicalRoot
  try {
    canonicalRoot = canonicalPath(abs)
  } catch (error) {
    errors.push({ dir: abs, message: `realpath failed: ${error.message}` })
    return { plugins, errors }
  }
  let entries
  try {
    entries = fs.readdirSync(canonicalRoot, { withFileTypes: true })
  } catch (error) {
    errors.push({ dir: canonicalRoot, message: `readdir failed: ${error.message}` })
    return { plugins, errors }
  }
  entries.sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1)
  for (const entry of entries) {
    if (includedDirectorySet && !includedDirectorySet.has(entry.name)) continue
    if (!entry.isDirectory()) continue
    const plugin = loadPluginDirectory({
      canonicalRoot,
      entry,
      errors,
      seenIds,
      hostVersion,
      apiVersion,
    })
    if (plugin) plugins.push(plugin)
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
      } catch (error) {
        compatible.delete(plugin.id)
        errors.push({
          pluginId: plugin.id,
          dir: plugin.dir,
          message: `plugin compatibility check failed [${error.code || 'PLUGIN_COMPATIBILITY_FAILED'}]: ${error.message}`,
        })
        changed = true
      }
    }
  }
  return { plugins: plugins.filter((plugin) => compatible.has(plugin.id)), errors }
}

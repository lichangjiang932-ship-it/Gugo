import fs from 'node:fs'
import path from 'node:path'

import { resolveRuntimeConfigPaths } from '../utils/runtimeEnv.js'
import { discoverInstalledLocalPluginPackagesSync } from './localPluginPackageStore.js'
import { loadPlugins, resolvePluginDependencyCompatibility } from './pluginLoader.js'
import {
  createLocalDirectoryPluginDistributionPort,
  discoverPluginDistribution,
} from './pluginDistribution.js'

export const BUILTIN_PLUGIN_SOURCE = 'builtin-directory-readonly'
export const MANAGED_USER_PLUGIN_SOURCE = 'managed-user-directory'
export const MANAGED_USER_PLUGIN_DIRNAME = 'plugins'

function distributionSourceError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function compareText(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function normalizedPathIdentity(value, platform = process.platform) {
  if (typeof value !== 'string' || !value.trim()) {
    throw distributionSourceError(
      'PLUGIN_DISTRIBUTION_ROOT_INVALID',
      'plugin distribution root must be a non-empty string',
    )
  }
  const resolved = path.resolve(value)
  const missingSegments = []
  let cursor = resolved
  let canonical = resolved
  while (true) {
    try {
      canonical = path.join(fs.realpathSync.native(cursor), ...missingSegments.reverse())
      break
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw distributionSourceError(
          'PLUGIN_DISTRIBUTION_ROOT_INVALID',
          `plugin distribution root cannot be resolved: ${error?.message || 'unknown error'}`,
        )
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      missingSegments.push(path.basename(cursor))
      cursor = parent
    }
  }
  const normalized = path.normalize(canonical)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  )
}

function distributionRootRelationship(builtinRoot, managedRoot, platform) {
  const builtinIdentity = normalizedPathIdentity(builtinRoot, platform)
  const managedIdentity = normalizedPathIdentity(managedRoot, platform)
  return {
    same: builtinIdentity === managedIdentity,
    overlaps: isSameOrDescendant(builtinIdentity, managedIdentity)
      || isSameOrDescendant(managedIdentity, builtinIdentity),
  }
}

function sourceError(error, sourceKind) {
  return {
    dir: `${sourceKind}:${String(error?.dir || 'unknown')}`,
    message: String(error?.message || 'plugin discovery failed'),
  }
}

function conflictError(candidate, winner) {
  return {
    dir: `${candidate.sourceKind}:${String(candidate.plugin.dir || candidate.plugin.id)}`,
    message: `plugin id conflict [PLUGIN_DISTRIBUTION_ID_CONFLICT]: ${candidate.plugin.id}; ${winner.sourceKind} remains authoritative`,
  }
}

function discoverDirectory(port, rootDir) {
  return discoverPluginDistribution(port, {
    rootDir,
    resolveDependencies: false,
  })
}

export function resolveManagedUserPluginRoot({
  cwd = process.cwd(),
  env = process.env,
  resolvePaths = resolveRuntimeConfigPaths,
} = {}) {
  if (typeof resolvePaths !== 'function') {
    throw distributionSourceError(
      'PLUGIN_DISTRIBUTION_PATH_RESOLVER_INVALID',
      'plugin distribution path resolver must be a function',
    )
  }
  const paths = resolvePaths({ cwd, env })
  if (!paths || typeof paths.user !== 'string' || !paths.user) {
    throw distributionSourceError(
      'PLUGIN_DISTRIBUTION_PATH_RESOLVER_INVALID',
      'plugin distribution path resolver must return the user runtime config path',
    )
  }
  return path.join(path.dirname(paths.user), MANAGED_USER_PLUGIN_DIRNAME)
}

/**
 * Offline source composition for shipped plugins and user-owned local packages.
 * It discovers directories only; install, update, download and signature policy
 * remain outside this port.
 */
export function createBuiltinManagedPluginDistributionPort({
  load = loadPlugins,
  resolvePaths = resolveRuntimeConfigPaths,
  platform = process.platform,
} = {}) {
  if (typeof load !== 'function') {
    throw distributionSourceError(
      'PLUGIN_DISTRIBUTION_PORT_INVALID',
      'plugin distribution load adapter must be a function',
    )
  }
  const builtinPort = createLocalDirectoryPluginDistributionPort({
    load,
    sourceKind: BUILTIN_PLUGIN_SOURCE,
    mutable: false,
    verifiedPackage: false,
    installReceipt: null,
  })
  return Object.freeze({
    discover(options = {}) {
      const builtinRoot = options.rootDir || './plugins'
      const managedRoot = options.managedRootDir || resolveManagedUserPluginRoot({
        cwd: options.cwd,
        env: options.env,
        resolvePaths,
      })
      const rootRelationship = distributionRootRelationship(
        builtinRoot,
        managedRoot,
        platform,
      )
      const builtin = discoverDirectory(builtinPort, builtinRoot)
      const errors = builtin.errors.map((error) => sourceError(error, BUILTIN_PLUGIN_SOURCE))
      let managed = { candidates: [], errors: [] }
      if (rootRelationship.overlaps) {
        errors.push({
          dir: `${MANAGED_USER_PLUGIN_SOURCE}:${path.resolve(String(managedRoot))}`,
          message: `managed plugin root ${rootRelationship.same ? 'aliases' : 'overlaps'} the protected builtin root [PLUGIN_DISTRIBUTION_ROOT_CONFLICT]`,
        })
      } else {
        try {
          const verified = discoverInstalledLocalPluginPackagesSync({
            managedRoot,
            load,
          })
          managed = {
            candidates: verified.plugins.map(({ plugin, installReceipt }) => ({
              plugin,
              sourceKind: MANAGED_USER_PLUGIN_SOURCE,
              mutable: false,
              verifiedPackage: true,
              installReceipt,
            })),
            errors: verified.errors,
          }
        } catch (error) {
          managed = {
            candidates: [],
            errors: [{
              dir: path.resolve(String(managedRoot)),
              message: `managed package store unavailable [${error?.code || 'PLUGIN_PACKAGE_STORE_FAILED'}]: ${error?.message || error}`,
            }],
          }
        }
        errors.push(...managed.errors.map((error) => sourceError(error, MANAGED_USER_PLUGIN_SOURCE)))
      }

      const ordered = [...builtin.candidates, ...managed.candidates]
        .sort((left, right) => (
          compareText(left.plugin.id, right.plugin.id)
          || compareText(left.sourceKind, right.sourceKind)
        ))
      const selected = []
      const byId = new Map()
      for (const candidate of ordered) {
        const existing = byId.get(candidate.plugin.id)
        if (!existing) {
          byId.set(candidate.plugin.id, candidate)
          selected.push(candidate)
          continue
        }
        const winner = existing.sourceKind === BUILTIN_PLUGIN_SOURCE
          ? existing
          : candidate.sourceKind === BUILTIN_PLUGIN_SOURCE
            ? candidate
            : existing
        const rejected = winner === existing ? candidate : existing
        errors.push(conflictError(rejected, winner))
        if (winner !== existing) {
          byId.set(candidate.plugin.id, winner)
          selected.splice(selected.indexOf(existing), 1, winner)
        }
      }

      const compatibility = resolvePluginDependencyCompatibility(
        selected.map((candidate) => candidate.plugin),
      )
      const compatibleIds = new Set(compatibility.plugins.map((plugin) => plugin.id))
      for (const error of compatibility.errors) {
        const sourceKind = byId.get(error.pluginId)?.sourceKind || 'unknown-source'
        errors.push(sourceError(error, sourceKind))
      }
      return {
        candidates: selected
          .filter((candidate) => compatibleIds.has(candidate.plugin.id))
          .sort((left, right) => compareText(left.plugin.id, right.plugin.id)),
        errors: errors.sort((left, right) => (
          compareText(left.dir, right.dir) || compareText(left.message, right.message)
        )),
        // Keep every individually valid builtin identity, including plugins
        // later hidden by dependency compatibility. Package mutation guards
        // must not infer reserved ids from only the active candidate set.
        protectedPluginIds: builtin.candidates.map((candidate) => candidate.plugin.id),
        protectedPluginIdentityComplete: builtin.errors.length === 0,
      }
    },
  })
}

export const builtinManagedPluginDistributionPort = createBuiltinManagedPluginDistributionPort()

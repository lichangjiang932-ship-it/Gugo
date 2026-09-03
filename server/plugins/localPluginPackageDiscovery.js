import fs from 'node:fs'
import path from 'node:path'

import { loadPlugins } from './pluginLoader.js'
import { localPluginPackageStoreRevision } from './localPluginPackageReceipt.js'
import {
  LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION,
  assertExpectedRevision,
  packageStoreError,
  resolveStorePaths,
  validatePluginId,
} from './localPluginPackageStoreSupport.js'
import {
  assertStoreLockOwned,
  withStoreLock,
  withStoreLockSync,
} from './localPluginPackageStoreLock.js'
import { recoverLocalPluginPackageTransactionsLocked } from './localPluginPackageRecovery.js'
import { verifyInstalledLocalPluginPackage } from './localPluginPackageVerification.js'

export function localPluginPackageStoreSnapshot(root) {
  const packages = []
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw packageStoreError(
        'PLUGIN_PACKAGE_STORE_CORRUPT',
        `managed plugin store contains an unexpected entry: ${entry.name}`,
        409,
      )
    }
    validatePluginId(entry.name, 'PLUGIN_PACKAGE_STORE_CORRUPT')
    packages.push(verifyInstalledLocalPluginPackage(path.join(root, entry.name)))
  }
  packages.sort((left, right) => left.pluginId.localeCompare(right.pluginId, 'en'))
  return Object.freeze({
    schemaVersion: LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION,
    revision: localPluginPackageStoreRevision(packages),
    packages: Object.freeze(packages),
  })
}

function discoveryError(dir, error) {
  return Object.freeze({
    dir,
    message: `managed plugin package verification failed [${error?.code || 'PLUGIN_PACKAGE_INVALID'}]: ${error?.message || error}`,
  })
}

export function discoverInstalledLocalPluginPackagesSync({
  managedRoot,
  load = loadPlugins,
} = {}) {
  if (typeof load !== 'function') {
    throw packageStoreError(
      'PLUGIN_PACKAGE_DISCOVERY_LOADER_INVALID',
      'managed plugin package discovery loader must be a function',
    )
  }
  const paths = resolveStorePaths(managedRoot)
  return withStoreLockSync(paths, () => {
    recoverLocalPluginPackageTransactionsLocked(paths)
    const receipts = new Map()
    const errors = []
    const entries = fs.readdirSync(paths.root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      try {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw packageStoreError(
            'PLUGIN_PACKAGE_STORE_CORRUPT',
            'managed package entry must be a real directory',
            409,
          )
        }
        const pluginId = validatePluginId(entry.name, 'PLUGIN_PACKAGE_STORE_CORRUPT')
        const receipt = verifyInstalledLocalPluginPackage(path.join(paths.root, entry.name))
        if (receipt.pluginId !== pluginId) {
          throw packageStoreError(
            'PLUGIN_PACKAGE_CONTENT_MISMATCH',
            'managed package directory and receipt identities differ',
            409,
          )
        }
        receipts.set(pluginId, receipt)
      } catch (error) {
        errors.push(discoveryError(entry.name, error))
      }
    }

    const loaded = load({
      rootDir: paths.root,
      resolveDependencies: false,
      includeDirectories: [...receipts.keys()],
    })
    if (!loaded || !Array.isArray(loaded.plugins) || !Array.isArray(loaded.errors)) {
      throw packageStoreError(
        'PLUGIN_PACKAGE_DISCOVERY_LOADER_INVALID',
        'managed plugin package loader returned an invalid result',
      )
    }
    errors.push(...loaded.errors.map((error) => Object.freeze({
      dir: String(error?.dir || 'unknown'),
      message: String(error?.message || 'managed plugin manifest load failed'),
    })))

    const plugins = []
    const loadedIds = new Set()
    for (const plugin of loaded.plugins) {
      const receipt = receipts.get(plugin?.id)
      if (!receipt || plugin.dir !== plugin.id || plugin.version !== receipt.pluginVersion) {
        errors.push(discoveryError(
          String(plugin?.dir || plugin?.id || 'unknown'),
          packageStoreError(
            'PLUGIN_PACKAGE_CONTENT_MISMATCH',
            'loaded plugin identity does not match its install receipt',
            409,
          ),
        ))
        continue
      }
      try {
        const finalReceipt = verifyInstalledLocalPluginPackage(plugin.rootDir)
        if (finalReceipt.packageDigest !== receipt.packageDigest) {
          throw packageStoreError(
            'PLUGIN_PACKAGE_SOURCE_CHANGED',
            'managed plugin package changed during discovery',
            409,
          )
        }
        loadedIds.add(plugin.id)
        plugins.push(Object.freeze({ plugin, installReceipt: finalReceipt }))
      } catch (error) {
        errors.push(discoveryError(plugin.dir, error))
      }
    }
    for (const pluginId of receipts.keys()) {
      if (loadedIds.has(pluginId)) continue
      if (!errors.some((error) => error.dir === pluginId)) {
        errors.push(Object.freeze({
          dir: pluginId,
          message: 'managed plugin package could not be loaded after receipt verification',
        }))
      }
    }
    plugins.sort((left, right) => left.plugin.id.localeCompare(right.plugin.id, 'en'))
    errors.sort((left, right) => (
      left.dir.localeCompare(right.dir, 'en')
      || left.message.localeCompare(right.message, 'en')
    ))
    return Object.freeze({
      plugins: Object.freeze(plugins),
      errors: Object.freeze(errors),
    })
  })
}

export async function listInstalledLocalPluginPackages({ managedRoot }) {
  const paths = resolveStorePaths(managedRoot)
  return withStoreLock(paths, async () => {
    recoverLocalPluginPackageTransactionsLocked(paths)
    return localPluginPackageStoreSnapshot(paths.root)
  })
}

export async function runWithLockedLocalPluginPackageStoreSnapshot({
  managedRoot,
  expectedRevision,
  operation,
} = {}) {
  if (typeof operation !== 'function') {
    throw packageStoreError(
      'PLUGIN_PACKAGE_RECOVERY_VERIFIER_INVALID',
      'plugin package recovery verifier must be a function',
    )
  }
  const paths = resolveStorePaths(managedRoot)
  return withStoreLock(paths, async () => {
    recoverLocalPluginPackageTransactionsLocked(paths)
    const snapshot = localPluginPackageStoreSnapshot(paths.root)
    assertExpectedRevision(expectedRevision, snapshot.revision)
    assertStoreLockOwned(paths.transactionRoot)
    return operation(snapshot)
  })
}

export function listInstalledLocalPluginPackagesSync({ managedRoot }) {
  const paths = resolveStorePaths(managedRoot)
  return withStoreLockSync(paths, () => {
    recoverLocalPluginPackageTransactionsLocked(paths)
    return localPluginPackageStoreSnapshot(paths.root)
  })
}

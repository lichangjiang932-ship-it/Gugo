import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { loadPlugins } from './pluginLoader.js'
import { resolveLocalPluginMarketplacePublication } from './localPluginMarketplace.js'
import {
  LEGACY_LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION,
  LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION,
  localPluginPackageReceiptIdentity,
} from './localPluginPackageReceipt.js'
import { LOCAL_PLUGIN_PACKAGE_TRANSACTION_SCHEMA_VERSION } from './localPluginPackageTransactionMetadata.js'
import {
  LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE,
  snapshotLocalPluginPackage,
} from './localPluginPackageSnapshot.js'
import {
  assertExpectedRevision,
  durableJson,
  durableWrite,
  isSameOrDescendant,
  packageStoreError,
  resolveStorePaths,
  safeRemoveTransactionDirectory,
  syncDirectory,
  syncDirectoryTree,
  transactionPaths,
  validatePluginId,
} from './localPluginPackageStoreSupport.js'
import { assertStoreLockOwned, withStoreLock } from './localPluginPackageStoreLock.js'
import {
  markLocalPluginPackageTransactionActive,
  markLocalPluginPackageTransactionInactive,
  recoverLocalPluginPackageTransactionsLocked,
  restoreUncommittedLocalPluginPackageTransaction,
} from './localPluginPackageRecovery.js'
import { localPluginPackageStoreSnapshot } from './localPluginPackageDiscovery.js'
import { verifyInstalledLocalPluginPackage } from './localPluginPackageVerification.js'

function assertSourceOutsideStore(sourceRoot, root, transactionRoot) {
  if (
    isSameOrDescendant(root, sourceRoot)
    || isSameOrDescendant(sourceRoot, root)
    || isSameOrDescendant(transactionRoot, sourceRoot)
    || isSameOrDescendant(sourceRoot, transactionRoot)
  ) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_SOURCE_OVERLAP',
      'plugin package source must be outside the managed package store',
    )
  }
}

function copySnapshotToStage(snapshot, stagePlugin) {
  fs.mkdirSync(stagePlugin, { recursive: true, mode: 0o700 })
  for (const relativePath of snapshot.directories) {
    fs.mkdirSync(
      path.join(stagePlugin, ...relativePath.split('/')),
      { recursive: true, mode: 0o700 },
    )
  }
  for (const file of snapshot.files) {
    const digest = Buffer.isBuffer(file.bytes)
      ? createHash('sha256').update(file.bytes).digest('hex')
      : null
    if (
      !Buffer.isBuffer(file.bytes)
      || file.bytes.length !== file.sizeBytes
      || digest !== file.contentDigest
    ) {
      throw packageStoreError(
        'PLUGIN_PACKAGE_SNAPSHOT_INVALID',
        `plugin package snapshot bytes do not match ${file.relativePath}`,
      )
    }
    const target = path.join(stagePlugin, ...file.relativePath.split('/'))
    durableWrite(target, file.bytes)
  }
}

function validateStagedPlugin(stageRoot, expectedPluginId, expectedVersion) {
  const loaded = loadPlugins({ rootDir: stageRoot, resolveDependencies: false })
  if (
    loaded.errors.length
    || loaded.plugins.length !== 1
    || loaded.plugins[0].id !== expectedPluginId
    || loaded.plugins[0].version !== expectedVersion
  ) {
    const reason = loaded.errors.map((error) => error.message).join('; ')
      || 'staged package identity did not match the captured manifest'
    throw packageStoreError(
      'PLUGIN_PACKAGE_STAGE_INVALID',
      `plugin package failed staged validation: ${reason}`,
    )
  }
}

async function runMutationTransaction({
  operation,
  pluginId,
  root,
  transactionRoot,
  hadExisting,
  prepareStage,
  packageDigest = null,
  previousPackageDigest = null,
  packageReceiptIdentity = null,
  previousPackageReceiptIdentity = null,
}) {
  const transactionId = randomUUID()
  const paths = transactionPaths(root, transactionRoot, transactionId, pluginId)
  const journal = {
    schemaVersion: LOCAL_PLUGIN_PACKAGE_TRANSACTION_SCHEMA_VERSION,
    transactionId,
    operation,
    pluginId,
    hadExisting,
    packageDigest,
    previousPackageDigest,
    packageReceiptIdentity,
    previousPackageReceiptIdentity,
  }
  markLocalPluginPackageTransactionActive(transactionId)
  try {
    try {
      assertStoreLockOwned(transactionRoot)
      fs.mkdirSync(paths.transactionDir, { recursive: false, mode: 0o700 })
      fs.mkdirSync(paths.backupRoot, { recursive: true, mode: 0o700 })
      durableJson(paths.journalPath, journal)
      syncDirectory(paths.transactionDir)
      if (prepareStage) prepareStage(paths)
      assertStoreLockOwned(transactionRoot)
      if (operation === 'install') {
        if (hadExisting) {
          fs.renameSync(paths.targetPlugin, paths.backupPlugin)
          syncDirectory(root)
          syncDirectory(paths.backupRoot)
          assertStoreLockOwned(transactionRoot)
        }
        fs.renameSync(paths.stagePlugin, paths.targetPlugin)
        syncDirectory(root)
        syncDirectory(paths.stageRoot)
      } else {
        fs.renameSync(paths.targetPlugin, paths.backupPlugin)
        syncDirectory(root)
        syncDirectory(paths.backupRoot)
      }
      durableWrite(paths.committedPath, 'committed\n')
      syncDirectory(paths.transactionDir)
    } catch (error) {
      let rollbackError = null
      try {
        if (fs.existsSync(paths.committedPath)) {
          fs.unlinkSync(paths.committedPath)
          syncDirectory(paths.transactionDir)
        }
        restoreUncommittedLocalPluginPackageTransaction(paths, journal)
        assertStoreLockOwned(transactionRoot)
        safeRemoveTransactionDirectory(paths.transactionDir, transactionRoot)
      } catch (caught) {
        rollbackError = caught
      }
      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'plugin package mutation failed and rollback could not be completed',
          { cause: error },
        )
      }
      throw error
    }

    try {
      assertStoreLockOwned(transactionRoot)
      safeRemoveTransactionDirectory(paths.transactionDir, transactionRoot)
      return { cleanupDeferred: false }
    } catch (error) {
      if (error?.code === 'PLUGIN_PACKAGE_STORE_LOCK_LOST') throw error
      return { cleanupDeferred: true }
    }
  } finally {
    markLocalPluginPackageTransactionInactive(transactionId)
  }
}

export async function installLocalPluginPackage({
  sourceDir,
  managedRoot,
  expectedRevision,
  expectedPluginId = null,
  replace = false,
  protectedPluginIds = [],
  assertMutationAvailable = null,
  now = Date.now,
} = {}) {
  if (assertMutationAvailable !== null && typeof assertMutationAvailable !== 'function') {
    throw packageStoreError(
      'PLUGIN_PACKAGE_MUTATION_GUARD_INVALID',
      'plugin package mutation guard must be a function',
    )
  }
  const storePaths = resolveStorePaths(managedRoot)
  return withStoreLock(storePaths, async () => {
    recoverLocalPluginPackageTransactionsLocked(storePaths)
    const before = localPluginPackageStoreSnapshot(storePaths.root)
    assertExpectedRevision(expectedRevision, before.revision)

    const snapshot = snapshotLocalPluginPackage(sourceDir, { captureBytes: true })
    assertSourceOutsideStore(snapshot.sourceRoot, storePaths.root, storePaths.transactionRoot)
    const pluginId = validatePluginId(snapshot.manifest.id)
    if (assertMutationAvailable) {
      const guardResult = assertMutationAvailable(pluginId)
      if (guardResult && typeof guardResult.then === 'function') {
        throw packageStoreError(
          'PLUGIN_PACKAGE_MUTATION_GUARD_INVALID',
          'plugin package mutation guard must be synchronous',
        )
      }
    }
    if (expectedPluginId !== null && validatePluginId(expectedPluginId) !== pluginId) {
      throw packageStoreError(
        'PLUGIN_PACKAGE_ID_MISMATCH',
        `selected package id ${pluginId} does not match the expected plugin id`,
      )
    }
    if (new Set(protectedPluginIds.map((id) => String(id))).has(pluginId)) {
      throw packageStoreError(
        'PLUGIN_PACKAGE_ID_PROTECTED',
        `plugin id ${pluginId} is reserved by a built-in package`,
        409,
      )
    }
    const publication = resolveLocalPluginMarketplacePublication({
      sourceRoot: snapshot.sourceRoot,
      pluginId,
      pluginVersion: snapshot.manifest.version,
      packageDigest: snapshot.packageDigest,
    })
    const desiredReceiptView = Object.freeze({
      schemaVersion: publication
        ? LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION
        : LEGACY_LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION,
      pluginId,
      pluginVersion: snapshot.manifest.version,
      packageDigest: snapshot.packageDigest,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      installedAt: 0,
      publisherVerified: Boolean(publication),
      sourceKind: publication ? 'local-marketplace' : 'local-directory',
      ...(publication ? {
        marketplace: publication.metadata.marketplace,
        publisher: publication.metadata.publisher,
        publicationDigest: publication.metadataDigest,
      } : {}),
    })
    const desiredReceiptIdentity = localPluginPackageReceiptIdentity(desiredReceiptView)
    const existing = before.packages.find((entry) => entry.pluginId === pluginId) || null
    if (
      existing?.packageDigest === snapshot.packageDigest
      && localPluginPackageReceiptIdentity(existing) === desiredReceiptIdentity
    ) {
      return Object.freeze({
        changed: false,
        operation: 'unchanged',
        package: existing,
        store: before,
        cleanupDeferred: false,
      })
    }
    if (existing && replace !== true) {
      throw packageStoreError(
        'PLUGIN_PACKAGE_ALREADY_INSTALLED',
        `plugin package ${pluginId} is already installed; explicit replacement is required`,
        409,
      )
    }

    const installedAt = Number(now())
    if (!Number.isSafeInteger(installedAt) || installedAt < 0) {
      throw packageStoreError('PLUGIN_PACKAGE_CLOCK_INVALID', 'plugin package install clock is invalid')
    }
    const receipt = Object.freeze({
      schemaVersion: publication
        ? LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION
        : LEGACY_LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION,
      pluginId,
      pluginVersion: snapshot.manifest.version,
      packageDigest: snapshot.packageDigest,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      installedAt,
      publisherVerified: Boolean(publication),
      sourceKind: publication ? 'local-marketplace' : 'local-directory',
      ...(publication ? { publication } : {}),
    })
    const transaction = await runMutationTransaction({
      operation: 'install',
      pluginId,
      root: storePaths.root,
      transactionRoot: storePaths.transactionRoot,
      hadExisting: Boolean(existing),
      packageDigest: snapshot.packageDigest,
      previousPackageDigest: existing?.packageDigest || null,
      packageReceiptIdentity: desiredReceiptIdentity,
      previousPackageReceiptIdentity: existing
        ? localPluginPackageReceiptIdentity(existing)
        : null,
      prepareStage(paths) {
        copySnapshotToStage(snapshot, paths.stagePlugin)
        durableJson(path.join(paths.stagePlugin, LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE), receipt)
        validateStagedPlugin(paths.stageRoot, pluginId, snapshot.manifest.version)
        verifyInstalledLocalPluginPackage(paths.stagePlugin)
        syncDirectoryTree(paths.stagePlugin)
        syncDirectory(paths.stageRoot)
      },
    })
    const after = localPluginPackageStoreSnapshot(storePaths.root)
    return Object.freeze({
      changed: true,
      operation: existing ? 'upgraded' : 'installed',
      package: after.packages.find((entry) => entry.pluginId === pluginId),
      store: after,
      cleanupDeferred: transaction.cleanupDeferred,
    })
  })
}

export async function uninstallLocalPluginPackage({
  pluginId,
  managedRoot,
  expectedRevision,
} = {}) {
  const id = validatePluginId(pluginId)
  const storePaths = resolveStorePaths(managedRoot)
  return withStoreLock(storePaths, async () => {
    recoverLocalPluginPackageTransactionsLocked(storePaths)
    const before = localPluginPackageStoreSnapshot(storePaths.root)
    assertExpectedRevision(expectedRevision, before.revision)
    const existing = before.packages.find((entry) => entry.pluginId === id)
    if (!existing) {
      throw packageStoreError(
        'PLUGIN_PACKAGE_NOT_INSTALLED',
        `plugin package ${id} is not installed`,
        404,
      )
    }
    const transaction = await runMutationTransaction({
      operation: 'uninstall',
      pluginId: id,
      root: storePaths.root,
      transactionRoot: storePaths.transactionRoot,
      hadExisting: true,
      packageDigest: null,
      previousPackageDigest: existing.packageDigest,
      packageReceiptIdentity: null,
      previousPackageReceiptIdentity: localPluginPackageReceiptIdentity(existing),
    })
    const after = localPluginPackageStoreSnapshot(storePaths.root)
    return Object.freeze({
      changed: true,
      operation: 'uninstalled',
      package: existing,
      store: after,
      cleanupDeferred: transaction.cleanupDeferred,
    })
  })
}

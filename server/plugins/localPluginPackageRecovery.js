import fs from 'node:fs'
import path from 'node:path'

import { readBoundedJson } from './localPluginPackageMetadata.js'
import {
  assertLocalPluginPackageTransactionReceipt as assertTransactionDigest,
  validateLocalPluginPackageTransactionJournal as validateTransactionJournal,
} from './localPluginPackageTransactionMetadata.js'
import {
  LOCAL_PLUGIN_PACKAGE_METADATA_LIMIT_BYTES,
  packageStoreError,
  resolveStorePaths,
  safeRemoveTransactionDirectory,
  syncDirectory,
  transactionPaths,
} from './localPluginPackageStoreSupport.js'
import {
  LOCAL_PLUGIN_PACKAGE_STORE_LOCK_FILE,
  assertStoreLockOwned,
  withStoreLock,
} from './localPluginPackageStoreLock.js'
import { verifyInstalledLocalPluginPackage } from './localPluginPackageVerification.js'

const TRANSACTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ACTIVE_TRANSACTIONS = new Set()

export function markLocalPluginPackageTransactionActive(transactionId) {
  ACTIVE_TRANSACTIONS.add(transactionId)
}

export function markLocalPluginPackageTransactionInactive(transactionId) {
  ACTIVE_TRANSACTIONS.delete(transactionId)
}

function transactionCorrupt(message) {
  return packageStoreError('PLUGIN_PACKAGE_TRANSACTION_CORRUPT', message, 409)
}

function readTransactionPackage(packagePath, label, pluginId) {
  if (!fs.existsSync(packagePath)) return null
  let receipt
  try {
    receipt = verifyInstalledLocalPluginPackage(packagePath)
  } catch (error) {
    throw transactionCorrupt(
      `${label} for ${pluginId} is not a verified installed package: ${error?.message || error}`,
    )
  }
  if (receipt.pluginId !== pluginId) {
    throw transactionCorrupt(`${label} identity does not match transaction ${pluginId}`)
  }
  return receipt
}

export function restoreUncommittedLocalPluginPackageTransaction(paths, journal) {
  const target = readTransactionPackage(paths.targetPlugin, 'transaction target', journal.pluginId)
  const backup = readTransactionPackage(paths.backupPlugin, 'transaction backup', journal.pluginId)
  if (journal.operation === 'install') {
    if (backup) {
      if (!journal.hadExisting) {
        throw transactionCorrupt(`new install for ${journal.pluginId} unexpectedly has a backup`)
      }
      assertTransactionDigest(
        backup,
        journal.previousPackageDigest,
        'transaction backup',
        journal.pluginId,
        journal.previousPackageReceiptIdentity ?? null,
      )
      if (target) {
        assertTransactionDigest(
          target,
          journal.packageDigest,
          'uncommitted install target',
          journal.pluginId,
          journal.packageReceiptIdentity ?? null,
        )
        assertStoreLockOwned(path.dirname(paths.transactionDir))
        fs.rmSync(paths.targetPlugin, { recursive: true, force: true })
        syncDirectory(path.dirname(paths.targetPlugin))
      }
      assertStoreLockOwned(path.dirname(paths.transactionDir))
      fs.renameSync(paths.backupPlugin, paths.targetPlugin)
      syncDirectory(path.dirname(paths.targetPlugin))
      syncDirectory(paths.backupRoot)
      return
    }

    if (journal.hadExisting) {
      assertTransactionDigest(
        target,
        journal.previousPackageDigest,
        'restored install target',
        journal.pluginId,
        journal.previousPackageReceiptIdentity ?? null,
      )
      return
    }
    if (target) {
      assertTransactionDigest(
        target,
        journal.packageDigest,
        'uncommitted install target',
        journal.pluginId,
        journal.packageReceiptIdentity ?? null,
      )
      assertStoreLockOwned(path.dirname(paths.transactionDir))
      fs.rmSync(paths.targetPlugin, { recursive: true, force: true })
      syncDirectory(path.dirname(paths.targetPlugin))
    }
    return
  }

  if (backup) {
    assertTransactionDigest(
      backup,
      journal.previousPackageDigest,
      'uncommitted uninstall backup',
      journal.pluginId,
      journal.previousPackageReceiptIdentity ?? null,
    )
    if (target) {
      throw transactionCorrupt(`uncommitted uninstall for ${journal.pluginId} has two targets`)
    }
    assertStoreLockOwned(path.dirname(paths.transactionDir))
    fs.renameSync(paths.backupPlugin, paths.targetPlugin)
    syncDirectory(path.dirname(paths.targetPlugin))
    syncDirectory(paths.backupRoot)
    return
  }
  assertTransactionDigest(
    target,
    journal.previousPackageDigest,
    'restored uninstall target',
    journal.pluginId,
    journal.previousPackageReceiptIdentity ?? null,
  )
}

function recoverTransactionDirectory(root, transactionRoot, entryName) {
  const transactionId = entryName.slice(3)
  if (entryName === LOCAL_PLUGIN_PACKAGE_STORE_LOCK_FILE || entryName.startsWith('stale-lock-')) return
  if (!entryName.startsWith('tx-') || !TRANSACTION_ID_RE.test(transactionId)) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_TRANSACTION_CORRUPT',
      `unexpected entry in plugin package transaction root: ${entryName}`,
      409,
    )
  }
  if (ACTIVE_TRANSACTIONS.has(transactionId)) return
  assertStoreLockOwned(transactionRoot)
  const transactionDir = path.join(transactionRoot, entryName)
  const stat = fs.lstatSync(transactionDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_TRANSACTION_CORRUPT',
      `plugin package transaction is not a real directory: ${entryName}`,
      409,
    )
  }
  const journalPath = path.join(transactionDir, 'transaction.json')
  if (!fs.existsSync(journalPath)) {
    safeRemoveTransactionDirectory(transactionDir, transactionRoot)
    return
  }
  const journal = readBoundedJson(
    journalPath,
    LOCAL_PLUGIN_PACKAGE_METADATA_LIMIT_BYTES,
    'PLUGIN_PACKAGE_TRANSACTION_CORRUPT',
  )
  const validatedJournal = validateTransactionJournal(journal, transactionId, entryName)
  const { pluginId } = validatedJournal
  const paths = transactionPaths(root, transactionRoot, transactionId, pluginId)
  if (fs.existsSync(paths.committedPath)) {
    const committedStat = fs.lstatSync(paths.committedPath)
    const committedValue = committedStat.isFile() && !committedStat.isSymbolicLink()
      ? fs.readFileSync(paths.committedPath, 'utf8')
      : ''
    if (committedValue !== 'committed\n') {
      throw packageStoreError(
        'PLUGIN_PACKAGE_TRANSACTION_CORRUPT',
        `plugin package commit marker is invalid: ${pluginId}`,
        409,
      )
    }
    if (journal.operation === 'install') {
      const installed = readTransactionPackage(paths.targetPlugin, 'committed install target', pluginId)
      assertTransactionDigest(
        installed,
        validatedJournal.packageDigest,
        'committed install target',
        pluginId,
        validatedJournal.packageReceiptIdentity ?? null,
      )
      const backup = readTransactionPackage(paths.backupPlugin, 'committed install backup', pluginId)
      if (backup) {
        if (!validatedJournal.hadExisting) {
          throw transactionCorrupt(`committed new install for ${pluginId} unexpectedly has a backup`)
        }
        assertTransactionDigest(
          backup,
          validatedJournal.previousPackageDigest,
          'committed install backup',
          pluginId,
          validatedJournal.previousPackageReceiptIdentity ?? null,
        )
      }
    }
    if (journal.operation === 'uninstall') {
      if (fs.existsSync(paths.targetPlugin)) {
        throw transactionCorrupt(`committed plugin uninstall still has its target: ${pluginId}`)
      }
      const backup = readTransactionPackage(paths.backupPlugin, 'committed uninstall backup', pluginId)
      if (backup) {
        assertTransactionDigest(
          backup,
          validatedJournal.previousPackageDigest,
          'committed uninstall backup',
          pluginId,
          validatedJournal.previousPackageReceiptIdentity ?? null,
        )
      }
    }
  } else {
    restoreUncommittedLocalPluginPackageTransaction(paths, validatedJournal)
  }
  assertStoreLockOwned(transactionRoot)
  safeRemoveTransactionDirectory(transactionDir, transactionRoot)
}

export function recoverLocalPluginPackageTransactionsLocked({ root, transactionRoot }) {
  assertStoreLockOwned(transactionRoot)
  const entries = fs.readdirSync(transactionRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) recoverTransactionDirectory(root, transactionRoot, entry.name)
  return true
}

export async function recoverLocalPluginPackageTransactions({ managedRoot }) {
  const paths = resolveStorePaths(managedRoot)
  return withStoreLock(paths, async () => recoverLocalPluginPackageTransactionsLocked(paths))
}

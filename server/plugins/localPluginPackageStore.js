import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import { loadPlugins } from './pluginLoader.js'
import {
  LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE,
  snapshotLocalPluginPackage,
} from './localPluginPackageSnapshot.js'

export const LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION = 1
export const LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION = 1
export const LOCAL_PLUGIN_PACKAGE_TRANSACTION_DIRNAME = '.gugo-plugin-package-transactions'

const RECEIPT_LIMIT_BYTES = 64 * 1024
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const SHA256_RE = /^sha256-[a-f0-9]{64}$/
const TRANSACTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ACTIVE_TRANSACTIONS = new Set()
const STORE_LOCK_CONTEXT = new AsyncLocalStorage()
const STORE_LOCK_FILE = 'store.lock'
const STORE_LOCK_OWNER_FILE = 'owner.json'
const STORE_LOCK_HEARTBEAT_MS = 5_000
const STORE_LOCK_STALE_MS = 30_000

function packageStoreError(code, message, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.retryable = false
  return error
}

function canonicalPath(target) {
  return fs.realpathSync.native?.(target) || fs.realpathSync(target)
}

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  )
}

function assertSafeDirectory(target, label, { create = false } = {}) {
  const resolved = path.resolve(target)
  if (path.dirname(resolved) === resolved) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_ROOT_INVALID',
      `${label} must not be a filesystem root`,
    )
  }
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
  let stat
  try {
    stat = fs.lstatSync(resolved)
  } catch (error) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_ROOT_INVALID',
      `${label} is unavailable: ${error?.message || error}`,
    )
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_ROOT_INVALID',
      `${label} must be a real directory, not a link or junction`,
    )
  }
  return canonicalPath(resolved)
}

function resolveStorePaths(managedRoot, { create = true } = {}) {
  const root = assertSafeDirectory(managedRoot, 'managed plugin root', { create })
  const parent = canonicalPath(path.dirname(root))
  const transactionRoot = assertSafeDirectory(
    path.join(parent, LOCAL_PLUGIN_PACKAGE_TRANSACTION_DIRNAME),
    'plugin package transaction root',
    { create },
  )
  if (isSameOrDescendant(root, transactionRoot) || isSameOrDescendant(transactionRoot, root)) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_ROOT_INVALID',
      'managed plugin root overlaps its transaction root',
    )
  }
  return { root, transactionRoot }
}

function validatePluginId(value, code = 'PLUGIN_PACKAGE_ID_INVALID') {
  const pluginId = String(value || '').trim()
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw packageStoreError(code, 'plugin package id is invalid')
  }
  return pluginId
}

function durableWrite(filePath, bytes, { exclusive = true } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const descriptor = fs.openSync(
    filePath,
    exclusive ? 'wx' : 'w',
    0o600,
  )
  try {
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function durableJson(filePath, value, options) {
  durableWrite(filePath, `${JSON.stringify(value)}\n`, options)
}

function syncDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES'].includes(error?.code)) throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function syncDirectoryTree(root) {
  const directories = []
  const walk = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw packageStoreError(
          'PLUGIN_PACKAGE_STAGE_INVALID',
          'staged plugin package unexpectedly contains a link',
        )
      }
      if (entry.isDirectory()) walk(path.join(directory, entry.name))
    }
    directories.push(directory)
  }
  walk(root)
  for (const directory of directories) syncDirectory(directory)
}

function sameFileMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function readBoundedJson(filePath, maxBytes, code) {
  let descriptor
  try {
    const before = fs.lstatSync(filePath)
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
      throw packageStoreError(code, 'required metadata is not a bounded regular file')
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0),
    )
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || !sameFileMetadata(before, opened)) {
      throw packageStoreError(code, 'required metadata changed before it could be read')
    }
    const chunks = []
    let totalBytes = 0
    while (true) {
      const remaining = maxBytes + 1 - totalBytes
      if (remaining <= 0) {
        throw packageStoreError(code, 'required metadata exceeds its size limit')
      }
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, remaining))
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      chunks.push(chunk.subarray(0, bytesRead))
    }
    if (totalBytes > maxBytes) {
      throw packageStoreError(code, 'required metadata exceeds its size limit')
    }
    const after = fs.fstatSync(descriptor)
    const current = fs.lstatSync(filePath)
    if (!sameFileMetadata(opened, after) || !sameFileMetadata(after, current)) {
      throw packageStoreError(code, 'required metadata changed while it was being read')
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes))
    const parsed = JSON.parse(text)
    if (`${JSON.stringify(parsed)}\n` !== text) {
      throw packageStoreError(code, 'required metadata is not canonical JSON')
    }
    return parsed
  } catch (error) {
    if (error?.code === code) throw error
    throw packageStoreError(code, `required metadata is missing: ${error?.message || error}`)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function publicReceipt(receipt) {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    pluginId: receipt.pluginId,
    pluginVersion: receipt.pluginVersion,
    packageDigest: receipt.packageDigest,
    fileCount: receipt.fileCount,
    totalBytes: receipt.totalBytes,
    installedAt: receipt.installedAt,
    publisherVerified: false,
    sourceKind: 'local-directory',
  })
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw packageStoreError('PLUGIN_PACKAGE_RECEIPT_INVALID', 'plugin package receipt is invalid')
  }
  const keys = Object.keys(receipt).sort()
  const expectedKeys = [
    'fileCount',
    'installedAt',
    'packageDigest',
    'pluginId',
    'pluginVersion',
    'publisherVerified',
    'schemaVersion',
    'sourceKind',
    'totalBytes',
  ].sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw packageStoreError('PLUGIN_PACKAGE_RECEIPT_INVALID', 'plugin package receipt fields are invalid')
  }
  validatePluginId(receipt.pluginId, 'PLUGIN_PACKAGE_RECEIPT_INVALID')
  if (
    receipt.schemaVersion !== LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION
    || typeof receipt.pluginVersion !== 'string'
    || !receipt.pluginVersion
    || receipt.pluginVersion.length > 128
    || !SHA256_RE.test(receipt.packageDigest)
    || !Number.isSafeInteger(receipt.fileCount)
    || receipt.fileCount < 1
    || !Number.isSafeInteger(receipt.totalBytes)
    || receipt.totalBytes < 1
    || !Number.isSafeInteger(receipt.installedAt)
    || receipt.installedAt < 0
    || receipt.publisherVerified !== false
    || receipt.sourceKind !== 'local-directory'
  ) {
    throw packageStoreError('PLUGIN_PACKAGE_RECEIPT_INVALID', 'plugin package receipt values are invalid')
  }
  return receipt
}

export function verifyInstalledLocalPluginPackage(packageDir) {
  const resolved = path.resolve(packageDir)
  const receipt = validateReceipt(readBoundedJson(
    path.join(resolved, LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE),
    RECEIPT_LIMIT_BYTES,
    'PLUGIN_PACKAGE_RECEIPT_INVALID',
  ))
  const snapshot = snapshotLocalPluginPackage(resolved, { receiptMode: 'exclude' })
  if (
    receipt.pluginId !== snapshot.manifest.id
    || receipt.pluginVersion !== snapshot.manifest.version
    || receipt.packageDigest !== snapshot.packageDigest
    || receipt.fileCount !== snapshot.fileCount
    || receipt.totalBytes !== snapshot.totalBytes
  ) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_CONTENT_MISMATCH',
      `installed plugin package ${receipt.pluginId} no longer matches its install receipt`,
      409,
    )
  }
  if (path.basename(canonicalPath(resolved)) !== receipt.pluginId) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_CONTENT_MISMATCH',
      'installed plugin package directory does not match its manifest id',
      409,
    )
  }
  return publicReceipt(receipt)
}

function revisionForPackages(packages) {
  const digest = createHash('sha256')
  digest.update('gugo-local-plugin-package-store-v1\0')
  for (const entry of packages) {
    digest.update(entry.pluginId)
    digest.update('\0')
    digest.update(entry.packageDigest)
    digest.update('\n')
  }
  return `sha256-${digest.digest('hex')}`
}

function safeRemoveTransactionDirectory(transactionDir, transactionRoot) {
  const resolved = path.resolve(transactionDir)
  if (!isSameOrDescendant(transactionRoot, resolved) || resolved === transactionRoot) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_TRANSACTION_CORRUPT',
      'refusing to remove a path outside the plugin package transaction root',
      409,
    )
  }
  fs.rmSync(resolved, { recursive: true, force: true })
  syncDirectory(transactionRoot)
}

function transactionPaths(root, transactionRoot, transactionId, pluginId) {
  const transactionDir = path.join(transactionRoot, `tx-${transactionId}`)
  return {
    transactionDir,
    journalPath: path.join(transactionDir, 'transaction.json'),
    committedPath: path.join(transactionDir, 'committed'),
    stageRoot: path.join(transactionDir, 'stage'),
    stagePlugin: path.join(transactionDir, 'stage', pluginId),
    backupRoot: path.join(transactionDir, 'backup'),
    backupPlugin: path.join(transactionDir, 'backup', pluginId),
    targetPlugin: path.join(root, pluginId),
  }
}

function lockPathFor(transactionRoot) {
  return path.join(transactionRoot, STORE_LOCK_FILE)
}

function lockOwnerPathFor(lockPath) {
  return path.join(lockPath, STORE_LOCK_OWNER_FILE)
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readStoreLock(lockPath) {
  let lockStat
  try {
    lockStat = fs.lstatSync(lockPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_LOCK_CORRUPT',
      'plugin package store lock is not a real directory',
      409,
    )
  }
  const ownerPath = lockOwnerPathFor(lockPath)
  if (!fs.existsSync(ownerPath)) return { owner: null, lockStat, ownerStat: null }
  const owner = readBoundedJson(
    ownerPath,
    RECEIPT_LIMIT_BYTES,
    'PLUGIN_PACKAGE_STORE_LOCK_CORRUPT',
  )
  const keys = Object.keys(owner || {}).sort()
  const expectedKeys = ['createdAt', 'pid', 'schemaVersion', 'token'].sort()
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    ||
    owner?.schemaVersion !== LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION
    || !TRANSACTION_ID_RE.test(String(owner.token || ''))
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
    || !Number.isSafeInteger(owner.createdAt)
    || owner.createdAt < 0
  ) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_LOCK_CORRUPT',
      'plugin package store lock owner is invalid',
      409,
    )
  }
  return { owner, lockStat, ownerStat: fs.lstatSync(ownerPath) }
}

function clearStaleStoreLock(lockPath, transactionRoot) {
  const lock = readStoreLock(lockPath)
  if (!lock) return true
  const context = STORE_LOCK_CONTEXT.getStore()
  if (
    lock.owner
    && context?.token === lock.owner.token
    && context?.transactionRoot === transactionRoot
  ) return false
  const heartbeatAge = Date.now() - (lock.ownerStat?.mtimeMs || lock.lockStat.mtimeMs)
  if (lock.owner && (processIsAlive(lock.owner.pid) || heartbeatAge < STORE_LOCK_STALE_MS)) {
    return false
  }
  if (!lock.owner && heartbeatAge < STORE_LOCK_STALE_MS) return false

  // The lock path remains occupied until this directory is removed. Removing
  // only its stale owner and then rmdir-ing it prevents a fresh lock from
  // appearing at the same path between stale detection and reclamation.
  try {
    const current = readStoreLock(lockPath)
    if (!current) return true
    if (lock.owner?.token !== current.owner?.token) return false
    if (current.owner && processIsAlive(current.owner.pid)) return false
    if (current.owner) fs.unlinkSync(lockOwnerPathFor(lockPath))
    syncDirectory(lockPath)
    fs.rmdirSync(lockPath)
    syncDirectory(transactionRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) return false
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_LOCK_CORRUPT',
      `stale plugin package store lock could not be reclaimed: ${error?.message || error}`,
      409,
    )
  }
  return true
}

function assertStoreLockOwned(transactionRoot) {
  const context = STORE_LOCK_CONTEXT.getStore()
  if (!context || context.transactionRoot !== transactionRoot) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_LOCK_REQUIRED',
      'plugin package store mutation requires its exclusive store lock',
      409,
    )
  }
  const current = readStoreLock(context.lockPath)
  if (!current?.owner || current.owner.token !== context.token) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_LOCK_LOST',
      'plugin package store lock ownership was lost',
      409,
    )
  }
  const descriptorStat = fs.fstatSync(context.descriptor)
  if (!sameFileMetadata(descriptorStat, current.ownerStat)) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_LOCK_LOST',
      'plugin package store lock owner was replaced',
      409,
    )
  }
}

function acquireStoreLock(paths) {
  const lockPath = lockPathFor(paths.transactionRoot)
  let descriptor
  let token
  for (let attempt = 0; attempt < 2; attempt += 1) {
    token = randomUUID()
    let createdLockDirectory = false
    let createdOwner = false
    try {
      fs.mkdirSync(lockPath, { recursive: false, mode: 0o700 })
      createdLockDirectory = true
      const ownerPath = lockOwnerPathFor(lockPath)
      descriptor = fs.openSync(ownerPath, 'wx+', 0o600)
      createdOwner = true
      const owner = {
        schemaVersion: LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION,
        token,
        pid: process.pid,
        createdAt: Date.now(),
      }
      fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`)
      fs.fsyncSync(descriptor)
      syncDirectory(lockPath)
      syncDirectory(paths.transactionRoot)
      break
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor)
        descriptor = undefined
      }
      if (createdLockDirectory) {
        try {
          if (createdOwner) fs.unlinkSync(lockOwnerPathFor(lockPath))
          fs.rmdirSync(lockPath)
          syncDirectory(paths.transactionRoot)
        } catch {
          // A partially-created lock stays fail-closed and is only eligible
          // for bounded stale recovery; never recursively delete this path.
        }
      }
      if (
        createdLockDirectory
        || error?.code !== 'EEXIST'
        || !clearStaleStoreLock(lockPath, paths.transactionRoot)
      ) {
        if (error?.code === 'EEXIST') {
          throw packageStoreError(
            'PLUGIN_PACKAGE_STORE_BUSY',
            'plugin package store is being changed by another operation',
            409,
          )
        }
        throw error
      }
    }
  }
  if (descriptor === undefined) {
    throw packageStoreError('PLUGIN_PACKAGE_STORE_BUSY', 'plugin package store lock is unavailable', 409)
  }

  const heartbeat = setInterval(() => {
    try {
      const current = readStoreLock(lockPath)
      if (current?.owner?.token === token) fs.futimesSync(descriptor, new Date(), new Date())
    } catch {
      // The held descriptor and token check remain authoritative. A later
      // release failure is surfaced rather than silently stealing the lock.
    }
  }, STORE_LOCK_HEARTBEAT_MS)
  heartbeat.unref?.()
  return Object.freeze({
    token,
    transactionRoot: paths.transactionRoot,
    lockPath,
    descriptor,
    heartbeat,
  })
}

function releaseStoreLock(context) {
  clearInterval(context.heartbeat)
  let current
  try {
    current = readStoreLock(context.lockPath)
  } catch (error) {
    fs.closeSync(context.descriptor)
    throw error
  }
  if (current?.owner?.token !== context.token) {
    fs.closeSync(context.descriptor)
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_LOCK_LOST',
      'plugin package store lock ownership was lost',
      409,
    )
  }
  const descriptorStat = fs.fstatSync(context.descriptor)
  if (!sameFileMetadata(descriptorStat, current.ownerStat)) {
    fs.closeSync(context.descriptor)
    throw packageStoreError(
      'PLUGIN_PACKAGE_STORE_LOCK_LOST',
      'plugin package store lock owner was replaced',
      409,
    )
  }
  fs.closeSync(context.descriptor)
  fs.unlinkSync(lockOwnerPathFor(context.lockPath))
  syncDirectory(context.lockPath)
  fs.rmdirSync(context.lockPath)
  syncDirectory(context.transactionRoot)
}

function throwStoreLockOutcome(operationError, releaseError) {
  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      'plugin package operation failed and its store lock could not be released',
      { cause: operationError },
    )
  }
  if (operationError) throw operationError
  if (releaseError) throw releaseError
}

async function withStoreLock(paths, operation) {
  const context = acquireStoreLock(paths)
  let result
  let operationError = null
  try {
    result = await STORE_LOCK_CONTEXT.run(
      context,
      operation,
    )
  } catch (error) {
    operationError = error
  }

  let releaseError = null
  try {
    releaseStoreLock(context)
  } catch (error) {
    releaseError = error
  }
  throwStoreLockOutcome(operationError, releaseError)
  return result
}

function withStoreLockSync(paths, operation) {
  const context = acquireStoreLock(paths)
  let result
  let operationError = null
  try {
    result = STORE_LOCK_CONTEXT.run(context, operation)
  } catch (error) {
    operationError = error
  }
  let releaseError = null
  try {
    releaseStoreLock(context)
  } catch (error) {
    releaseError = error
  }
  throwStoreLockOutcome(operationError, releaseError)
  return result
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

function assertTransactionDigest(receipt, expectedDigest, label, pluginId) {
  if (!receipt || receipt.packageDigest !== expectedDigest) {
    throw transactionCorrupt(`${label} digest does not match transaction ${pluginId}`)
  }
}

function validateTransactionJournal(journal, transactionId, entryName) {
  const pluginId = validatePluginId(journal?.pluginId, 'PLUGIN_PACKAGE_TRANSACTION_CORRUPT')
  const keys = Object.keys(journal || {}).sort()
  const expectedKeys = [
    'hadExisting',
    'operation',
    'packageDigest',
    'pluginId',
    'previousPackageDigest',
    'schemaVersion',
    'transactionId',
  ].sort()
  const commonInvalid = (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || journal.schemaVersion !== LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION
    || journal.transactionId !== transactionId
    || !['install', 'uninstall'].includes(journal.operation)
    || typeof journal.hadExisting !== 'boolean'
  )
  const digestInvalid = journal.operation === 'install'
    ? (
      !SHA256_RE.test(String(journal.packageDigest || ''))
      || (journal.hadExisting
        ? !SHA256_RE.test(String(journal.previousPackageDigest || ''))
        : journal.previousPackageDigest !== null)
    )
    : (
      journal.hadExisting !== true
      || journal.packageDigest !== null
      || !SHA256_RE.test(String(journal.previousPackageDigest || ''))
    )
  if (commonInvalid || digestInvalid) {
    throw transactionCorrupt(`plugin package transaction journal is invalid: ${entryName}`)
  }
  return { ...journal, pluginId }
}

function restoreUncommittedTransaction(paths, journal) {
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
      )
      if (target) {
        assertTransactionDigest(
          target,
          journal.packageDigest,
          'uncommitted install target',
          journal.pluginId,
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
      )
      return
    }
    if (target) {
      assertTransactionDigest(
        target,
        journal.packageDigest,
        'uncommitted install target',
        journal.pluginId,
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
  )
}

function recoverTransactionDirectory(root, transactionRoot, entryName) {
  const transactionId = entryName.slice(3)
  if (entryName === STORE_LOCK_FILE || entryName.startsWith('stale-lock-')) return
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
    RECEIPT_LIMIT_BYTES,
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
      assertTransactionDigest(installed, validatedJournal.packageDigest, 'committed install target', pluginId)
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
        )
      }
    }
  } else {
    restoreUncommittedTransaction(paths, validatedJournal)
  }
  assertStoreLockOwned(transactionRoot)
  safeRemoveTransactionDirectory(transactionDir, transactionRoot)
}

function recoverLocalPluginPackageTransactionsLocked({ root, transactionRoot }) {
  assertStoreLockOwned(transactionRoot)
  const entries = fs.readdirSync(transactionRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const entry of entries) {
    recoverTransactionDirectory(root, transactionRoot, entry.name)
  }
  return true
}

export async function recoverLocalPluginPackageTransactions({ managedRoot }) {
  const paths = resolveStorePaths(managedRoot)
  return withStoreLock(paths, async () => recoverLocalPluginPackageTransactionsLocked(paths))
}

function storeSnapshot(root) {
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
    revision: revisionForPackages(packages),
    packages: Object.freeze(packages),
  })
}

function discoveryError(dir, error) {
  return Object.freeze({
    dir,
    message: `managed plugin package verification failed [${error?.code || 'PLUGIN_PACKAGE_INVALID'}]: ${error?.message || error}`,
  })
}

/**
 * Startup-only synchronous discovery. Recovery, receipt verification, manifest
 * loading and the final digest check all occur under the package-store lock.
 */
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
    return storeSnapshot(paths.root)
  })
}

/**
 * Hold the cross-process package-store lock while a recovery verifier consumes
 * an exact, CAS-checked disk snapshot. The callback is intentionally not a
 * force-unlock primitive; it receives no filesystem paths or lock token.
 */
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
    const snapshot = storeSnapshot(paths.root)
    assertExpectedRevision(expectedRevision, snapshot.revision)
    assertStoreLockOwned(paths.transactionRoot)
    return operation(snapshot)
  })
}

/** Synchronous variant for the startup-only synchronous DistributionPort. */
export function listInstalledLocalPluginPackagesSync({ managedRoot }) {
  const paths = resolveStorePaths(managedRoot)
  return withStoreLockSync(paths, () => {
    recoverLocalPluginPackageTransactionsLocked(paths)
    return storeSnapshot(paths.root)
  })
}

function assertExpectedRevision(expectedRevision, actualRevision) {
  if (!SHA256_RE.test(String(expectedRevision || ''))) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_REVISION_REQUIRED',
      'a valid expected plugin package store revision is required',
      409,
    )
  }
  if (expectedRevision !== actualRevision) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_REVISION_CONFLICT',
      'plugin package store changed; refresh and retry',
      409,
    )
  }
}

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
}) {
  const transactionId = randomUUID()
  const paths = transactionPaths(root, transactionRoot, transactionId, pluginId)
  const journal = {
    schemaVersion: LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION,
    transactionId,
    operation,
    pluginId,
    hadExisting,
    packageDigest,
    previousPackageDigest,
  }
  ACTIVE_TRANSACTIONS.add(transactionId)
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
        restoreUncommittedTransaction(paths, journal)
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
    ACTIVE_TRANSACTIONS.delete(transactionId)
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
    const before = storeSnapshot(storePaths.root)
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
    const existing = before.packages.find((entry) => entry.pluginId === pluginId) || null
    if (existing?.packageDigest === snapshot.packageDigest) {
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
    const receipt = publicReceipt({
      schemaVersion: LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION,
      pluginId,
      pluginVersion: snapshot.manifest.version,
      packageDigest: snapshot.packageDigest,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      installedAt,
    })
    const transaction = await runMutationTransaction({
      operation: 'install',
      pluginId,
      root: storePaths.root,
      transactionRoot: storePaths.transactionRoot,
      hadExisting: Boolean(existing),
      packageDigest: snapshot.packageDigest,
      previousPackageDigest: existing?.packageDigest || null,
      prepareStage(paths) {
        copySnapshotToStage(snapshot, paths.stagePlugin)
        durableJson(path.join(paths.stagePlugin, LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE), receipt)
        validateStagedPlugin(paths.stageRoot, pluginId, snapshot.manifest.version)
        verifyInstalledLocalPluginPackage(paths.stagePlugin)
        syncDirectoryTree(paths.stagePlugin)
        syncDirectory(paths.stageRoot)
      },
    })
    const after = storeSnapshot(storePaths.root)
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
    const before = storeSnapshot(storePaths.root)
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
    })
    const after = storeSnapshot(storePaths.root)
    return Object.freeze({
      changed: true,
      operation: 'uninstalled',
      package: existing,
      store: after,
      cleanupDeferred: transaction.cleanupDeferred,
    })
  })
}

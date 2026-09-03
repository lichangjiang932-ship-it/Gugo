import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { readBoundedJson, sameFileMetadata } from './localPluginPackageMetadata.js'
import {
  LOCAL_PLUGIN_PACKAGE_METADATA_LIMIT_BYTES,
  LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION,
  packageStoreError,
  syncDirectory,
} from './localPluginPackageStoreSupport.js'

export const LOCAL_PLUGIN_PACKAGE_STORE_LOCK_FILE = 'store.lock'

const STORE_LOCK_CONTEXT = new AsyncLocalStorage()
const STORE_LOCK_OWNER_FILE = 'owner.json'
const STORE_LOCK_HEARTBEAT_MS = 5_000
const STORE_LOCK_STALE_MS = 30_000
const TRANSACTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function lockPathFor(transactionRoot) {
  return path.join(transactionRoot, LOCAL_PLUGIN_PACKAGE_STORE_LOCK_FILE)
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
  let owner
  try {
    owner = readBoundedJson(
      ownerPath,
      LOCAL_PLUGIN_PACKAGE_METADATA_LIMIT_BYTES,
      'PLUGIN_PACKAGE_STORE_LOCK_CORRUPT',
      { missingCode: 'PLUGIN_PACKAGE_STORE_LOCK_CHANGED' },
    )
  } catch (error) {
    if (error?.code === 'PLUGIN_PACKAGE_STORE_LOCK_CHANGED') {
      return { owner: null, lockStat, ownerStat: null, changed: true }
    }
    throw error
  }
  const keys = Object.keys(owner || {}).sort()
  const expectedKeys = ['createdAt', 'pid', 'schemaVersion', 'token'].sort()
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || owner?.schemaVersion !== LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION
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
  let ownerStat
  try {
    ownerStat = fs.lstatSync(ownerPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { owner: null, lockStat, ownerStat: null, changed: true }
    }
    throw error
  }
  return { owner, lockStat, ownerStat, changed: false }
}

function clearStaleStoreLock(lockPath, transactionRoot) {
  const lock = readStoreLock(lockPath)
  if (!lock) return true
  if (lock.changed) return false
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

  try {
    const current = readStoreLock(lockPath)
    if (!current) return true
    if (current.changed) return false
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

export function assertStoreLockOwned(transactionRoot) {
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
          // Partial locks stay fail-closed until bounded stale recovery.
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
      // The held descriptor and token check remain authoritative.
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

export async function withStoreLock(paths, operation) {
  const context = acquireStoreLock(paths)
  let result
  let operationError = null
  try {
    result = await STORE_LOCK_CONTEXT.run(context, operation)
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

export function withStoreLockSync(paths, operation) {
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

import fs from 'node:fs'
import path from 'node:path'

export const LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION = 1
export const LOCAL_PLUGIN_PACKAGE_TRANSACTION_DIRNAME = '.gugo-plugin-package-transactions'
export const LOCAL_PLUGIN_PACKAGE_METADATA_LIMIT_BYTES = 64 * 1024

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const SHA256_RE = /^sha256-[a-f0-9]{64}$/

export function packageStoreError(code, message, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.retryable = false
  return error
}

export function canonicalPath(target) {
  return fs.realpathSync.native?.(target) || fs.realpathSync(target)
}

export function isSameOrDescendant(parent, candidate) {
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

export function resolveStorePaths(managedRoot, { create = true } = {}) {
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

export function validatePluginId(value, code = 'PLUGIN_PACKAGE_ID_INVALID') {
  const pluginId = String(value || '').trim()
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw packageStoreError(code, 'plugin package id is invalid')
  }
  return pluginId
}

export function durableWrite(filePath, bytes, { exclusive = true } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const descriptor = fs.openSync(filePath, exclusive ? 'wx' : 'w', 0o600)
  try {
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

export function durableJson(filePath, value, options) {
  durableWrite(filePath, `${JSON.stringify(value)}\n`, options)
}

export function syncDirectory(directory) {
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

export function syncDirectoryTree(root) {
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

export function transactionPaths(root, transactionRoot, transactionId, pluginId) {
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

export function safeRemoveTransactionDirectory(transactionDir, transactionRoot) {
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

export function assertExpectedRevision(expectedRevision, actualRevision) {
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

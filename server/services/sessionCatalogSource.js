import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { SQLITE_SESSION_CATALOG_FINGERPRINT_STRATEGY } from '../core/sessionAdminPort.js'
import { validateRuntimeStoragePath } from '../utils/runtimeStoragePath.js'

const SOURCE_VERSION = 1
const ID_LENGTH = 24

function realpath(value) {
  return typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(value)
    : fs.realpathSync(value)
}

function canonicalPath(value) {
  const resolved = path.resolve(value)
  let existing = resolved
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return path.normalize(resolved)
    existing = parent
  }
  const canonicalBase = realpath(existing)
  return path.normalize(path.join(canonicalBase, path.relative(existing, resolved)))
}

function identityPath(value) {
  const normalized = canonicalPath(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function opaqueId(namespace, value) {
  const digest = createHash('sha256')
    .update(`${namespace}\0${identityPath(value)}`)
    .digest('hex')
    .slice(0, ID_LENGTH)
  return `${namespace}:${digest}`
}

function backendInstanceId(sessionAdmin, { cwd, env }) {
  const descriptor = Object.getOwnPropertyDescriptor(sessionAdmin || {}, 'catalogSource')
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
  const source = descriptor.value
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  if (source.fingerprintStrategy === SQLITE_SESSION_CATALOG_FINGERPRINT_STRATEGY) {
    if (source.backendType !== 'sqlite') return null
    const configuredDataDir = validateRuntimeStoragePath(env.APP_DATA_DIR, { key: 'APP_DATA_DIR' })
    const dataDir = path.resolve(cwd, configuredDataDir || 'server-data')
    const configuredDbPath = validateRuntimeStoragePath(env.APP_DB_PATH, { key: 'APP_DB_PATH' })
    const dbPath = path.resolve(cwd, configuredDbPath || path.join(dataDir, 'app.db'))
    return opaqueId('sqlite', dbPath)
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(source.backendType)
    || !/^[a-f0-9]{64}$/u.test(source.instanceFingerprint)) return null
  return `${source.backendType}:${source.instanceFingerprint.slice(0, ID_LENGTH)}`
}

export function describeSessionCatalogSource({
  cwd = process.cwd(),
  env = process.env,
  sessionAdmin = null,
} = {}) {
  const backendId = backendInstanceId(sessionAdmin, { cwd, env })
  if (!backendId) return null
  const configuredWorkspace = String(env.WORKSPACE_ROOT || '').trim()
  const workspacePath = canonicalPath(path.resolve(cwd, configuredWorkspace || cwd))

  return {
    version: SOURCE_VERSION,
    backendInstanceId: backendId,
    workspaceScope: {
      key: opaqueId('workspace', workspacePath),
      path: workspacePath,
    },
  }
}

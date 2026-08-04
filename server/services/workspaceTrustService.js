import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'

export const WORKSPACE_CONFIG_RELATIVE_PATH = '.gugo/config.json'
const MAX_CONFIG_BYTES = 64 * 1024
const CAPABILITIES = ['fileSystem', 'fileSystemWrite', 'shell', 'git', 'gitMutation']

function serviceError(message, statusCode = 400, code = 'WORKSPACE_TRUST_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function realPath(input) {
  // Match local-file authorization so Windows short/long aliases use the
  // same stable representation everywhere.
  return fs.realpathSync(input)
}

function samePath(left, right) {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function canonicalizeWorkspaceRoot(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw serviceError('workspace path is required', 400, 'WORKSPACE_PATH_REQUIRED')
  }
  if (!path.isAbsolute(rawPath.trim())) {
    throw serviceError('workspace path must be absolute', 400, 'WORKSPACE_PATH_ABSOLUTE_REQUIRED')
  }
  let canonical
  try {
    canonical = realPath(path.resolve(rawPath.trim()))
  } catch {
    throw serviceError('workspace path does not exist or is not accessible', 404, 'WORKSPACE_PATH_NOT_FOUND')
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw serviceError('workspace path must be a directory', 400, 'WORKSPACE_PATH_NOT_DIRECTORY')
  }
  return canonical
}

function globalCapabilities(env = getRuntimeEnv()) {
  const git = env.WORKSPACE_GIT_ENABLED === '1'
  const fileSystem = env.WORKSPACE_FS_ENABLED === '1'
  return {
    fileSystem,
    fileSystemWrite: fileSystem,
    shell: env.WORKSPACE_SHELL_ENABLED === '1',
    git,
    gitMutation: git && env.WORKSPACE_GIT_MUTATION_ENABLED === '1',
  }
}

function emptyWorkspaceLayer() {
  return Object.fromEntries(CAPABILITIES.map((key) => [key, true]))
}

function untrustedWorkspaceLayer() {
  return {
    fileSystem: true,
    fileSystemWrite: false,
    shell: false,
    git: false,
    gitMutation: false,
  }
}

function denyWorkspaceLayer() {
  return Object.fromEntries(CAPABILITIES.map((key) => [key, false]))
}

function validateWorkspaceConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('workspace config must be a JSON object', 400, 'WORKSPACE_CONFIG_INVALID')
  }
  const permissions = value.permissions ?? {}
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw serviceError('workspace config permissions must be an object', 400, 'WORKSPACE_CONFIG_INVALID')
  }
  const layer = emptyWorkspaceLayer()
  for (const [key, setting] of Object.entries(permissions)) {
    if (!CAPABILITIES.includes(key)) {
      throw serviceError(`unknown workspace permission: ${key}`, 400, 'WORKSPACE_CONFIG_INVALID')
    }
    if (typeof setting !== 'boolean') {
      throw serviceError(`workspace config permissions.${key} must be boolean`, 400, 'WORKSPACE_CONFIG_INVALID')
    }
    layer[key] = setting
  }
  if (!layer.fileSystem) layer.fileSystemWrite = false
  if (!layer.git) layer.gitMutation = false
  return layer
}

function readTrustedWorkspaceConfig(rootPath) {
  const configPath = path.join(rootPath, WORKSPACE_CONFIG_RELATIVE_PATH)
  if (!fs.existsSync(configPath)) {
    return { present: false, valid: true, path: configPath, permissions: emptyWorkspaceLayer(), error: null }
  }
  try {
    const stat = fs.statSync(configPath)
    if (!stat.isFile()) throw serviceError('workspace config is not a regular file', 400, 'WORKSPACE_CONFIG_INVALID')
    if (stat.size > MAX_CONFIG_BYTES) {
      throw serviceError(`workspace config exceeds ${MAX_CONFIG_BYTES} bytes`, 413, 'WORKSPACE_CONFIG_TOO_LARGE')
    }
    const canonicalConfigPath = realPath(configPath)
    if (!isInside(rootPath, canonicalConfigPath)) {
      throw serviceError('workspace config symlink escapes the trusted workspace', 403, 'WORKSPACE_CONFIG_ESCAPE')
    }
    const parsed = JSON.parse(fs.readFileSync(canonicalConfigPath, 'utf8'))
    return {
      present: true,
      valid: true,
      path: configPath,
      permissions: validateWorkspaceConfig(parsed),
      error: null,
    }
  } catch (error) {
    return {
      present: true,
      valid: false,
      path: configPath,
      permissions: denyWorkspaceLayer(),
      error: { code: error?.code || 'WORKSPACE_CONFIG_INVALID', message: error?.message || 'invalid workspace config' },
    }
  }
}

function getTrustRow(userId, rootPath) {
  if (!userId) return null
  return getDb().prepare(
    'SELECT user_id, root_path, created_at, updated_at FROM workspace_trust WHERE user_id = ? AND root_path = ?',
  ).get(userId, rootPath) || null
}

function isConfiguredSharedWorkspace(rootPath, env) {
  if (env.WORKSPACE_SHARED_TRUSTED !== '1') return false
  try {
    const configuredRoot = canonicalizeWorkspaceRoot(
      path.resolve(String(env.WORKSPACE_ROOT || '').trim() || process.cwd()),
    )
    return samePath(rootPath, configuredRoot)
  } catch {
    return false
  }
}

function findTrustRow(userId, rawPath) {
  if (!userId || typeof rawPath !== 'string' || !rawPath.trim()) return null
  const resolved = path.resolve(rawPath.trim())
  return getDb().prepare(
    'SELECT user_id, root_path, created_at, updated_at FROM workspace_trust WHERE user_id = ?',
  ).all(userId).find((row) => samePath(row.root_path, resolved)) || null
}

export function getWorkspaceTrustStatus({ userId, rootPath, env = getRuntimeEnv() }) {
  let canonical
  try {
    canonical = canonicalizeWorkspaceRoot(rootPath)
  } catch (error) {
    return {
      rootPath: path.resolve(String(rootPath || '.')),
      trusted: false,
      available: false,
      config: { present: null, valid: null, path: null, permissions: null, error: null },
      global: globalCapabilities(env),
      effective: denyWorkspaceLayer(),
      error: { code: error.code, message: error.message },
    }
  }
  const row = getTrustRow(userId, canonical)
  const sharedTrusted = isConfiguredSharedWorkspace(canonical, env)
  const trusted = !!row || sharedTrusted
  const config = trusted
    ? readTrustedWorkspaceConfig(canonical)
    : { present: null, valid: null, path: path.join(canonical, WORKSPACE_CONFIG_RELATIVE_PATH), permissions: null, error: null }
  const global = globalCapabilities(env)
  const workspace = config.permissions || untrustedWorkspaceLayer()
  const effective = {
    fileSystem: global.fileSystem && workspace.fileSystem,
    fileSystemWrite: global.fileSystemWrite && workspace.fileSystem && workspace.fileSystemWrite,
    shell: global.shell && workspace.shell,
    git: global.git && workspace.git,
    gitMutation: global.gitMutation && workspace.git && workspace.gitMutation,
  }
  return {
    rootPath: canonical,
    trusted,
    available: true,
    trustedAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
    config,
    global,
    effective,
  }
}

export function listWorkspaceTrust({ userId, env = getRuntimeEnv() }) {
  if (!userId) return []
  return getDb().prepare(
    'SELECT root_path FROM workspace_trust WHERE user_id = ? ORDER BY updated_at DESC',
  ).all(userId).map((row) => getWorkspaceTrustStatus({ userId, rootPath: row.root_path, env }))
}

export function setWorkspaceTrust({ userId, rootPath, trusted, confirmation, now = Date.now() }) {
  if (!userId) throw serviceError('userId is required', 400, 'USER_REQUIRED')
  if (!trusted) {
    const row = findTrustRow(userId, rootPath)
    if (!row) return false
    return getDb().prepare('DELETE FROM workspace_trust WHERE user_id = ? AND root_path = ?')
      .run(userId, row.root_path).changes > 0
  }
  if (confirmation !== 'TRUST_WORKSPACE_CONFIG') {
    throw serviceError('trusting workspace configuration requires explicit confirmation', 400, 'CONFIRMATION_REQUIRED')
  }
  const canonical = canonicalizeWorkspaceRoot(rootPath)
  getDb().prepare(`
    INSERT INTO workspace_trust (user_id, root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, root_path) DO UPDATE SET updated_at = excluded.updated_at
  `).run(userId, canonical, now, now)
  return getWorkspaceTrustStatus({ userId, rootPath: canonical })
}

export function assertWorkspaceCapability({ userId, rootPath, capability, env = getRuntimeEnv() }) {
  if (!CAPABILITIES.includes(capability)) {
    throw serviceError(`unknown workspace capability: ${capability}`, 500, 'WORKSPACE_CAPABILITY_UNKNOWN')
  }
  const status = getWorkspaceTrustStatus({ userId, rootPath, env })
  if (status.effective[capability]) return status
  const untrusted = !status.trusted && capability !== 'fileSystem'
  const error = serviceError(
    untrusted
      ? `workspace must be explicitly trusted before using capability: ${capability}`
      : `workspace capability is disabled: ${capability}`,
    403,
    untrusted ? 'WORKSPACE_NOT_TRUSTED' : 'WORKSPACE_CAPABILITY_DISABLED',
  )
  error.capability = capability
  error.rootPath = status.rootPath
  error.source = status.global[capability] ? 'workspace' : 'global'
  throw error
}

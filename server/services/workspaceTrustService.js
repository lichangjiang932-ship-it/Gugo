import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'

export const WORKSPACE_CONFIG_RELATIVE_PATH = '.gugo/config.json'
export const WORKSPACE_TRUST_SCOPES = Object.freeze({
  PERSISTENT: 'persistent',
  SESSION: 'session',
})
const MAX_CONFIG_BYTES = 64 * 1024
const CAPABILITIES = ['fileSystem', 'fileSystemWrite', 'shell', 'git', 'gitMutation']
const sessionTrustByUser = new Map()

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

function pathKey(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeTrustScope(scope = WORKSPACE_TRUST_SCOPES.PERSISTENT) {
  if (scope === WORKSPACE_TRUST_SCOPES.PERSISTENT || scope === WORKSPACE_TRUST_SCOPES.SESSION) return scope
  throw serviceError('workspace trust scope must be persistent or session', 400, 'WORKSPACE_TRUST_SCOPE_INVALID')
}

function nearestAncestor(rows, targetPath) {
  return rows
    .filter((row) => isInside(row.root_path, targetPath))
    .sort((left, right) => right.root_path.length - left.root_path.length)[0] || null
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

function findWorkspaceConfigRoot(rootPath, trustRootPath) {
  let current = rootPath
  while (isInside(trustRootPath, current)) {
    if (fs.existsSync(path.join(current, WORKSPACE_CONFIG_RELATIVE_PATH))) return current
    if (samePath(current, trustRootPath)) break
    const parent = path.dirname(current)
    if (samePath(parent, current)) break
    current = parent
  }
  return null
}

function readTrustedWorkspaceConfig(rootPath, { trustRootPath = rootPath } = {}) {
  const configRoot = findWorkspaceConfigRoot(rootPath, trustRootPath)
  const configPath = path.join(configRoot || rootPath, WORKSPACE_CONFIG_RELATIVE_PATH)
  if (!fs.existsSync(configPath)) {
    return {
      present: false,
      valid: true,
      loaded: false,
      blocked: false,
      path: configPath,
      sourceRoot: null,
      permissions: emptyWorkspaceLayer(),
      error: null,
      warning: null,
    }
  }
  try {
    const stat = fs.statSync(configPath)
    if (!stat.isFile()) throw serviceError('workspace config is not a regular file', 400, 'WORKSPACE_CONFIG_INVALID')
    if (stat.size > MAX_CONFIG_BYTES) {
      throw serviceError(`workspace config exceeds ${MAX_CONFIG_BYTES} bytes`, 413, 'WORKSPACE_CONFIG_TOO_LARGE')
    }
    const canonicalConfigPath = realPath(configPath)
    if (!isInside(configRoot, canonicalConfigPath)) {
      throw serviceError('workspace config symlink escapes the trusted workspace', 403, 'WORKSPACE_CONFIG_ESCAPE')
    }
    const parsed = JSON.parse(fs.readFileSync(canonicalConfigPath, 'utf8'))
    return {
      present: true,
      valid: true,
      loaded: true,
      blocked: false,
      path: configPath,
      sourceRoot: configRoot,
      permissions: validateWorkspaceConfig(parsed),
      error: null,
      warning: null,
    }
  } catch (error) {
    return {
      present: true,
      valid: false,
      loaded: false,
      blocked: false,
      path: configPath,
      sourceRoot: configRoot,
      permissions: denyWorkspaceLayer(),
      error: { code: error?.code || 'WORKSPACE_CONFIG_INVALID', message: error?.message || 'invalid workspace config' },
      warning: null,
    }
  }
}

function blockedWorkspaceConfig(rootPath) {
  const configPath = path.join(rootPath, WORKSPACE_CONFIG_RELATIVE_PATH)
  const blocked = fs.existsSync(configPath)
  return {
    present: null,
    valid: null,
    loaded: false,
    blocked,
    path: configPath,
    sourceRoot: null,
    permissions: null,
    error: null,
    warning: blocked
      ? 'workspace configuration was not loaded because this directory is not trusted'
      : null,
  }
}

function getPersistentTrustRows(userId) {
  if (!userId) return []
  return getDb().prepare(
    'SELECT user_id, root_path, created_at, updated_at FROM workspace_trust WHERE user_id = ?',
  ).all(userId).map((row) => ({ ...row, scope: WORKSPACE_TRUST_SCOPES.PERSISTENT }))
}

function getSessionTrustRows(userId) {
  return userId ? [...(sessionTrustByUser.get(userId)?.values() || [])] : []
}

function findEffectiveTrustRow(userId, rootPath) {
  return nearestAncestor([
    ...getPersistentTrustRows(userId),
    ...getSessionTrustRows(userId),
  ], rootPath)
}

function configuredSharedWorkspaceRoot(rootPath, env) {
  if (env.WORKSPACE_SHARED_TRUSTED !== '1') return null
  try {
    const configuredRoot = canonicalizeWorkspaceRoot(
      path.resolve(String(env.WORKSPACE_ROOT || '').trim() || process.cwd()),
    )
    return isInside(configuredRoot, rootPath) ? configuredRoot : null
  } catch {
    return null
  }
}

function resolveTrustRemovalPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null
  try {
    return canonicalizeWorkspaceRoot(rawPath)
  } catch {
    return path.resolve(rawPath.trim())
  }
}

function findExactPersistentTrustRow(userId, rawPath) {
  if (!userId || typeof rawPath !== 'string' || !rawPath.trim()) return null
  const resolved = resolveTrustRemovalPath(rawPath)
  return getPersistentTrustRows(userId).find((row) => samePath(row.root_path, resolved)) || null
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
      trustRootPath: null,
      trustScope: null,
      inherited: false,
      config: {
        present: null,
        valid: null,
        loaded: false,
        blocked: false,
        path: null,
        sourceRoot: null,
        permissions: null,
        error: null,
        warning: null,
      },
      global: globalCapabilities(env),
      effective: denyWorkspaceLayer(),
      error: { code: error.code, message: error.message },
    }
  }
  const row = findEffectiveTrustRow(userId, canonical)
  const sharedRoot = configuredSharedWorkspaceRoot(canonical, env)
  const trustRootPath = row?.root_path || sharedRoot
  const trusted = !!trustRootPath
  const config = trusted
    ? readTrustedWorkspaceConfig(canonical, { trustRootPath })
    : blockedWorkspaceConfig(canonical)
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
    trustRootPath: trustRootPath || null,
    trustScope: row?.scope || (sharedRoot ? 'shared' : null),
    inherited: !!trustRootPath && !samePath(trustRootPath, canonical),
    trustedAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
    config,
    global,
    effective,
  }
}

export function listWorkspaceTrust({ userId, env = getRuntimeEnv() }) {
  if (!userId) return []
  const seen = new Set()
  return [...getPersistentTrustRows(userId), ...getSessionTrustRows(userId)]
    .sort((left, right) => Number(right.updated_at) - Number(left.updated_at))
    .filter((row) => {
      const key = pathKey(row.root_path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((row) => getWorkspaceTrustStatus({ userId, rootPath: row.root_path, env }))
}

export function setWorkspaceTrust({
  userId,
  rootPath,
  trusted,
  confirmation,
  scope = WORKSPACE_TRUST_SCOPES.PERSISTENT,
  now = Date.now(),
}) {
  if (!userId) throw serviceError('userId is required', 400, 'USER_REQUIRED')
  const normalizedScope = normalizeTrustScope(scope)
  if (!trusted) {
    const resolved = resolveTrustRemovalPath(rootPath)
    if (!resolved) return false
    if (normalizedScope === WORKSPACE_TRUST_SCOPES.SESSION) {
      const grants = sessionTrustByUser.get(userId)
      const removed = grants?.delete(pathKey(resolved)) || false
      if (grants?.size === 0) sessionTrustByUser.delete(userId)
      return removed
    }
    const row = findExactPersistentTrustRow(userId, resolved)
    if (!row) return false
    return getDb().prepare('DELETE FROM workspace_trust WHERE user_id = ? AND root_path = ?')
      .run(userId, row.root_path).changes > 0
  }
  if (confirmation !== 'TRUST_WORKSPACE_CONFIG') {
    throw serviceError('trusting workspace configuration requires explicit confirmation', 400, 'CONFIRMATION_REQUIRED')
  }
  const canonical = canonicalizeWorkspaceRoot(rootPath)
  if (normalizedScope === WORKSPACE_TRUST_SCOPES.SESSION) {
    const persistent = findExactPersistentTrustRow(userId, canonical)
    if (persistent) return getWorkspaceTrustStatus({ userId, rootPath: canonical })
    let grants = sessionTrustByUser.get(userId)
    if (!grants) {
      grants = new Map()
      sessionTrustByUser.set(userId, grants)
    }
    const key = pathKey(canonical)
    const existing = grants.get(key)
    grants.set(key, {
      user_id: userId,
      root_path: canonical,
      created_at: existing?.created_at || now,
      updated_at: now,
      scope: WORKSPACE_TRUST_SCOPES.SESSION,
    })
    return getWorkspaceTrustStatus({ userId, rootPath: canonical })
  }
  getDb().prepare(`
    INSERT INTO workspace_trust (user_id, root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, root_path) DO UPDATE SET updated_at = excluded.updated_at
  `).run(userId, canonical, now, now)
  const sessionRows = sessionTrustByUser.get(userId)
  sessionRows?.delete(pathKey(canonical))
  if (sessionRows?.size === 0) sessionTrustByUser.delete(userId)
  return getWorkspaceTrustStatus({ userId, rootPath: canonical })
}

export function clearSessionWorkspaceTrust({ userId } = {}) {
  if (userId) return sessionTrustByUser.delete(userId)
  const hadEntries = sessionTrustByUser.size > 0
  sessionTrustByUser.clear()
  return hadEntries
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

import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db.js'
import { isApprovalBypassEnabled } from './approvalSettingsStore.js'
import { getWorkspaceTrustStatus, setWorkspaceTrust } from './workspaceTrustService.js'
import {
  LOCAL_FILE_GRANT_SCOPES,
  mapGrant,
} from './localFileGrantIdentity.js'
import {
  findAuthorizedDirectoryGrant as findAuthorizedDirectoryGrantWithDependencies,
  findAuthorizedDirectoryGrantByIdAndScope as findAuthorizedDirectoryGrantByIdAndScopeWithDependencies,
  isExistingLocalDirectory,
  resolveAuthorizedLocalPath as resolveAuthorizedLocalPathWithDependencies,
} from './localFileAccessAuthorization.js'
import {
  clearSessionLocalFileGrants,
  getGrantRows,
  getPersistentGrantRows,
  getSettingsRow,
  grantLocalPath,
  revokeLocalPath,
} from './localFileAccessGrantStore.js'
import {
  appDataRoot,
  assertPathWritable,
  isLocalCodeExecutionEnabled,
  isRunCodeExecutionEnabled,
  realPath,
  samePath,
  serviceError,
  sharedWorkspaceTrusted,
  stripPairedOuterQuotes,
  workspaceRoot,
} from './localFileAccessPathPolicy.js'

export {
  clearSessionLocalFileGrants,
  grantLocalPath,
  isExistingLocalDirectory,
  isLocalCodeExecutionEnabled,
  isRunCodeExecutionEnabled,
  LOCAL_FILE_GRANT_SCOPES,
  revokeLocalPath,
}

const MAX_DIRECTORY_BROWSER_ENTRIES = 500
const MAX_MANAGED_PROJECT_NAME_LENGTH = 80
const MANAGED_PROJECTS_DIRECTORY = 'Gugo Projects'
const DEFAULT_MANAGED_PROJECT_DIRECTORY = 'Default'
const turnProjectDirectoryContext = new AsyncLocalStorage()

export function getProjectDirectory({ userId } = {}) {
  const scoped = turnProjectDirectoryContext.getStore()
  if (scoped?.projectDirectory && (!userId || scoped.userId === userId)) {
    return scoped.projectDirectory
  }
  if (userId) {
    try {
      const grant = [...getGrantRows(userId)]
        .sort((left, right) => (
          (Number(right.updated_at) || 0) - (Number(left.updated_at) || 0)
          || (Number(right.created_at) || 0) - (Number(left.created_at) || 0)
        ))
        .find((row) => (
        row.resource_type === 'directory'
        && row.access_mode === 'read_write'
        && fs.existsSync(row.root_path)
        && getWorkspaceTrustStatus({ userId, rootPath: row.root_path }).trusted
        ))
      if (grant) return grant.root_path
    } catch {
      // Fall back to the deployment workspace below.
    }
  }
  return workspaceRoot()
}

function configuredOutputDirectory(userId) {
  if (!userId) return ''
  return String(getSettingsRow(userId)?.default_output_directory || '').trim()
}

function isolatedTestOutputDirectory() {
  if (!process.env.YMA_TEST_DATA_ROOT) return ''
  const configured = String(process.env.YMA_TEST_DEFAULT_OUTPUT_DIR || '').trim()
  return configured && path.isAbsolute(configured) ? path.normalize(configured) : ''
}

export function getDefaultOutputDirectory({ userId } = {}) {
  const scoped = turnProjectDirectoryContext.getStore()
  if (scoped?.defaultOutputDirectory && (!userId || scoped.userId === userId)) {
    return scoped.defaultOutputDirectory
  }
  return configuredOutputDirectory(userId)
    || isolatedTestOutputDirectory()
    || getProjectDirectory({ userId })
}

function managedProjectFolderName(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
    .slice(0, 48)
  if (!normalized) return 'project'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized)
    ? `project-${normalized}`
    : normalized
}

function managedProjectUserKey(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16)
}

function ensureFallbackDefaultProjectDirectory({
  userId,
  unavailableConfiguredPath = '',
  now = Date.now(),
} = {}) {
  const candidates = [
    workspaceRoot(),
    path.resolve(
      appDataRoot(),
      MANAGED_PROJECTS_DIRECTORY,
      managedProjectUserKey(userId),
      DEFAULT_MANAGED_PROJECT_DIRECTORY,
    ),
  ]
  let lastCause = null

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true })
      const canonicalProject = realPath(candidate)
      const projectStat = fs.statSync(canonicalProject)
      if (!projectStat.isDirectory()) throw new Error('fallback path is not a directory')
      assertPathWritable(canonicalProject, projectStat)

      // setDefaultOutputDirectory granted the old path when it was saved. It
      // is now unusable, so migrate that exact stale record before adding the
      // fallback. This also prevents a full 64-entry grant list from blocking
      // an ordinary chat solely because its former default disappeared.
      const staleGrant = unavailableConfiguredPath
        ? getPersistentGrantRows(userId).find((row) => (
            samePath(row.root_path, unavailableConfiguredPath)
            && !fs.existsSync(row.root_path)
          ))
        : null
      if (staleGrant && !samePath(staleGrant.root_path, canonicalProject)) {
        getDb().prepare('DELETE FROM local_file_grants WHERE id = ? AND user_id = ?')
          .run(staleGrant.id, userId)
      }

      // The fallback is created by Gugo and isolated to this local user. Give
      // normal permission mode the same workspace authority as an explicitly
      // created Gugo project; individual commands still use the inline gate.
      grantLocalPath({
        userId,
        rootPath: canonicalProject,
        accessMode: 'read_write',
        scope: LOCAL_FILE_GRANT_SCOPES.PERSISTENT,
        now,
      })
      setWorkspaceTrust({
        userId,
        rootPath: canonicalProject,
        trusted: true,
        confirmation: 'TRUST_WORKSPACE_CONFIG',
        scope: LOCAL_FILE_GRANT_SCOPES.PERSISTENT,
        now,
      })
      getDb().prepare(`
        INSERT INTO local_file_access_settings
          (user_id, all_files_enabled, default_output_directory, updated_at)
        VALUES (?, 0, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          default_output_directory = excluded.default_output_directory,
          updated_at = excluded.updated_at
      `).run(userId, canonicalProject, now)
      return canonicalProject
    } catch (cause) {
      lastCause = cause
    }
  }

  const error = serviceError(
    '历史默认目录已失效，且无法创建可写的 Gugo 默认项目目录',
    403,
    'DEFAULT_PROJECT_DIRECTORY_CREATE_FAILED',
  )
  error.cause = lastCause
  throw error
}

/**
 * Create an app-managed workspace when the user names a project without
 * choosing an existing source folder. Every directory is a unique leaf under
 * a user-isolated root, then receives the same persistent grant and trust
 * records as an explicitly selected workspace.
 */
export function createManagedProjectDirectory({ userId, name, now = Date.now() } = {}) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  const projectName = String(name || '').trim()
  if (!projectName) throw serviceError('项目名称必填', 400, 'PROJECT_NAME_REQUIRED')
  if (projectName.length > MAX_MANAGED_PROJECT_NAME_LENGTH) {
    throw serviceError(
      `项目名称最多 ${MAX_MANAGED_PROJECT_NAME_LENGTH} 个字符`,
      400,
      'PROJECT_NAME_TOO_LONG',
    )
  }

  const outputRoot = configuredOutputDirectory(userId) || appDataRoot()
  const managedRoot = path.resolve(
    outputRoot,
    MANAGED_PROJECTS_DIRECTORY,
    managedProjectUserKey(userId),
  )
  try {
    fs.mkdirSync(managedRoot, { recursive: true })
  } catch (cause) {
    throw serviceError(
      `无法创建默认项目目录（${cause?.code || 'CREATE_FAILED'}）`,
      403,
      'MANAGED_PROJECT_ROOT_CREATE_FAILED',
    )
  }

  const canonicalRoot = realPath(managedRoot)
  const rootStat = fs.statSync(canonicalRoot)
  if (!rootStat.isDirectory()) {
    throw serviceError('默认项目路径必须是目录', 400, 'MANAGED_PROJECT_ROOT_NOT_DIRECTORY')
  }
  assertPathWritable(canonicalRoot, rootStat)

  let projectPath = ''
  for (let attempt = 0; attempt < 8 && !projectPath; attempt += 1) {
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    const candidate = path.join(canonicalRoot, `${managedProjectFolderName(projectName)}-${suffix}`)
    try {
      fs.mkdirSync(candidate)
      projectPath = realPath(candidate)
    } catch (cause) {
      if (cause?.code !== 'EEXIST') {
        throw serviceError(
          `无法创建项目目录（${cause?.code || 'CREATE_FAILED'}）`,
          403,
          'MANAGED_PROJECT_DIRECTORY_CREATE_FAILED',
        )
      }
    }
  }
  if (!projectPath) {
    throw serviceError('无法生成唯一项目目录', 409, 'MANAGED_PROJECT_DIRECTORY_CONFLICT')
  }

  grantLocalPath({
    userId,
    rootPath: canonicalRoot,
    accessMode: 'read_write',
    scope: LOCAL_FILE_GRANT_SCOPES.PERSISTENT,
    now,
  })
  setWorkspaceTrust({
    userId,
    rootPath: canonicalRoot,
    trusted: true,
    confirmation: 'TRUST_WORKSPACE_CONFIG',
    scope: LOCAL_FILE_GRANT_SCOPES.PERSISTENT,
    now,
  })

  return { path: projectPath }
}

/**
 * Bind relative paths and output-directory prompt context to one Turn. The
 * AsyncLocalStorage boundary prevents concurrent sessions for the same user
 * from changing each other's effective project directory.
 */
export function withTurnProjectDirectory({
  userId,
  projectDirectory,
  defaultOutputDirectory = projectDirectory,
} = {}, operation) {
  if (typeof operation !== 'function') throw new TypeError('operation is required')
  const normalizedProjectDirectory = String(projectDirectory || '').trim()
  if (!normalizedProjectDirectory) return operation()
  return turnProjectDirectoryContext.run(Object.freeze({
    userId: userId || null,
    projectDirectory: path.normalize(normalizedProjectDirectory),
    defaultOutputDirectory: path.normalize(
      String(defaultOutputDirectory || normalizedProjectDirectory).trim(),
    ),
  }), operation)
}

/**
 * Resolve the effective directory before any Turn state is persisted. An
 * explicitly selected project must still be writable, authorized and trusted
 * at send time; an empty selection is pinned to the configured default (or
 * deployment workspace) so later grant activity cannot move the running Turn.
 */
export function resolveTurnProjectDirectory({ userId, workspacePath = '' } = {}) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  const selectedPath = stripPairedOuterQuotes(workspacePath)
  const configuredPath = configuredOutputDirectory(userId)
  let requestedPath = selectedPath
    || configuredPath
    || isolatedTestOutputDirectory()
    || workspaceRoot()
  if (!path.isAbsolute(requestedPath)) {
    throw serviceError('项目目录必须使用绝对路径', 400, 'TURN_WORKSPACE_PATH_ABSOLUTE_REQUIRED')
  }
  let canonicalPath
  try {
    canonicalPath = realPath(path.resolve(requestedPath))
  } catch {
    if (selectedPath || !configuredPath) {
      throw serviceError('项目目录不存在或无法访问', 404, 'TURN_WORKSPACE_PATH_NOT_FOUND')
    }
    // A saved default may point to a removed folder or a disconnected drive.
    // That stale preference must not prevent an ordinary chat from starting.
    requestedPath = ensureFallbackDefaultProjectDirectory({
      userId,
      unavailableConfiguredPath: configuredPath,
    })
    canonicalPath = realPath(requestedPath)
  }
  let stat = fs.statSync(canonicalPath)
  if (!stat.isDirectory()) {
    if (selectedPath || !configuredPath) {
      throw serviceError('项目路径必须是文件夹', 400, 'TURN_WORKSPACE_PATH_NOT_DIRECTORY')
    }
    requestedPath = ensureFallbackDefaultProjectDirectory({
      userId,
      unavailableConfiguredPath: configuredPath,
    })
    canonicalPath = realPath(requestedPath)
    stat = fs.statSync(canonicalPath)
  }
  if (selectedPath) {
    const grant = findAuthorizedDirectoryGrant({
      userId,
      rawPath: canonicalPath,
      accessMode: 'read_write',
    })
    if (!grant) {
      throw serviceError('所选项目目录尚未获得读写授权', 403, 'TURN_WORKSPACE_NOT_AUTHORIZED')
    }
    const trust = getWorkspaceTrustStatus({ userId, rootPath: canonicalPath })
    if (!trust.trusted) {
      throw serviceError('所选项目目录尚未设为可信工作区', 403, 'TURN_WORKSPACE_NOT_TRUSTED')
    }
    assertPathWritable(canonicalPath, stat)
  }
  return {
    workspacePath: selectedPath ? canonicalPath : null,
    projectDirectory: canonicalPath,
    defaultOutputDirectory: canonicalPath,
  }
}

export function resolveDirectoryRequestPath({ userId, rawPath = '' } = {}) {
  const input = stripPairedOuterQuotes(rawPath)
  if (!input) return getDefaultOutputDirectory({ userId })
  return path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(getProjectDirectory({ userId }), input)
}

export function getLocalFileAccessStatus({ userId }) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  const settings = getSettingsRow(userId)
  const grants = getGrantRows(userId).map(mapGrant)
  const workspaceEnabled = process.env.WORKSPACE_FS_ENABLED === '1'
  const root = workspaceEnabled ? workspaceRoot() : null
  const bypassEnabled = isApprovalBypassEnabled({ userId })
  return {
    allFilesEnabled: !!settings?.all_files_enabled,
    bypassEnabled,
    projectDirectory: getProjectDirectory({ userId }),
    defaultOutputDirectory: getDefaultOutputDirectory({ userId }),
    grants,
    workspace: {
      enabled: workspaceEnabled,
      path: root,
      sharedTrusted: workspaceEnabled && sharedWorkspaceTrusted(),
      requiresUserGrant: workspaceEnabled && !sharedWorkspaceTrusted(),
      trust: root ? getWorkspaceTrustStatus({ userId, rootPath: root }) : null,
    },
    // Return policy status for every authorized directory, including untrusted
    // ones, so the UI can show the actual read/write/shell/git boundary.
    trustedWorkspaces: grants
      .filter((grant) => grant.resourceType === 'directory')
      .map((grant) => getWorkspaceTrustStatus({ userId, rootPath: grant.path })),
    runtime: {
      platform: process.platform,
      pickerAvailable: ['win32', 'darwin', 'linux'].includes(process.platform),
      hostFileSystem: true,
      localCodeExecutionEnabled: isLocalCodeExecutionEnabled(),
      runCodeExecutionEnabled: isRunCodeExecutionEnabled(),
    },
  }
}

/**
 * Return the persisted directory grant that already satisfies a concrete
 * request_directory call. Explicit permission bypass is a user-selected
 * read/write authority, while the separate all-files toggle and exact-file
 * grants still do not grant shell/code execution authority.
 */
export function findAuthorizedDirectoryGrant({
  userId,
  rawPath,
  accessMode = 'read_only',
} = {}) {
  return findAuthorizedDirectoryGrantWithDependencies(
    { userId, rawPath, accessMode },
    { resolveDirectoryRequestPath },
  )
}

export function findAuthorizedDirectoryGrantByIdAndScope(options = {}) {
  return findAuthorizedDirectoryGrantByIdAndScopeWithDependencies(
    options,
    { resolveDirectoryRequestPath },
  )
}

export function setAllFilesAccess({ userId, enabled, confirmation, now = Date.now() }) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  if (enabled && confirmation !== 'ALLOW_ALL_LOCAL_FILES') {
    throw serviceError('开启全盘访问需要明确确认', 400, 'CONFIRMATION_REQUIRED')
  }
  getDb().prepare(`
    INSERT INTO local_file_access_settings (user_id, all_files_enabled, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      all_files_enabled = excluded.all_files_enabled,
      updated_at = excluded.updated_at
  `).run(userId, enabled ? 1 : 0, now)
  return getLocalFileAccessStatus({ userId })
}

export function setDefaultOutputDirectory({ userId, rootPath, now = Date.now() }) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  const requested = resolveDirectoryRequestPath({ userId, rawPath: rootPath })
  try {
    fs.mkdirSync(requested, { recursive: true })
  } catch (cause) {
    throw serviceError(
      `无法创建默认生成目录：${requested}（${cause?.code || 'CREATE_FAILED'}）`,
      403,
      'DEFAULT_OUTPUT_DIRECTORY_CREATE_FAILED',
    )
  }
  const canonicalPath = realPath(requested)
  const stat = fs.statSync(canonicalPath)
  if (!stat.isDirectory()) {
    throw serviceError('默认生成路径必须是目录', 400, 'DEFAULT_OUTPUT_DIRECTORY_NOT_DIRECTORY')
  }
  assertPathWritable(canonicalPath, stat)
  getDb().prepare(`
    INSERT INTO local_file_access_settings
      (user_id, all_files_enabled, default_output_directory, updated_at)
    VALUES (?, 0, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      default_output_directory = excluded.default_output_directory,
      updated_at = excluded.updated_at
  `).run(userId, canonicalPath, now)
  if (!isApprovalBypassEnabled({ userId })) {
    grantLocalPath({ userId, rootPath: canonicalPath, accessMode: 'read_write', now })
  }
  return getLocalFileAccessStatus({ userId })
}

function nearestExistingDirectory(rawPath) {
  let candidate = path.resolve(rawPath)
  while (!fs.existsSync(candidate) && candidate !== path.dirname(candidate)) {
    candidate = path.dirname(candidate)
  }
  if (!fs.existsSync(candidate)) return getProjectDirectory()
  const stat = fs.statSync(candidate)
  return stat.isDirectory() ? candidate : path.dirname(candidate)
}

export function browseLocalDirectories({ userId, rawPath = '' } = {}) {
  if (!userId) throw serviceError('userId 必填', 400, 'USER_REQUIRED')
  const requested = resolveDirectoryRequestPath({ userId, rawPath })
  let currentPath
  try {
    currentPath = realPath(nearestExistingDirectory(requested))
  } catch {
    throw serviceError('目录不存在或无法访问', 404, 'DIRECTORY_NOT_FOUND')
  }
  if (!fs.statSync(currentPath).isDirectory()) {
    throw serviceError('所选路径不是目录', 400, 'PATH_NOT_DIRECTORY')
  }

  const entries = []
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryPath = path.join(currentPath, entry.name)
    try {
      fs.accessSync(entryPath, fs.constants.R_OK)
      entries.push({ name: entry.name, path: entryPath })
    } catch {
      // Keep inaccessible directories out of the chooser instead of failing
      // the whole listing.
    }
    if (entries.length >= MAX_DIRECTORY_BROWSER_ENTRIES) break
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
  const rootPath = path.parse(currentPath).root
  return {
    currentPath,
    parentPath: samePath(currentPath, rootPath) ? null : path.dirname(currentPath),
    projectDirectory: getProjectDirectory({ userId }),
    defaultOutputDirectory: getDefaultOutputDirectory({ userId }),
    entries,
    truncated: entries.length >= MAX_DIRECTORY_BROWSER_ENTRIES,
  }
}

export function resolveAuthorizedLocalPath({
  userId,
  rawPath,
  write = false,
  allowMissing = false,
  allowWorkspace = process.env.WORKSPACE_FS_ENABLED === '1',
  allowAllFiles = true,
}) {
  return resolveAuthorizedLocalPathWithDependencies(
    { userId, rawPath, write, allowMissing, allowWorkspace, allowAllFiles },
    { getProjectDirectory },
  )
}

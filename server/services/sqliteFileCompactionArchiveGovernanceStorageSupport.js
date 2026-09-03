import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  resolveCompactionArchiveStorage,
  resolveCompactionArchiveUserStorage,
} from './compactionArchiveStore.js'
import {
  compactionGovernanceError,
  createCompactionGovernanceTerminalReceipt,
  isActiveCompactionGovernanceState,
  validateCompactionGovernanceManifest,
} from './sqliteFileCompactionArchiveGovernanceManifest.js'

export {
  compactionGovernanceError,
  compactionGovernancePayloadName,
} from './sqliteFileCompactionArchiveGovernanceManifest.js'

const GOVERNANCE_DIRECTORY = '.governance-v1'
const TERMINAL_GC_DIRECTORY = '.terminal-gc'
const MANIFEST_FILE = 'manifest.json'
const PAYLOAD_DIRECTORY = 'payload'
const TERMINAL_STATES = new Set(['committed', 'rolled_back'])
const SAFE_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const USER_TOKEN_PATTERN = /^[a-f0-9]{32}$/u
const OPERATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/u

function method(fileSystem, name) {
  const value = fileSystem?.[name] || fs[name]
  if (typeof value !== 'function') {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNAVAILABLE',
      `Filesystem operation ${name} is unavailable`,
    )
  }
  return value.bind(fileSystem?.[name] ? fileSystem : fs)
}

function exists(fileSystem, target) {
  return method(fileSystem, 'existsSync')(target)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function dataRoot(env) {
  return path.resolve(String(env.APP_DATA_DIR || path.join(process.cwd(), 'server-data')))
}

function insideOrSame(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function assertDirectory(fileSystem, root, candidate) {
  if (!insideOrSame(root, candidate)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
      'A compaction archive governance directory escaped APP_DATA_DIR',
    )
  }
  const stat = method(fileSystem, 'lstatSync')(candidate)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
      'A compaction archive governance directory is unsafe',
    )
  }
  const canonicalRoot = path.resolve(method(fileSystem, 'realpathSync')(root))
  const canonicalCandidate = path.resolve(method(fileSystem, 'realpathSync')(candidate))
  if (!insideOrSame(canonicalRoot, canonicalCandidate)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
      'A compaction archive governance directory escaped its canonical root',
    )
  }
}

function ensureDirectory(fileSystem, root, candidate, { recursive = false } = {}) {
  if (!exists(fileSystem, candidate)) {
    method(fileSystem, 'mkdirSync')(candidate, { recursive, mode: 0o700 })
  }
  assertDirectory(fileSystem, root, candidate)
}

function syncDirectory(fileSystem, directory) {
  let descriptor = null
  try {
    descriptor = method(fileSystem, 'openSync')(directory, 'r')
    method(fileSystem, 'fsyncSync')(descriptor)
  } catch {
    // Windows can reject directory handles; the manifest/file was fsynced first.
  } finally {
    if (descriptor !== null) {
      try { method(fileSystem, 'closeSync')(descriptor) } catch { /* best effort */ }
    }
  }
}

function userToken(userId) {
  return sha256(String(userId)).slice(0, 32)
}

function operationToken(userId, operationId) {
  return sha256(`${userId}\0${operationId}`)
}

function journalSchemaAvailable(db) {
  if (!db || typeof db.prepare !== 'function') return false
  const exists = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'user_data_clear_operations'
  `).get()
  if (!exists) return false
  const columns = new Set(db.prepare('PRAGMA table_info(user_data_clear_operations)')
    .all().map((column) => column.name))
  return [
    'operation_id',
    'owner_id',
    'status',
    'operation_kind',
    'session_id',
    'compaction_port_id',
    'compaction_governance_version',
    'compaction_digest',
    'compaction_stage_token',
  ].every((column) => columns.has(column))
}

function readBoundJournal(db, manifest) {
  const journal = db.prepare(`
    SELECT operation_id, owner_id, status, operation_kind, session_id,
           compaction_port_id, compaction_governance_version,
           compaction_digest, compaction_stage_token
    FROM user_data_clear_operations
    WHERE operation_id = ?
  `).get(manifest.operationId) || null
  if (!journal) return null
  const sessionDeletion = manifest.scope.kind === 'session'
  const expectedStatus = manifest.state === 'committed' ? 'database_committed' : 'staging'
  const consistent = journal.owner_id === manifest.userId
    && journal.status === expectedStatus
    && journal.operation_kind === (sessionDeletion ? 'session_delete' : 'user_clear')
    && journal.session_id === (sessionDeletion ? manifest.scope.sessionId : null)
    && journal.compaction_port_id === 'builtin.sqlite-file'
    && journal.compaction_governance_version === 1
    && journal.compaction_digest === manifest.digest
    && journal.compaction_stage_token === manifest.stageToken
  if (!consistent) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_JOURNAL_CONFLICT',
      'A terminal compaction archive receipt conflicts with its database journal',
    )
  }
  return journal
}

function storagePaths({ userId, operationId, env }) {
  const archive = resolveCompactionArchiveUserStorage({ userId, env })
  const root = dataRoot(env)
  const governanceRoot = path.join(archive.root, GOVERNANCE_DIRECTORY)
  const userRoot = path.join(governanceRoot, userToken(userId))
  const operationRoot = path.join(userRoot, operationToken(userId, operationId))
  for (const candidate of [archive.root, governanceRoot, userRoot, operationRoot]) {
    if (!insideOrSame(root, candidate)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
        'Compaction archive governance storage escaped APP_DATA_DIR',
      )
    }
  }
  return {
    archive,
    root,
    governanceRoot,
    userRoot,
    operationRoot,
    manifestPath: path.join(operationRoot, MANIFEST_FILE),
    payloadRoot: path.join(operationRoot, PAYLOAD_DIRECTORY),
  }
}

function ensureUserRoot(paths, fileSystem) {
  ensureDirectory(fileSystem, paths.root, paths.root, { recursive: true })
  for (const directory of [paths.archive.root, paths.governanceRoot, paths.userRoot]) {
    ensureDirectory(fileSystem, paths.root, directory)
  }
}

function writeManifest(paths, manifest, fileSystem, { create = false } = {}) {
  validateCompactionGovernanceManifest(manifest, {
    userId: manifest.userId,
    operationId: manifest.operationId,
    env: paths.env,
  })
  const temporaryPath = path.join(
    paths.operationRoot,
    `.${MANIFEST_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let descriptor = null
  try {
    descriptor = method(fileSystem, 'openSync')(
      temporaryPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    method(fileSystem, 'writeFileSync')(descriptor, `${JSON.stringify(manifest)}\n`, 'utf8')
    method(fileSystem, 'fsyncSync')(descriptor)
    method(fileSystem, 'closeSync')(descriptor)
    descriptor = null
    if (create && exists(fileSystem, paths.manifestPath)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CONFLICT',
        'A compaction archive deletion manifest already exists',
      )
    }
    method(fileSystem, 'renameSync')(temporaryPath, paths.manifestPath)
    syncDirectory(fileSystem, paths.operationRoot)
  } catch (cause) {
    if (descriptor !== null) {
      try { method(fileSystem, 'closeSync')(descriptor) } catch { /* preserve cause */ }
    }
    if (exists(fileSystem, temporaryPath)) {
      try { method(fileSystem, 'unlinkSync')(temporaryPath) } catch { /* swept manually */ }
    }
    if (cause?.code?.startsWith('COMPACTION_ARCHIVE_')) throw cause
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_WRITE_FAILED',
      'The compaction archive deletion manifest could not be persisted',
      cause,
    )
  }
}

function parseManifest(paths, userId, operationId, fileSystem) {
  let value
  try {
    value = JSON.parse(method(fileSystem, 'readFileSync')(paths.manifestPath, 'utf8'))
  } catch (cause) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'The compaction archive deletion manifest cannot be read',
      cause,
    )
  }
  return validateCompactionGovernanceManifest(value, {
    userId,
    operationId,
    env: paths.env,
  })
}

function readOperation({ userId, operationId, env, fileSystem }) {
  const paths = { ...storagePaths({ userId, operationId, env }), env }
  if (!exists(fileSystem, paths.operationRoot)) return { paths, manifest: null }
  assertDirectory(fileSystem, paths.root, paths.operationRoot)
  if (!exists(fileSystem, paths.manifestPath)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A compaction archive deletion fence has no manifest',
    )
  }
  return {
    paths,
    manifest: parseManifest(paths, userId, operationId, fileSystem),
  }
}

function conflict(left, { userId, sessionId }) {
  if (left.userId !== userId || !isActiveCompactionGovernanceState(left.state)) return false
  return left.scope.kind === 'user'
    || !sessionId
    || left.scope.sessionId === sessionId
}

function listUserManifests({ userId, env, fileSystem }) {
  const probe = storagePaths({ userId, operationId: 'probe', env })
  if (!exists(fileSystem, probe.userRoot)) return []
  assertDirectory(fileSystem, probe.root, probe.userRoot)
  const manifests = []
  for (const name of method(fileSystem, 'readdirSync')(probe.userRoot)) {
    const operationRoot = path.join(probe.userRoot, name)
    const stat = method(fileSystem, 'lstatSync')(operationRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'The compaction archive governance fence contains an unsafe entry',
      )
    }
    const manifestPath = path.join(operationRoot, MANIFEST_FILE)
    if (!exists(fileSystem, manifestPath)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_DELETION_IN_PROGRESS',
        'Compaction archives cannot change while a deletion fence is being established',
      )
    }
    let identity
    try {
      identity = JSON.parse(method(fileSystem, 'readFileSync')(manifestPath, 'utf8'))
    } catch (cause) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'The compaction archive deletion fence is unreadable',
        cause,
      )
    }
    if (name !== operationToken(userId, identity?.operationId)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'The compaction archive deletion fence identity is invalid',
      )
    }
    const paths = { ...storagePaths({ userId, operationId: identity.operationId, env }), env }
    manifests.push(parseManifest(paths, userId, identity.operationId, fileSystem))
  }
  return manifests
}

function listGovernanceContexts({ env, fileSystem }) {
  const probe = { ...storagePaths({ userId: 'probe', operationId: 'probe', env }), env }
  if (!exists(fileSystem, probe.governanceRoot)) return []
  assertDirectory(fileSystem, probe.root, probe.governanceRoot)
  const contexts = []
  for (const userName of method(fileSystem, 'readdirSync')(probe.governanceRoot)) {
    if (userName === TERMINAL_GC_DIRECTORY) continue
    if (!USER_TOKEN_PATTERN.test(userName)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'The compaction archive governance root contains an unknown entry',
      )
    }
    const userRoot = path.join(probe.governanceRoot, userName)
    assertDirectory(fileSystem, probe.root, userRoot)
    for (const operationName of method(fileSystem, 'readdirSync')(userRoot)) {
      if (!OPERATION_TOKEN_PATTERN.test(operationName)) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
          'The compaction archive governance user root contains an unknown entry',
        )
      }
      const operationRoot = path.join(userRoot, operationName)
      assertDirectory(fileSystem, probe.root, operationRoot)
      const manifestPath = path.join(operationRoot, MANIFEST_FILE)
      if (!exists(fileSystem, manifestPath)) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_DELETION_IN_PROGRESS',
          'Compaction archive governance recovery evidence is incomplete',
        )
      }
      let identity
      try {
        identity = JSON.parse(method(fileSystem, 'readFileSync')(manifestPath, 'utf8'))
      } catch (cause) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
          'A compaction archive governance manifest is unreadable',
          cause,
        )
      }
      if (userName !== userToken(identity?.userId)
        || operationName !== operationToken(identity?.userId, identity?.operationId)) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
          'A compaction archive governance directory is not bound to its manifest',
        )
      }
      const paths = {
        ...storagePaths({
          userId: identity.userId,
          operationId: identity.operationId,
          env,
        }),
        env,
      }
      contexts.push({
        paths,
        manifest: parseManifest(paths, identity.userId, identity.operationId, fileSystem),
      })
    }
  }
  return contexts
}

function verifyRegularFile(fileSystem, fullPath, expected) {
  const stat = method(fileSystem, 'lstatSync')(fullPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.sizeBytes) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
      'A compaction archive deletion file is no longer a verified regular file',
    )
  }
  const bytes = method(fileSystem, 'readFileSync')(fullPath)
  if (bytes.length !== expected.sizeBytes || sha256(bytes) !== expected.sha256) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
      'A compaction archive deletion file failed integrity verification',
    )
  }
}

function resolveOrphanStorage(context, file) {
  const owner = resolveCompactionArchiveUserStorage({
    userId: context.manifest.userId,
    env: context.paths.env,
  })
  const fileName = path.posix.basename(file.storagePath)
  const expected = path.posix.join('v1', owner.bucket, fileName)
  const fullPath = path.resolve(owner.root, ...file.storagePath.split('/'))
  if (file.storagePath !== expected
    || file.storagePath.includes('\\')
    || path.dirname(fullPath) !== path.resolve(owner.bucketPath)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
      'A compaction archive orphan is outside managed storage',
    )
  }
  return { ...owner, storagePath: file.storagePath, fullPath }
}

function resolvedFiles(context, fileSystem) {
  return context.manifest.files.map((file) => {
    let source
    try {
      source = file.kind === 'orphan'
        ? resolveOrphanStorage(context, file)
        : resolveCompactionArchiveStorage({
          userId: context.manifest.userId,
          id: file.id,
          storagePath: file.storagePath,
          env: context.paths.env,
        })
    } catch (cause) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'A compaction archive deletion file is outside managed storage',
        cause,
      )
    }
    assertDirectory(fileSystem, context.paths.root, source.bucketPath)
    const stagedPath = path.resolve(context.paths.payloadRoot, file.payloadName)
    if (path.dirname(stagedPath) !== path.resolve(context.paths.payloadRoot)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'A compaction archive deletion payload escaped its operation',
      )
    }
    return { file, source, stagedPath }
  })
}

function updateContext(context, state, fileSystem, now) {
  const terminalReceipt = TERMINAL_STATES.has(state)
    ? createCompactionGovernanceTerminalReceipt(context.manifest, state, now())
    : null
  const manifest = { ...context.manifest, state, terminalReceipt }
  writeManifest(context.paths, manifest, fileSystem)
  context.manifest = manifest
  return context
}

function assertTerminalStorage(context, fileSystem) {
  const entries = resolvedFiles(context, fileSystem)
  for (const entry of entries) {
    const sourceExists = exists(fileSystem, entry.source.fullPath)
    const stagedExists = exists(fileSystem, entry.stagedPath)
    if (stagedExists || (context.manifest.state === 'committed' && sourceExists)
      || (context.manifest.state === 'rolled_back' && !sourceExists)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_TERMINAL_CONFLICT',
        'A terminal compaction archive receipt conflicts with managed storage',
      )
    }
    if (context.manifest.state === 'rolled_back') {
      verifyRegularFile(fileSystem, entry.source.fullPath, entry.file)
    }
  }
  if (exists(fileSystem, context.paths.payloadRoot)) {
    assertDirectory(fileSystem, context.paths.root, context.paths.payloadRoot)
    if (method(fileSystem, 'readdirSync')(context.paths.payloadRoot).length !== 0) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_TERMINAL_CONFLICT',
        'A terminal compaction archive receipt still contains staged payloads',
      )
    }
  }
}

function removeTerminalContext(context, fileSystem) {
  const names = method(fileSystem, 'readdirSync')(context.paths.operationRoot).sort()
  const allowed = exists(fileSystem, context.paths.payloadRoot)
    ? [MANIFEST_FILE, PAYLOAD_DIRECTORY].sort()
    : [MANIFEST_FILE]
  if (JSON.stringify(names) !== JSON.stringify(allowed)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_TERMINAL_CONFLICT',
      'A terminal compaction archive receipt directory contains unknown entries',
    )
  }
  const gcRoot = path.join(context.paths.governanceRoot, TERMINAL_GC_DIRECTORY)
  ensureDirectory(fileSystem, context.paths.root, gcRoot)
  const quarantine = path.join(
    gcRoot,
    `${userToken(context.manifest.userId)}-${operationToken(
      context.manifest.userId,
      context.manifest.operationId,
    )}`,
  )
  if (exists(fileSystem, quarantine)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_TERMINAL_CONFLICT',
      'A terminal compaction archive receipt already has a GC quarantine',
    )
  }
  method(fileSystem, 'renameSync')(context.paths.operationRoot, quarantine)
  syncDirectory(fileSystem, context.paths.userRoot)
  syncDirectory(fileSystem, gcRoot)
  const quarantinedPayload = path.join(quarantine, PAYLOAD_DIRECTORY)
  if (exists(fileSystem, quarantinedPayload)) method(fileSystem, 'rmdirSync')(quarantinedPayload)
  method(fileSystem, 'unlinkSync')(path.join(quarantine, MANIFEST_FILE))
  method(fileSystem, 'rmdirSync')(quarantine)
  syncDirectory(fileSystem, gcRoot)
}

function assertReceipt(context, input) {
  if (!context.manifest
    || context.manifest.stageToken !== input.stageToken
    || context.manifest.digest !== input.digest) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
      'The compaction archive deletion stage is stale',
    )
  }
}
export {
  SAFE_TERMINAL_RETENTION_MS,
  TERMINAL_STATES,
  assertDirectory,
  assertReceipt,
  assertTerminalStorage,
  conflict,
  ensureUserRoot,
  exists,
  journalSchemaAvailable,
  listGovernanceContexts,
  listUserManifests,
  method,
  readBoundJournal,
  readOperation,
  removeTerminalContext,
  resolvedFiles,
  storagePaths,
  syncDirectory,
  updateContext,
  verifyRegularFile,
  writeManifest,
}

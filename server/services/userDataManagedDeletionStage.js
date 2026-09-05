import fs from 'node:fs'
import path from 'node:path'
import {
  assertUserDataFileSnapshot,
  captureUserDataFileSnapshot,
} from './userDataFileSnapshot.js'
import {
  assertSafeEntry,
  enumerateDirectoryFiles,
  fileSystemMethod,
  isInside,
  managedError,
  normalizeRelative,
  pathExists,
  storageToken,
} from './userDataManagedFileCatalogSupport.js'

const STAGING_FORMAT = 'gugo-user-data-clear-staging'
const STAGING_VERSION = 1
const STAGING_MANIFEST = 'manifest.json'
const STAGING_MANIFEST_TEMP = 'manifest.tmp'
const STAGING_PAYLOAD = 'payload'
const MAX_STAGING_ENTRIES = 100_000

function manifestEntry(root, entry) {
  const relative = normalizeRelative(root, entry.fullPath, entry.code, entry.message)
  return {
    kind: entry.kind,
    id: String(entry.id),
    relativePath: relative.split(path.sep).join('/'),
    type: entry.type,
    expectedPresent: entry.expectedPresent !== false,
  }
}

function manifestPath(stagePath) {
  return path.join(stagePath, STAGING_MANIFEST)
}

function payloadPath(stagePath) {
  return path.join(stagePath, STAGING_PAYLOAD)
}

function relativeFsPath(value) {
  const normalized = String(value || '')
  if (!normalized || normalized.includes('\\') || path.posix.isAbsolute(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return path.join(...parts)
}

function ensureSafeParentDirectory({ root, fullPath, code, message, fileSystem = fs }) {
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(fullPath)
  normalizeRelative(resolvedRoot, resolvedPath, code, message)
  try {
    const rootStat = fileSystemMethod(fileSystem, 'lstatSync')(resolvedRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw managedError(code, message)
    const realRoot = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(resolvedRoot))
    const parent = path.dirname(resolvedPath)
    const parts = path.relative(resolvedRoot, parent).split(path.sep).filter(Boolean)
    let cursor = resolvedRoot
    for (const part of parts) {
      cursor = path.join(cursor, part)
      if (!pathExists(fileSystem, cursor)) {
        fileSystemMethod(fileSystem, 'mkdirSync')(cursor, { recursive: false })
      }
      const stat = fileSystemMethod(fileSystem, 'lstatSync')(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw managedError(code, message)
      const realCursor = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(cursor))
      if (realCursor !== realRoot && !isInside(realRoot, realCursor)) throw managedError(code, message)
    }
    return parent
  } catch (error) {
    if (error?.code === code) throw error
    throw managedError(code, message, 500, error, { incomplete: true })
  }
}

function assertSafeStageDirectory({ root, stagePath, fileSystem = fs }) {
  if (!pathExists(fileSystem, stagePath)) return false
  assertSafeEntry({
    root,
    fullPath: stagePath,
    expectedType: 'directory',
    code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
    message: 'A user-data clear staging path is unsafe',
    fileSystem,
  })
  return true
}

function readStageManifest({ root, stagePath, domain, operationId, userId, fileSystem = fs }) {
  if (!assertSafeStageDirectory({ root, stagePath, fileSystem })) return null
  const target = manifestPath(stagePath)
  if (!pathExists(fileSystem, target)) {
    const entries = fileSystemMethod(fileSystem, 'readdirSync')(stagePath)
    const payload = payloadPath(stagePath)
    const allowed = new Set([STAGING_PAYLOAD, STAGING_MANIFEST_TEMP])
    if (entries.every((name) => allowed.has(name))) {
      if (pathExists(fileSystem, payload)) {
        assertSafeEntry({
          root: stagePath,
          fullPath: payload,
          expectedType: 'directory',
          code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
          message: 'A user-data clear staging payload is unsafe',
          fileSystem,
        })
      }
      const temporary = path.join(stagePath, STAGING_MANIFEST_TEMP)
      if (pathExists(fileSystem, temporary)) {
        assertSafeEntry({
          root: stagePath,
          fullPath: temporary,
          expectedType: 'file',
          code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
          message: 'A user-data clear temporary manifest is unsafe',
          fileSystem,
        })
      }
      const payloadEmpty = !pathExists(fileSystem, payload)
        || fileSystemMethod(fileSystem, 'readdirSync')(payload).length === 0
      if (payloadEmpty) return { empty: true, entries: [] }
    }
    throw managedError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging manifest is missing',
      500,
      null,
      { incomplete: true },
    )
  }
  assertSafeEntry({
    root: stagePath,
    fullPath: target,
    expectedType: 'file',
    code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
    message: 'A user-data clear staging manifest is unsafe',
    fileSystem,
  })
  let parsed
  try {
    parsed = JSON.parse(fileSystemMethod(fileSystem, 'readFileSync')(target, 'utf8'))
  } catch (cause) {
    throw managedError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging manifest is unreadable',
      500,
      cause,
      { incomplete: true },
    )
  }
  if (parsed?.format !== STAGING_FORMAT
    || parsed?.version !== STAGING_VERSION
    || parsed?.domain !== domain
    || parsed?.operationId !== operationId
    || parsed?.userToken !== storageToken(userId, 32)
    || !Array.isArray(parsed?.entries)
    || parsed.entries.length > MAX_STAGING_ENTRIES) {
    throw managedError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging manifest is invalid',
      500,
      null,
      { incomplete: true },
    )
  }
  const seen = new Set()
  const entries = parsed.entries.map((entry) => {
    const relativePath = relativeFsPath(entry?.relativePath)
    if (!relativePath
      || !['file', 'directory'].includes(entry?.type)
      || (entry?.expectedPresent !== undefined && typeof entry.expectedPresent !== 'boolean')
      || seen.has(entry.relativePath)) {
      throw managedError(
        'USER_DATA_CLEAR_JOURNAL_INVALID',
        'A user-data clear staging entry is invalid',
        500,
        null,
        { incomplete: true },
      )
    }
    seen.add(entry.relativePath)
    const activePath = path.resolve(root, relativePath)
    const stagedPath = path.resolve(payloadPath(stagePath), relativePath)
    if (!isInside(path.resolve(root), activePath)
      || !isInside(path.resolve(payloadPath(stagePath)), stagedPath)) {
      throw managedError(
        'USER_DATA_CLEAR_JOURNAL_INVALID',
        'A user-data clear staging entry escaped its managed root',
        500,
        null,
        { incomplete: true },
      )
    }
    return {
      ...entry,
      expectedPresent: entry.expectedPresent !== false,
      relativePath,
      activePath,
      stagedPath,
    }
  })
  return { ...parsed, entries }
}

function removeTree(fileSystem, target) {
  if (pathExists(fileSystem, target)) {
    fileSystemMethod(fileSystem, 'rmSync')(target, { recursive: true, force: true })
  }
}

function createManagedStageControls({
  resolvedRoot,
  stagePath,
  domain,
  entries,
  movedEntries,
  expectedSnapshot,
  fileSystem,
}) {
  const snapshotSelections = (sourceEntries, staged = false) => sourceEntries.map((entry) => ({
    fullPath: staged ? entry.stagedPath : entry.fullPath,
    type: entry.type,
    logicalPath: path.relative(
      resolvedRoot,
      staged ? entry.activePath : entry.fullPath,
    ).split(path.sep).join('/'),
  }))
  const capture = (sourceEntries, staged) => captureUserDataFileSnapshot({
    root: staged ? payloadPath(stagePath) : resolvedRoot,
    selections: snapshotSelections(sourceEntries, staged),
    namespace: domain,
    fileSystem,
    code: 'USER_DATA_CLEAR_PREVIEW_CHANGED',
    message: staged
      ? 'Managed local files changed while they were being staged'
      : 'Managed local files changed after the impact preview',
  })
  const assertStable = () => {
    if (!expectedSnapshot) return true
    if (entries.some((entry) => pathExists(fileSystem, entry.fullPath))) {
      throw managedError(
        'USER_DATA_CLEAR_PREVIEW_CHANGED',
        'Managed local files changed while they were being staged',
        409,
        null,
        { incomplete: false, databaseCleared: false, cleanupPending: false },
      )
    }
    assertUserDataFileSnapshot(expectedSnapshot, capture(movedEntries, true))
    return true
  }
  const rollback = () => {
    for (const entry of [...movedEntries].reverse()) {
      if (!pathExists(fileSystem, entry.stagedPath)) continue
      if (pathExists(fileSystem, entry.activePath)) {
        throw managedError(
          'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
          'A managed file could not be restored after a failed clear',
          500,
          null,
          { incomplete: true, databaseCleared: false },
        )
      }
      ensureSafeParentDirectory({
        root: resolvedRoot,
        fullPath: entry.activePath,
        code: 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        message: 'A managed file restore destination is unsafe',
        fileSystem,
      })
      fileSystemMethod(fileSystem, 'renameSync')(entry.stagedPath, entry.activePath)
    }
    removeTree(fileSystem, stagePath)
    return true
  }
  return {
    assertStable,
    rollback,
    captureActiveSnapshot: () => capture(entries, false),
  }
}

function initializeManagedDeletionStage({
  resolvedRoot,
  stagePath,
  domain,
  operationId,
  userId,
  serializedEntries,
  fileSystem,
}) {
  fileSystemMethod(fileSystem, 'mkdirSync')(resolvedRoot, { recursive: true })
  ensureSafeParentDirectory({
    root: resolvedRoot,
    fullPath: stagePath,
    code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
    message: 'A user-data clear staging destination is unsafe',
    fileSystem,
  })
  fileSystemMethod(fileSystem, 'mkdirSync')(stagePath, { recursive: false })
  fileSystemMethod(fileSystem, 'mkdirSync')(payloadPath(stagePath), { recursive: false })
  const temporaryManifest = path.join(stagePath, STAGING_MANIFEST_TEMP)
  fileSystemMethod(fileSystem, 'writeFileSync')(temporaryManifest, JSON.stringify({
    format: STAGING_FORMAT,
    version: STAGING_VERSION,
    domain,
    operationId,
    userToken: storageToken(userId, 32),
    entries: serializedEntries,
  }), { flag: 'wx', mode: 0o600 })
  fileSystemMethod(fileSystem, 'renameSync')(temporaryManifest, manifestPath(stagePath))
}

export function stageManagedDeletionDomain({
  root,
  stagePath,
  domain,
  entries,
  operationId,
  userId,
  expectedSnapshot = null,
  fileSystem = fs,
} = {}) {
  if (!entries?.length) {
    if (expectedSnapshot?.entries?.length) {
      throw managedError(
        'USER_DATA_CLEAR_PREVIEW_CHANGED',
        'Managed local files changed after the impact preview',
        409,
        null,
        { incomplete: false, databaseCleared: false, cleanupPending: false },
      )
    }
    return {
      movedEntries: [],
      cleanup: () => true,
      rollback: () => true,
      assertStable: () => true,
    }
  }
  const resolvedRoot = path.resolve(root)
  normalizeRelative(
    resolvedRoot,
    stagePath,
    'USER_DATA_CLEAR_JOURNAL_INVALID',
    'A user-data clear staging path escaped its managed root',
  )
  if (pathExists(fileSystem, stagePath)) {
    throw managedError(
      'USER_DATA_CLEAR_JOURNAL_CONFLICT',
      'A user-data clear staging path already exists',
      500,
      null,
      { incomplete: true, databaseCleared: false },
    )
  }
  const serializedEntries = entries.map((entry) => manifestEntry(resolvedRoot, entry))
  const movedEntries = []
  const {
    assertStable,
    rollback,
    captureActiveSnapshot,
  } = createManagedStageControls({
    resolvedRoot,
    stagePath,
    domain,
    entries,
    movedEntries,
    expectedSnapshot,
    fileSystem,
  })
  try {
    if (expectedSnapshot) {
      assertUserDataFileSnapshot(expectedSnapshot, captureActiveSnapshot())
    }
    initializeManagedDeletionStage({
      resolvedRoot,
      stagePath,
      domain,
      operationId,
      userId,
      serializedEntries,
      fileSystem,
    })
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const serialized = serializedEntries[index]
      const relativePath = relativeFsPath(serialized.relativePath)
      const stagedPath = path.join(payloadPath(stagePath), relativePath)
      const activeExists = pathExists(fileSystem, entry.fullPath)
      if (!activeExists && entry.expectedPresent === false) continue
      if (activeExists && entry.expectedPresent === false) {
        throw managedError(
          'USER_DATA_CLEAR_PREVIEW_CHANGED',
          'Managed local files changed after the impact preview',
          409,
          null,
          { incomplete: false, databaseCleared: false, cleanupPending: false },
        )
      }
      assertSafeEntry({
        root: resolvedRoot,
        fullPath: entry.fullPath,
        expectedType: entry.type,
        code: entry.code,
        message: entry.message,
        fileSystem,
      })
      ensureSafeParentDirectory({
        root: payloadPath(stagePath),
        fullPath: stagedPath,
        code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
        message: 'A staged managed-file destination is unsafe',
        fileSystem,
      })
      fileSystemMethod(fileSystem, 'renameSync')(entry.fullPath, stagedPath)
      movedEntries.push({ ...entry, activePath: entry.fullPath, stagedPath })
      assertSafeEntry({
        root: payloadPath(stagePath),
        fullPath: stagedPath,
        expectedType: entry.type,
        code: entry.code,
        message: entry.message,
        fileSystem,
      })
    }
    assertStable()
  } catch (cause) {
    let rollbackCause = null
    try { rollback() } catch (error) { rollbackCause = error }
    if (rollbackCause) {
      throw managedError(
        'USER_DATA_CLEAR_RECOVERY_INCOMPLETE',
        'Managed files could not be staged or fully restored; recovery evidence was retained',
        500,
        new AggregateError([cause, rollbackCause]),
        {
          incomplete: true,
          databaseCleared: false,
          cleanupPending: true,
          recoveryRequired: true,
        },
      )
    }
    if (cause?.code?.startsWith('USER_DATA_')) throw cause
    throw managedError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      'Managed files could not be staged; no database data was cleared',
      500,
      cause,
      { incomplete: true, databaseCleared: false },
    )
  }
  return {
    movedEntries,
    cleanup() {
      cleanupManagedDeletionStage({ root: resolvedRoot, stagePath, domain, operationId, userId, fileSystem })
      return true
    },
    rollback,
    assertStable,
  }
}

export function rollbackManagedDeletionStage({
  root,
  stagePath,
  domain,
  operationId,
  userId,
  fileSystem = fs,
} = {}) {
  const manifest = readStageManifest({ root, stagePath, domain, operationId, userId, fileSystem })
  if (!manifest) return true
  if (manifest.empty) {
    removeTree(fileSystem, stagePath)
    return true
  }
  for (const entry of [...manifest.entries].reverse()) {
    const activeExists = pathExists(fileSystem, entry.activePath)
    const stagedExists = pathExists(fileSystem, entry.stagedPath)
    if (activeExists && stagedExists) {
      throw managedError(
        'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        'A staged managed file conflicts with its active path',
        500,
        null,
        { incomplete: true, databaseCleared: false },
      )
    }
    if (stagedExists) {
      assertSafeEntry({
        root: payloadPath(stagePath),
        fullPath: entry.stagedPath,
        expectedType: entry.type,
        code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
        message: 'A staged managed file is unsafe',
        fileSystem,
      })
      ensureSafeParentDirectory({
        root,
        fullPath: entry.activePath,
        code: 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        message: 'A recovered managed-file destination is unsafe',
        fileSystem,
      })
      fileSystemMethod(fileSystem, 'renameSync')(entry.stagedPath, entry.activePath)
    } else if (!activeExists && entry.expectedPresent !== false) {
      throw managedError(
        'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        'A managed file is missing from both active and staging storage',
        500,
        null,
        { incomplete: true, databaseCleared: false },
      )
    }
  }
  removeTree(fileSystem, stagePath)
  return true
}

export function cleanupManagedDeletionStage({
  root,
  stagePath,
  domain,
  operationId,
  userId,
  fileSystem = fs,
} = {}) {
  const manifest = readStageManifest({ root, stagePath, domain, operationId, userId, fileSystem })
  if (!manifest) return true
  enumerateDirectoryFiles({
    root,
    directory: stagePath,
    code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
    message: 'A committed user-data staging tree is unsafe',
    fileSystem,
  })
  removeTree(fileSystem, stagePath)
  return true
}


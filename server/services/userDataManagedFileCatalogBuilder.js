import fs from 'node:fs'
import path from 'node:path'
import { SESSION_JSONL_SCHEMA_VERSION } from './sessionJsonlCodec.js'
import { resolveCompactionArchiveUserStorage } from './compactionArchiveStore.js'
import {
  addArchiveFile,
  addDeletionEntry,
  appDataRoot,
  archivePath,
  archiveSegment,
  artifactRoot,
  assertSafeEntry,
  canonicalSessionContentFiles,
  deletionEntry,
  enumerateDirectoryFiles,
  fileSystemMethod,
  isInside,
  managedError,
  managedFileDescriptor,
  otherUserReferenceCount,
  pathExists,
  stableArchiveFilename,
  storageToken,
} from './userDataManagedFileCatalogSupport.js'

function addManagedAttachmentFiles(runtime) {
  if (!runtime.exporting) return
  for (const row of runtime.records.managed_attachments || []) {
    if (row.status !== 'ready') continue
    const fullPath = path.resolve(runtime.attachments, String(row.storage_path || ''))
    const code = 'USER_DATA_EXPORT_ATTACHMENT_UNAVAILABLE'
    const message = `Managed attachment ${row.id} is missing or outside its storage root`
    addArchiveFile(runtime.files, runtime.seenArchivePaths, managedFileDescriptor({
      kind: 'attachment',
      id: row.id,
      archiveName: archivePath(
        'attachments',
        stableArchiveFilename(row.id, 'attachment'),
        stableArchiveFilename(row.original_name, 'file'),
      ),
      root: runtime.attachments,
      fullPath,
      code,
      message,
      sha256: row.sha256 || null,
      fileSystem: runtime.fileSystem,
    }))
  }
}

function addCompactionArchiveDeletion(runtime) {
  if (runtime.exporting || !runtime.includeCompactionArchives) return
  const { userId, env, fileSystem, dataRoot, dataEntries, seenDeletionPaths, stats } = runtime
  const storage = resolveCompactionArchiveUserStorage({ userId, env })
  const present = pathExists(fileSystem, storage.bucketPath)
  const code = 'USER_DATA_CLEAR_COMPACTION_ARCHIVE_UNSAFE'
  const message = 'Managed compaction archives cannot be safely accessed'
  if (present) {
    enumerateDirectoryFiles({ root: dataRoot, directory: storage.bucketPath, code, message, fileSystem })
  }
  addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
    kind: 'compaction-archive', id: userId, domain: 'data', root: dataRoot,
    fullPath: storage.bucketPath, type: 'directory', expectedPresent: present, code, message,
  }))
  if (present) stats.managedFiles.removable += 1
}

function addArtifactFiles(runtime, artifactRows) {
  const { exporting, artifacts, fileSystem, db, catalogByName, userId, stats } = runtime
  const filenames = new Set(artifactRows.map((row) => row.filename).filter(Boolean))
  for (const rawName of filenames) {
    const filename = String(rawName)
    const fullPath = path.resolve(artifacts, filename)
    const code = exporting ? 'USER_DATA_EXPORT_ARTIFACT_UNAVAILABLE' : 'USER_DATA_CLEAR_ARTIFACT_UNSAFE'
    const message = `Managed artifact ${filename} is missing or outside its storage root`
    if (path.basename(filename) !== filename || !isInside(artifacts, fullPath)) {
      throw managedError(code, message, 409, null, exporting
        ? {}
        : { incomplete: true, databaseCleared: false })
    }
    const shared = otherUserReferenceCount(db, catalogByName, 'filename', filename, userId) > 0
    if (!pathExists(fileSystem, fullPath)) {
      if (exporting) throw managedError(code, message)
      stats.artifactFiles.alreadyMissing += 1
      stats.managedFiles.alreadyMissing += 1
      if (!shared) {
        addDeletionEntry(runtime.artifactEntries, runtime.seenDeletionPaths, deletionEntry({
          kind: 'artifact', id: filename, domain: 'artifacts', root: artifacts,
          fullPath, expectedPresent: false, code, message,
        }))
      }
      continue
    }
    addArchiveFile(runtime.files, runtime.seenArchivePaths, managedFileDescriptor({
      kind: 'artifact', id: filename, archiveName: archivePath('artifacts', filename),
      root: artifacts, fullPath, code, message, fileSystem,
    }))
    if (exporting) continue
    if (shared) {
      stats.artifactFiles.preservedShared += 1
      stats.managedFiles.preservedShared += 1
    } else {
      addDeletionEntry(runtime.artifactEntries, runtime.seenDeletionPaths, deletionEntry({
        kind: 'artifact', id: filename, domain: 'artifacts', root: artifacts,
        fullPath, code, message,
      }))
      stats.artifactFiles.removed += 1
      stats.managedFiles.removable += 1
    }
  }
}

function addArtifactSidecar(runtime, { id, shared, kind, root, fullPath, present, code, message }) {
  const { exporting, fileSystem, stats } = runtime
  if (present && kind === 'artifact-source') {
    addArchiveFile(runtime.files, runtime.seenArchivePaths, managedFileDescriptor({
      kind,
      id,
      archiveName: archivePath('artifact-sources', archiveSegment(id, 'artifact'), 'source.json'),
      root: runtime.artifacts,
      fullPath,
      code,
      message,
      fileSystem,
    }))
  }
  if (exporting) return
  if (shared) {
    if (present) stats.managedFiles.preservedShared += 1
    return
  }
  addDeletionEntry(runtime.artifactEntries, runtime.seenDeletionPaths, deletionEntry({
    kind, id, domain: 'artifacts', root, fullPath,
    ...(kind === 'html-artifact-assets' ? { type: 'directory' } : {}),
    expectedPresent: present, code, message,
  }))
  if (present) stats.managedFiles.removable += 1
}

function addArtifactSidecars(runtime, artifactRows) {
  const { artifacts, fileSystem, db, catalogByName, userId } = runtime
  const artifactIds = new Set(artifactRows.map((row) => row.id).filter(Boolean))
  for (const rawId of artifactIds) {
    const id = String(rawId)
    const digest = storageToken(id)
    const shared = otherUserReferenceCount(db, catalogByName, 'id', id, userId) > 0
    const sourcePath = path.join(artifacts, '.artifact-sources', `${digest}.json`)
    const sourceCode = runtime.exporting
      ? 'USER_DATA_EXPORT_ARTIFACT_SOURCE_UNAVAILABLE'
      : 'USER_DATA_CLEAR_ARTIFACT_SOURCE_UNSAFE'
    addArtifactSidecar(runtime, {
      id, shared, kind: 'artifact-source', root: artifacts, fullPath: sourcePath,
      present: pathExists(fileSystem, sourcePath), code: sourceCode,
      message: `Managed source for artifact ${id} cannot be safely accessed`,
    })
    const bundlePath = path.join(artifacts, '.html-artifact-assets', digest)
    const bundleCode = runtime.exporting
      ? 'USER_DATA_EXPORT_HTML_ASSETS_UNAVAILABLE'
      : 'USER_DATA_CLEAR_HTML_ASSETS_UNSAFE'
    const bundleMessage = `Managed HTML assets for artifact ${id} cannot be safely accessed`
    const bundlePresent = pathExists(fileSystem, bundlePath)
    if (bundlePresent) {
      const prefix = archivePath('html-artifact-assets', archiveSegment(id, 'artifact'))
      for (const file of enumerateDirectoryFiles({
        root: artifacts, directory: bundlePath, code: bundleCode,
        message: bundleMessage, fileSystem,
      })) {
        addArchiveFile(runtime.files, runtime.seenArchivePaths, managedFileDescriptor({
          kind: 'html-artifact-asset', id, archiveName: archivePath(prefix, file.relativePath),
          root: artifacts, fullPath: file.fullPath, code: bundleCode,
          message: bundleMessage, fileSystem,
        }))
      }
    }
    addArtifactSidecar(runtime, {
      id, shared, kind: 'html-artifact-assets', root: artifacts, fullPath: bundlePath,
      present: bundlePresent, code: bundleCode, message: bundleMessage,
    })
  }
}

function addRowManagedFiles(runtime) {
  const groups = [
    {
      rows: runtime.records.background_processes || [], value: (row) => row.log_path,
      root: runtime.backgroundLogs, kind: 'background-log', archiveRoot: 'background-logs',
      exportCode: 'USER_DATA_EXPORT_BACKGROUND_LOG_UNAVAILABLE',
      clearCode: 'USER_DATA_CLEAR_BACKGROUND_LOG_UNSAFE',
    },
    {
      rows: runtime.records.file_snapshots || [], value: (row) => row.before_path,
      root: runtime.snapshots, kind: 'file-snapshot', archiveRoot: 'file-snapshots',
      exportCode: 'USER_DATA_EXPORT_FILE_SNAPSHOT_UNAVAILABLE',
      clearCode: 'USER_DATA_CLEAR_FILE_SNAPSHOT_UNSAFE',
    },
  ]
  for (const group of groups) {
    for (const row of group.rows) {
      const storedPath = group.value(row)
      if (!storedPath) continue
      const fullPath = path.resolve(String(storedPath))
      const code = runtime.exporting ? group.exportCode : group.clearCode
      const message = `${group.kind} ${row.id} is missing or outside its managed root`
      if (!isInside(path.resolve(group.root), fullPath)) throw managedError(code, message)
      if (!pathExists(runtime.fileSystem, fullPath)) {
        if (runtime.exporting) throw managedError(code, message)
        runtime.stats.managedFiles.alreadyMissing += 1
        addDeletionEntry(runtime.dataEntries, runtime.seenDeletionPaths, deletionEntry({
          kind: group.kind, id: row.id, domain: 'data', root: runtime.dataRoot,
          fullPath, expectedPresent: false, code, message,
        }))
        continue
      }
      addArchiveFile(runtime.files, runtime.seenArchivePaths, managedFileDescriptor({
        kind: group.kind, id: row.id,
        archiveName: archivePath(group.archiveRoot, archiveSegment(row.id, group.kind), path.basename(fullPath)),
        root: group.root, fullPath, code, message, fileSystem: runtime.fileSystem,
      }))
      if (!runtime.exporting) {
        addDeletionEntry(runtime.dataEntries, runtime.seenDeletionPaths, deletionEntry({
          kind: group.kind, id: row.id, domain: 'data', root: runtime.dataRoot,
          fullPath, code, message,
        }))
        runtime.stats.managedFiles.removable += 1
      }
    }
  }
}

function addDirectoryDomain(runtime, { kind, directory, code, message, archiveRoot }) {
  const present = pathExists(runtime.fileSystem, directory)
  if (present) {
    for (const file of enumerateDirectoryFiles({
      root: runtime.dataRoot, directory, code, message, fileSystem: runtime.fileSystem,
    })) {
      addArchiveFile(runtime.files, runtime.seenArchivePaths, managedFileDescriptor({
        kind, id: runtime.userId, archiveName: archivePath(archiveRoot, file.relativePath),
        root: runtime.dataRoot, fullPath: file.fullPath, code, message,
        fileSystem: runtime.fileSystem,
      }))
    }
  }
  if (!runtime.exporting) {
    addDeletionEntry(runtime.dataEntries, runtime.seenDeletionPaths, deletionEntry({
      kind, id: runtime.userId, domain: 'data', root: runtime.dataRoot,
      fullPath: directory, type: 'directory', expectedPresent: present, code, message,
    }))
    if (present) runtime.stats.managedFiles.removable += 1
  }
}

function addBrowserAndSessionContent(runtime) {
  const browserPath = path.join(runtime.browserProfiles, storageToken(runtime.userId, 32))
  addDirectoryDomain(runtime, {
    kind: 'browser-profile', directory: browserPath,
    code: runtime.exporting
      ? 'USER_DATA_EXPORT_BROWSER_PROFILE_UNAVAILABLE'
      : 'USER_DATA_CLEAR_BROWSER_PROFILE_UNSAFE',
    message: 'The managed browser profile cannot be safely accessed',
    archiveRoot: 'browser-profile',
  })
  const sessionPath = path.join(runtime.sessionContent, storageToken(runtime.userId, 32))
  if (runtime.exporting) {
    for (const descriptor of canonicalSessionContentFiles({
      records: runtime.records, userId: runtime.userId, env: runtime.env,
    })) addArchiveFile(runtime.files, runtime.seenArchivePaths, descriptor)
  } else {
    addDirectoryDomain(runtime, {
      kind: 'session-content', directory: sessionPath,
      code: 'USER_DATA_CLEAR_SESSION_CONTENT_UNSAFE',
      message: 'The managed session content cannot be safely accessed',
      archiveRoot: 'sessions',
    })
  }
}

export function buildManagedUserFileCatalog({
  records,
  userId,
  db,
  catalogByName,
  env = process.env,
  purpose = 'export',
  fileSystem = fs,
  includeCompactionArchives = true,
} = {}) {
  const dataRoot = appDataRoot(env)
  const artifacts = artifactRoot(env)
  const runtime = {
    records,
    userId,
    db,
    catalogByName,
    env,
    fileSystem,
    includeCompactionArchives,
    exporting: purpose === 'export',
    dataRoot,
    artifacts,
    attachments: path.join(dataRoot, 'attachments'),
    backgroundLogs: path.join(dataRoot, 'background-logs'),
    snapshots: path.join(dataRoot, 'snapshots'),
    browserProfiles: path.join(dataRoot, 'browser-profiles'),
    sessionContent: path.join(dataRoot, 'session-content', `v${SESSION_JSONL_SCHEMA_VERSION}`),
    files: [],
    dataEntries: [],
    artifactEntries: [],
    seenArchivePaths: new Set(),
    seenDeletionPaths: new Set(),
    stats: {
      artifactFiles: { removed: 0, preservedShared: 0, alreadyMissing: 0 },
      managedFiles: { removable: 0, preservedShared: 0, alreadyMissing: 0 },
    },
  }
  addManagedAttachmentFiles(runtime)
  addCompactionArchiveDeletion(runtime)
  const artifactRows = [...(records.job_artifacts || []), ...(records.turn_artifacts || [])]
  addArtifactFiles(runtime, artifactRows)
  addArtifactSidecars(runtime, artifactRows)
  addRowManagedFiles(runtime)
  addBrowserAndSessionContent(runtime)
  return {
    files: runtime.files,
    deletion: {
      data: { root: dataRoot, entries: runtime.dataEntries },
      artifacts: { root: artifacts, entries: runtime.artifactEntries },
    },
    stats: runtime.stats,
  }
}

export function openManagedFileDescriptor(file, fileSystem = fs) {
  assertSafeEntry({ ...file, expectedType: 'file', fileSystem })
  let descriptor = null
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      file.fullPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    )
    const descriptorStat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    const finalStat = assertSafeEntry({ ...file, expectedType: 'file', fileSystem })
    const sameFile = descriptorStat.dev === finalStat.dev && descriptorStat.ino === finalStat.ino
    const sameSnapshotFile = descriptorStat.dev === file.device && descriptorStat.ino === file.inode
    const sizeMatches = file.kind === 'session-content'
      ? descriptorStat.size >= file.size
      : descriptorStat.size === file.size
    if (!descriptorStat.isFile() || !sameFile || !sameSnapshotFile || !sizeMatches) {
      throw managedError(file.code, file.message)
    }
    return descriptor
  } catch (error) {
    if (descriptor !== null) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* preserve error */ }
    }
    if (error?.code === file.code) throw error
    throw managedError(file.code, file.message, 409, error)
  }
}

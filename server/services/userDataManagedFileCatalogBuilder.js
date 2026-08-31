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
  const exporting = purpose === 'export'
  const dataRoot = appDataRoot(env)
  const artifacts = artifactRoot(env)
  const attachments = path.join(dataRoot, 'attachments')
  const backgroundLogs = path.join(dataRoot, 'background-logs')
  const snapshots = path.join(dataRoot, 'snapshots')
  const browserProfiles = path.join(dataRoot, 'browser-profiles')
  const sessionContent = path.join(dataRoot, 'session-content', `v${SESSION_JSONL_SCHEMA_VERSION}`)
  const files = []
  const dataEntries = []
  const artifactEntries = []
  const seenArchivePaths = new Set()
  const seenDeletionPaths = new Set()
  const stats = {
    artifactFiles: { removed: 0, preservedShared: 0, alreadyMissing: 0 },
    managedFiles: { removable: 0, preservedShared: 0, alreadyMissing: 0 },
  }

  for (const row of exporting ? (records.managed_attachments || []) : []) {
    if (row.status !== 'ready') continue
    const fullPath = path.resolve(attachments, String(row.storage_path || ''))
    const code = 'USER_DATA_EXPORT_ATTACHMENT_UNAVAILABLE'
    const message = `Managed attachment ${row.id} is missing or outside its storage root`
    addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
      kind: 'attachment',
      id: row.id,
      archiveName: archivePath(
        'attachments',
        stableArchiveFilename(row.id, 'attachment'),
        stableArchiveFilename(row.original_name, 'file'),
      ),
      root: attachments,
      fullPath,
      code,
      message,
      sha256: row.sha256 || null,
      fileSystem,
    }))
  }

  if (!exporting && includeCompactionArchives) {
    const compactionStorage = resolveCompactionArchiveUserStorage({ userId, env })
    const compactionPresent = pathExists(fileSystem, compactionStorage.bucketPath)
    const code = 'USER_DATA_CLEAR_COMPACTION_ARCHIVE_UNSAFE'
    const message = 'Managed compaction archives cannot be safely accessed'
    if (compactionPresent) {
      enumerateDirectoryFiles({
        root: dataRoot,
        directory: compactionStorage.bucketPath,
        code,
        message,
        fileSystem,
      })
    }
    addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
      kind: 'compaction-archive',
      id: userId,
      domain: 'data',
      root: dataRoot,
      fullPath: compactionStorage.bucketPath,
      type: 'directory',
      expectedPresent: compactionPresent,
      code,
      message,
    }))
    if (compactionPresent) stats.managedFiles.removable += 1
  }

  const artifactRows = [
    ...(records.job_artifacts || []),
    ...(records.turn_artifacts || []),
  ]
  const filenames = new Set(artifactRows.map((row) => row.filename).filter(Boolean))
  for (const rawName of filenames) {
    const filename = String(rawName)
    const fullPath = path.resolve(artifacts, filename)
    const code = exporting
      ? 'USER_DATA_EXPORT_ARTIFACT_UNAVAILABLE'
      : 'USER_DATA_CLEAR_ARTIFACT_UNSAFE'
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
        addDeletionEntry(artifactEntries, seenDeletionPaths, deletionEntry({
          kind: 'artifact', id: filename, domain: 'artifacts', root: artifacts,
          fullPath, expectedPresent: false, code, message,
        }))
      }
    } else {
      const descriptor = managedFileDescriptor({
        kind: 'artifact',
        id: filename,
        archiveName: archivePath('artifacts', filename),
        root: artifacts,
        fullPath,
        code,
        message,
        fileSystem,
      })
      addArchiveFile(files, seenArchivePaths, descriptor)
      if (!exporting) {
        if (shared) {
          stats.artifactFiles.preservedShared += 1
          stats.managedFiles.preservedShared += 1
        } else {
          addDeletionEntry(artifactEntries, seenDeletionPaths, deletionEntry({
            kind: 'artifact', id: filename, domain: 'artifacts', root: artifacts, fullPath, code, message,
          }))
          stats.artifactFiles.removed += 1
          stats.managedFiles.removable += 1
        }
      }
    }
  }

  const artifactIds = new Set(artifactRows.map((row) => row.id).filter(Boolean))
  for (const rawId of artifactIds) {
    const id = String(rawId)
    const digest = storageToken(id)
    const shared = otherUserReferenceCount(db, catalogByName, 'id', id, userId) > 0
    const sourceRoot = path.join(artifacts, '.artifact-sources')
    const sourcePath = path.join(sourceRoot, `${digest}.json`)
    const sourceCode = exporting
      ? 'USER_DATA_EXPORT_ARTIFACT_SOURCE_UNAVAILABLE'
      : 'USER_DATA_CLEAR_ARTIFACT_SOURCE_UNSAFE'
    const sourceMessage = `Managed source for artifact ${id} cannot be safely accessed`
    const sourcePresent = pathExists(fileSystem, sourcePath)
    if (sourcePresent) {
      addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
        kind: 'artifact-source',
        id,
        archiveName: archivePath('artifact-sources', archiveSegment(id, 'artifact'), 'source.json'),
        root: artifacts,
        fullPath: sourcePath,
        code: sourceCode,
        message: sourceMessage,
        fileSystem,
      }))
    }
    if (!exporting) {
      if (shared) {
        if (sourcePresent) stats.managedFiles.preservedShared += 1
      } else {
        addDeletionEntry(artifactEntries, seenDeletionPaths, deletionEntry({
          kind: 'artifact-source', id, domain: 'artifacts', root: artifacts,
          fullPath: sourcePath, expectedPresent: sourcePresent,
          code: sourceCode, message: sourceMessage,
        }))
        if (sourcePresent) stats.managedFiles.removable += 1
      }
    }

    const bundleRoot = path.join(artifacts, '.html-artifact-assets')
    const bundlePath = path.join(bundleRoot, digest)
    const bundleCode = exporting
      ? 'USER_DATA_EXPORT_HTML_ASSETS_UNAVAILABLE'
      : 'USER_DATA_CLEAR_HTML_ASSETS_UNSAFE'
    const bundleMessage = `Managed HTML assets for artifact ${id} cannot be safely accessed`
    const bundlePresent = pathExists(fileSystem, bundlePath)
    if (bundlePresent) {
      const prefix = archivePath('html-artifact-assets', archiveSegment(id, 'artifact'))
      for (const file of enumerateDirectoryFiles({
        root: artifacts,
        directory: bundlePath,
        code: bundleCode,
        message: bundleMessage,
        fileSystem,
      })) {
        addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
          kind: 'html-artifact-asset',
          id,
          archiveName: archivePath(prefix, file.relativePath),
          root: artifacts,
          fullPath: file.fullPath,
          code: bundleCode,
          message: bundleMessage,
          fileSystem,
        }))
      }
    }
    if (!exporting) {
      if (shared) {
        if (bundlePresent) stats.managedFiles.preservedShared += 1
      } else {
        addDeletionEntry(artifactEntries, seenDeletionPaths, deletionEntry({
          kind: 'html-artifact-assets', id, domain: 'artifacts', root: artifacts,
          fullPath: bundlePath, type: 'directory', expectedPresent: bundlePresent,
          code: bundleCode, message: bundleMessage,
        }))
        if (bundlePresent) stats.managedFiles.removable += 1
      }
    }
  }

  const rowFileGroups = [
    {
      rows: records.background_processes || [],
      value: (row) => row.log_path,
      root: backgroundLogs,
      kind: 'background-log',
      archiveRoot: 'background-logs',
      exportCode: 'USER_DATA_EXPORT_BACKGROUND_LOG_UNAVAILABLE',
      clearCode: 'USER_DATA_CLEAR_BACKGROUND_LOG_UNSAFE',
    },
    {
      rows: records.file_snapshots || [],
      value: (row) => row.before_path,
      root: snapshots,
      kind: 'file-snapshot',
      archiveRoot: 'file-snapshots',
      exportCode: 'USER_DATA_EXPORT_FILE_SNAPSHOT_UNAVAILABLE',
      clearCode: 'USER_DATA_CLEAR_FILE_SNAPSHOT_UNSAFE',
    },
  ]
  for (const group of rowFileGroups) {
    for (const row of group.rows) {
      const storedPath = group.value(row)
      if (!storedPath) continue
      const fullPath = path.resolve(String(storedPath))
      const code = exporting ? group.exportCode : group.clearCode
      const message = `${group.kind} ${row.id} is missing or outside its managed root`
      if (!isInside(path.resolve(group.root), fullPath)) throw managedError(code, message)
      if (!pathExists(fileSystem, fullPath)) {
        if (exporting) throw managedError(code, message)
        stats.managedFiles.alreadyMissing += 1
        addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
          kind: group.kind, id: row.id, domain: 'data', root: dataRoot, fullPath,
          expectedPresent: false, code, message,
        }))
        continue
      }
      const descriptor = managedFileDescriptor({
        kind: group.kind,
        id: row.id,
        archiveName: archivePath(
          group.archiveRoot,
          archiveSegment(row.id, group.kind),
          path.basename(fullPath),
        ),
        root: group.root,
        fullPath,
        code,
        message,
        fileSystem,
      })
      addArchiveFile(files, seenArchivePaths, descriptor)
      if (!exporting) {
        addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
          kind: group.kind, id: row.id, domain: 'data', root: dataRoot, fullPath, code, message,
        }))
        stats.managedFiles.removable += 1
      }
    }
  }

  const browserPath = path.join(browserProfiles, storageToken(userId, 32))
  const browserPresent = pathExists(fileSystem, browserPath)
  const browserCode = exporting
    ? 'USER_DATA_EXPORT_BROWSER_PROFILE_UNAVAILABLE'
    : 'USER_DATA_CLEAR_BROWSER_PROFILE_UNSAFE'
  const browserMessage = 'The managed browser profile cannot be safely accessed'
  if (browserPresent) {
    for (const file of enumerateDirectoryFiles({
      root: dataRoot,
      directory: browserPath,
      code: browserCode,
      message: browserMessage,
      fileSystem,
    })) {
      addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
        kind: 'browser-profile',
        id: userId,
        archiveName: archivePath('browser-profile', file.relativePath),
        root: dataRoot,
        fullPath: file.fullPath,
        code: browserCode,
        message: browserMessage,
        fileSystem,
      }))
    }
  }
  if (!exporting) {
    addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
      kind: 'browser-profile', id: userId, domain: 'data', root: dataRoot,
      fullPath: browserPath, type: 'directory', expectedPresent: browserPresent,
      code: browserCode, message: browserMessage,
    }))
    if (browserPresent) stats.managedFiles.removable += 1
  }

  const sessionContentPath = path.join(sessionContent, storageToken(userId, 32))
  if (exporting) {
    for (const descriptor of canonicalSessionContentFiles({ records, userId, env })) {
      addArchiveFile(files, seenArchivePaths, descriptor)
    }
  } else {
    const sessionContentPresent = pathExists(fileSystem, sessionContentPath)
    const code = 'USER_DATA_CLEAR_SESSION_CONTENT_UNSAFE'
    const message = 'The managed session content cannot be safely accessed'
    if (sessionContentPresent) {
      for (const file of enumerateDirectoryFiles({
        root: dataRoot,
        directory: sessionContentPath,
        code,
        message,
        fileSystem,
      })) {
        addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
          kind: 'session-content',
          id: userId,
          archiveName: archivePath('sessions', file.relativePath),
          root: dataRoot,
          fullPath: file.fullPath,
          code,
          message,
          fileSystem,
        }))
      }
    }
    addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
      kind: 'session-content',
      id: userId,
      domain: 'data',
      root: dataRoot,
      fullPath: sessionContentPath,
      type: 'directory',
      expectedPresent: sessionContentPresent,
      code,
      message,
    }))
    if (sessionContentPresent) stats.managedFiles.removable += 1
  }

  return {
    files,
    deletion: {
      data: { root: dataRoot, entries: dataEntries },
      artifacts: { root: artifacts, entries: artifactEntries },
    },
    stats,
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

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { registerTemporaryArtifactPreview } from './artifactPreviewGrantStore.js'
import { isSafeArtifactFilename } from './artifactStorage.js'

const LINK_UNSUPPORTED_CODES = new Set([
  'EACCES',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
])

const FLUSH_UNSUPPORTED_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])

function candidateFilename(preferredFilename, suffix) {
  if (suffix === 1) return preferredFilename
  const parsed = path.parse(preferredFilename)
  return `${parsed.name}-${suffix}${parsed.ext}`
}

function stagingPath(directory, filename) {
  return path.join(
    directory,
    `.${filename}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
  )
}

function flushDescriptor(fileSystem, descriptor) {
  try {
    fileSystem.fsyncSync(descriptor)
  } catch (error) {
    if (!FLUSH_UNSUPPORTED_CODES.has(error?.code)) throw error
  }
}

function writeCompleteStagingFile(fileSystem, temporary, contents, encoding) {
  let descriptor = null
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', 0o600)
    fileSystem.writeFileSync(descriptor, contents, encoding ? { encoding } : undefined)
    flushDescriptor(fileSystem, descriptor)
    fileSystem.closeSync(descriptor)
    descriptor = null
  } catch (error) {
    if (descriptor != null) {
      try { fileSystem.closeSync(descriptor) } catch { /* best-effort descriptor cleanup */ }
    }
    throw error
  }
}

function publishCompleteStagingFile(fileSystem, temporary, target) {
  try {
    // A same-directory hard link is an atomic no-clobber publication. It also
    // avoids rename's platform-specific replacement semantics when two writers
    // concurrently choose the same human-readable filename.
    fileSystem.linkSync(temporary, target)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    if (LINK_UNSUPPORTED_CODES.has(error?.code)) return publishByExclusiveCopy(fileSystem, temporary, target)
    throw error
  }

  // Publication already succeeded. A cleanup failure must not turn that
  // complete artifact into a false failure and cause a duplicate suffixed copy.
  try { fileSystem.unlinkSync(temporary) } catch { /* retried by the outer cleanup */ }
  return true
}

function publishByExclusiveCopy(fileSystem, temporary, target) {
  // exFAT and some network filesystems do not support hard links. A prior
  // exists check followed by rename can overwrite a concurrent POSIX winner,
  // so the fallback must claim the final pathname with O_EXCL as well.
  try {
    fileSystem.copyFileSync(temporary, target, fs.constants.COPYFILE_EXCL)
    try { fileSystem.unlinkSync(temporary) } catch { /* outer cleanup retries */ }
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

/**
 * Publish a newly generated artifact without exposing an empty or partial
 * final pathname. `filenameExists` may additionally reserve database names.
 */
export function writeGeneratedArtifactAtomically({
  artifactDirectory,
  preferredFilename,
  contents,
  encoding = null,
  previewUserId = null,
  filenameExists = () => false,
  fileSystem = fs,
  maxCandidates = 10_000,
} = {}) {
  const directory = path.resolve(String(artifactDirectory || ''))
  const preferred = String(preferredFilename || '')
  if (!isSafeArtifactFilename(preferred)) {
    throw new Error('invalid generated artifact filename')
  }
  fileSystem.mkdirSync(directory, { recursive: true })

  for (let suffix = 1; suffix <= maxCandidates; suffix += 1) {
    const filename = candidateFilename(preferred, suffix)
    const target = path.join(directory, filename)
    if (filenameExists(filename) || fileSystem.existsSync(target)) continue

    const temporary = stagingPath(directory, filename)
    try {
      writeCompleteStagingFile(fileSystem, temporary, contents, encoding)
      if (!publishCompleteStagingFile(fileSystem, temporary, target)) continue
      if (previewUserId != null) {
        registerTemporaryArtifactPreview({ userId: previewUserId, artifactPath: target })
      }
      return { filename, fullPath: target }
    } finally {
      try { fileSystem.unlinkSync(temporary) } catch { /* committed or best-effort failure cleanup */ }
    }
  }
  throw new Error('could not allocate a unique artifact filename')
}

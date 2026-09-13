import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACT_DIR, isSafeArtifactFilename } from './artifactStorage.js'

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Best-effort PPT preview cache identity, NOT a content digest or execution
 * receipt. Never use this stat-derived token for authorization, verification,
 * side-effect reconciliation or deciding whether an operation succeeded.
 * No directories, metadata or database rows are created while reading it.
 */
export function artifactPreviewIdentity(artifact, {
  artifactDirectory = ARTIFACT_DIR,
  fileSystem = fs,
} = {}) {
  try {
    const filename = artifact?.filename
    const type = String(artifact?.type || '').toLowerCase()
    if ((type && type !== 'pptx') || typeof filename !== 'string'
      || !isSafeArtifactFilename(filename) || path.extname(filename).toLowerCase() !== '.pptx') return {}

    const directory = path.resolve(artifactDirectory)
    const canonicalDirectory = fileSystem.realpathSync(directory)
    const expected = path.join(canonicalDirectory, filename)
    const declared = artifact?.fullPath
    if (declared != null && (typeof declared !== 'string' || !path.isAbsolute(declared)
      || (!samePath(path.resolve(declared), path.join(directory, filename))
        && !samePath(path.resolve(declared), expected)))) return {}

    const before = fileSystem.lstatSync(expected, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) return {}
    const canonical = fileSystem.realpathSync(expected)
    if (!samePath(canonical, expected)) return {}
    const stat = fileSystem.lstatSync(canonical, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || before.dev !== stat.dev || before.ino !== stat.ino) return {}
    const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
    if (fields.some(field => typeof stat[field] !== 'bigint')) return {}
    const previewRevision = createHash('sha256')
      .update(JSON.stringify(['pptx-preview-stat-v1', ...fields.map(field => stat[field].toString())]))
      .digest('hex')
    return { previewRevision }
  } catch {
    // A missing, unavailable or concurrently replaced file must not turn a
    // successful artifact operation or a history read into a new failure.
    return {}
  }
}

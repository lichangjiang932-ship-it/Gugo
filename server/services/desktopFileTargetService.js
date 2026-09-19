import fs from 'node:fs'
import path from 'node:path'
import { desktopFileError, desktopFileOpenPolicy, normalizeDesktopFileReference } from '../../shared/desktopFileReference.js'
import { desktopFileStatFingerprint, signDesktopFileMessage, verifyDesktopFileMessage } from '../utils/desktopFileProtocol.js'
import { getArtifactDir, isSafeArtifactFilename } from './artifactStorage.js'
import { resolveOwnedArtifactByFilename } from './artifactDelivery.js'
import { getRetainedLocalFile, getVerifiedLocalFile } from './verifiedLocalFileService.js'
import { resolveAuthorizedLocalPath } from './localFileAccessService.js'

const TARGET_ERROR_STATUS = {
  DESKTOP_FILE_REFERENCE_INVALID: 400,
  DESKTOP_FILE_ACTION_INVALID: 400,
  DESKTOP_FILE_NOT_FOUND: 404,
  DESKTOP_FILE_BRIDGE_UNAVAILABLE: 503,
  DESKTOP_FILE_SERVICE_UNTRUSTED: 403,
  DESKTOP_FILE_PATH_INVALID: 403,
  DESKTOP_FILE_NOT_REGULAR: 403,
  DESKTOP_FILE_OPEN_UNSAFE: 403,
}

function publicTargetError(cause) {
  if (cause?.code === 'ENOENT') return Object.assign(desktopFileError('DESKTOP_FILE_NOT_FOUND'), { statusCode: 404 })
  if (['EACCES', 'EPERM'].includes(cause?.code)) return Object.assign(desktopFileError('DESKTOP_FILE_ACCESS_DENIED'), { statusCode: 403 })
  const explicitStatus = TARGET_ERROR_STATUS[cause?.code]
    || ([400, 401, 403, 404, 409].includes(cause?.statusCode) ? cause.statusCode : 0)
  const code = explicitStatus && /^[A-Z][A-Z0-9_]{0,79}$/u.test(cause?.code || '')
    ? cause.code : 'DESKTOP_FILE_RESOLVE_FAILED'
  // Metadata failures must not return OS paths, database details, stack traces
  // or the signing secret. The renderer presents a localized message by code.
  return Object.assign(desktopFileError(code), { statusCode: explicitStatus || 500 })
}

function resolveManagedTarget(reference, userId) {
  if (!isSafeArtifactFilename(reference.filename)) throw desktopFileError('DESKTOP_FILE_REFERENCE_INVALID')
  const ownership = resolveOwnedArtifactByFilename(reference.filename, userId)
  if (!ownership.artifact || ownership.conflict) throw desktopFileError('DESKTOP_FILE_NOT_FOUND')
  const root = fs.realpathSync(getArtifactDir())
  const fullPath = fs.realpathSync(path.join(root, reference.filename))
  const relative = path.relative(root, fullPath)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw desktopFileError('DESKTOP_FILE_PATH_INVALID')
  }
  return fullPath
}

export function resolveDesktopFileTarget({ userId, request, secret, now = Date.now() }) {
  try {
    const message = verifyDesktopFileMessage(request, secret, { now })
    if (!['open', 'reveal'].includes(message.action)) throw desktopFileError('DESKTOP_FILE_ACTION_INVALID')
    const reference = normalizeDesktopFileReference(message.reference)
    const fullPath = reference.kind === 'artifact' ? resolveManagedTarget(reference, userId)
      : (reference.kind === 'retained' ? getRetainedLocalFile : getVerifiedLocalFile)({ ...reference, userId }).fullPath
    const canonicalPath = fs.realpathSync(fullPath)
    if (reference.kind !== 'artifact') {
      resolveAuthorizedLocalPath({ userId, rawPath: canonicalPath, write: false, allowWorkspace: true })
    }
    const stat = fs.statSync(canonicalPath, { bigint: true })
    if (!stat.isFile()) throw desktopFileError('DESKTOP_FILE_NOT_REGULAR')
    const filename = path.basename(canonicalPath)
    const policy = desktopFileOpenPolicy(filename)
    if (message.action === 'open' && !policy.allowed) throw desktopFileError('DESKTOP_FILE_OPEN_UNSAFE')
    return signDesktopFileMessage({
      ok: true,
      nonce: message.nonce, issuedAt: message.issuedAt, action: message.action,
      target: { fullPath: canonicalPath, filename, fingerprint: desktopFileStatFingerprint(stat) },
    }, secret)
  } catch (error) {
    throw publicTargetError(error)
  }
}

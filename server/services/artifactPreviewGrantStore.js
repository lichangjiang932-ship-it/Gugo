import fs from 'node:fs'
import path from 'node:path'
import { ensureArtifactDir } from './artifactStorage.js'

const TEMPORARY_PREVIEW_GRANT_TTL_MS = 5 * 60 * 1_000
const MAX_TEMPORARY_PREVIEW_GRANTS = 128
const temporaryPreviewGrants = new Map()

function pathKey(value) {
  const normalized = path.normalize(String(value || ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function insideDirectory(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':')
}

function resolveTemporaryPreviewFile(filePath) {
  const requested = String(filePath || '').trim()
  if (!requested || !path.isAbsolute(requested) || path.extname(requested).toLowerCase() !== '.pptx') {
    return null
  }
  try {
    const requestedStat = fs.lstatSync(requested, { bigint: true })
    if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) return null
    const root = fs.realpathSync(ensureArtifactDir())
    const canonical = fs.realpathSync(requested)
    if (!insideDirectory(root, canonical)) return null
    const canonicalStat = fs.statSync(canonical, { bigint: true })
    if (!canonicalStat.isFile() || fileIdentity(requestedStat) !== fileIdentity(canonicalStat)) return null
    return { canonical, identity: fileIdentity(canonicalStat) }
  } catch {
    return null
  }
}

function sweepExpired(now) {
  for (const [key, grant] of temporaryPreviewGrants) {
    if (grant.expiresAt <= now) temporaryPreviewGrants.delete(key)
  }
}

function enforceCapacity() {
  while (temporaryPreviewGrants.size >= MAX_TEMPORARY_PREVIEW_GRANTS) {
    const oldest = temporaryPreviewGrants.keys().next().value
    if (oldest === undefined) break
    temporaryPreviewGrants.delete(oldest)
  }
}

/**
 * Temporarily authorize previewing newly generated PPTX bytes before their
 * durable artifact row is installed. The grant is user-, path-, identity-,
 * and time-bound; unrelated orphan files never become previewable.
 */
export function registerTemporaryArtifactPreview({ userId, artifactPath, now = Date.now() } = {}) {
  const owner = String(userId || '').trim()
  if (!owner) return false
  const file = resolveTemporaryPreviewFile(artifactPath)
  if (!file) return false
  sweepExpired(now)
  enforceCapacity()
  const key = pathKey(file.canonical)
  temporaryPreviewGrants.delete(key)
  temporaryPreviewGrants.set(key, {
    userId: owner,
    identity: file.identity,
    expiresAt: now + TEMPORARY_PREVIEW_GRANT_TTL_MS,
  })
  return true
}

export function hasTemporaryArtifactPreviewGrant({ userId, artifactPath, now = Date.now() } = {}) {
  const owner = String(userId || '').trim()
  if (!owner) return false
  sweepExpired(now)
  const file = resolveTemporaryPreviewFile(artifactPath)
  if (!file) return false
  const key = pathKey(file.canonical)
  const grant = temporaryPreviewGrants.get(key)
  if (!grant || grant.userId !== owner || grant.identity !== file.identity) {
    if (grant && grant.identity !== file.identity) temporaryPreviewGrants.delete(key)
    return false
  }
  return true
}

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getArtifactByFilename } from './jobStore.js'
import { getTurnArtifactByFilename } from './turnArtifactStore.js'
import {
  ARTIFACT_DIR,
  ensureArtifactDir,
  isSafeArtifactFilename,
} from './artifactStorage.js'

export function artifactNameExists(filename) {
  if (fs.existsSync(path.join(ensureArtifactDir(), filename))) return true
  try {
    return !!(getArtifactByFilename(filename) || getTurnArtifactByFilename(filename))
  } catch {
    return false
  }
}

export function allocateLocalArtifactPath(requestedFilename) {
  ensureArtifactDir()
  const preferred = String(requestedFilename || '').normalize('NFC').trim()
  if (!isSafeArtifactFilename(preferred)) throw new Error('invalid local artifact filename')
  const parsed = path.parse(preferred)
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const filename = suffix === 1 ? preferred : `${parsed.name}-${suffix}${parsed.ext}`
    if (artifactNameExists(filename)) continue
    const fullPath = path.join(ARTIFACT_DIR, filename)
    return {
      id: crypto.randomBytes(8).toString('hex'),
      filename,
      fullPath,
      url: `/api/artifacts/${encodeURIComponent(filename)}`,
    }
  }
  throw new Error('could not allocate a unique local artifact filename')
}

export function stableLocalArtifactPath(requestedFilename, publicationKey) {
  ensureArtifactDir()
  const preferred = String(requestedFilename || '').normalize('NFC').trim()
  if (!isSafeArtifactFilename(preferred)) throw new Error('invalid local artifact filename')
  const key = String(publicationKey || '').trim()
  if (!key) throw new Error('local artifact publication key is required')
  const digest = crypto.createHash('sha256').update(key).digest('hex')
  const parsed = path.parse(preferred)
  const suffix = `-${digest.slice(0, 20)}`
  const reserved = `${suffix}${parsed.ext}`
  const maxStemLength = Math.max(1, 240 - reserved.length)
  const maxStemBytes = Math.max(1, 240 - Buffer.byteLength(reserved, 'utf8'))
  let stem = ''
  for (const character of Array.from(parsed.name)) {
    const candidate = `${stem}${character}`
    if (candidate.length > maxStemLength || Buffer.byteLength(candidate, 'utf8') > maxStemBytes) break
    stem = candidate
  }
  stem = stem.replace(/[.\s]+$/g, '') || 'artifact'
  const filename = `${stem}${suffix}${parsed.ext}`
  return {
    id: `local-${digest}`,
    filename,
    fullPath: path.join(ARTIFACT_DIR, filename),
    url: `/api/artifacts/${encodeURIComponent(filename)}`,
    publicationKey: key,
  }
}

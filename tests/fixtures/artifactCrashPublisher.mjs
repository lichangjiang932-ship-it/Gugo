import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [mode, sourcePath, filename, publicationKey] = process.argv.slice(2)
if (!mode || !sourcePath || !filename || !publicationKey || !process.env.ARTIFACT_DIR) {
  process.exit(64)
}

const originalLink = fs.promises.link
const originalOpen = fs.promises.open
const originalRename = fs.promises.rename
const markerDirectorySegment = `${path.sep}.artifact-publications${path.sep}`
const publicationDigest = crypto.createHash('sha256').update(publicationKey).digest('hex')
const parsedFilename = path.parse(filename)
const publicationLockPath = path.join(
  process.env.ARTIFACT_DIR,
  `.publish-${publicationDigest.slice(0, 32)}.lock`,
)
const publicationMarkerPath = path.join(
  process.env.ARTIFACT_DIR,
  '.artifact-publications',
  `${publicationDigest}.json`,
)
const publishedArtifactPath = path.join(
  process.env.ARTIFACT_DIR,
  `${parsedFilename.name}-${publicationDigest.slice(0, 20)}${parsedFilename.ext}`,
)

function isOwnershipRecord(target) {
  return String(target || '').includes(markerDirectorySegment)
}

function killWithoutCleanup() {
  process.kill(process.pid, 'SIGKILL')
}

function completePublicationLockExists() {
  try {
    const owner = JSON.parse(fs.readFileSync(publicationLockPath, 'utf8'))
    return owner?.publicationDigest === publicationDigest
      && owner?.pid === process.pid
      && /^[a-f0-9]{32}$/u.test(String(owner?.attemptId || ''))
  } catch {
    return false
  }
}

function stagingInodeExists() {
  const prefix = `.publish-${publicationDigest.slice(0, 20)}-`
  return fs.readdirSync(process.env.ARTIFACT_DIR)
    .some((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'))
}

if (mode === 'lock_after_acquire' || mode === 'publication_marker_after_link'
  || mode === 'stage_record_after_link') {
  fs.promises.link = async (...args) => {
    const destination = String(args[1] || '')
    const result = await originalLink(...args)
    const lockPublished = mode === 'lock_after_acquire'
      && destination === publicationLockPath
      && completePublicationLockExists()
    const markerPublished = mode === 'publication_marker_after_link'
      && destination === publicationMarkerPath
    const stageRecordPublished = mode === 'stage_record_after_link'
      && destination.endsWith('.stage.json')
    if (lockPublished || markerPublished || stageRecordPublished) {
      killWithoutCleanup()
      await new Promise(() => {})
    }
    return result
  }
}

if (mode === 'release_after_staging_inode_cleanup') {
  fs.promises.rename = async (source, target, ...args) => {
    const stageRecordCleanup = String(source).endsWith('.stage.json')
      && fs.existsSync(source)
      && !stagingInodeExists()
      && fs.existsSync(publishedArtifactPath)
      && fs.existsSync(publicationMarkerPath)
      && completePublicationLockExists()
    if (stageRecordCleanup) {
      killWithoutCleanup()
      await new Promise(() => {})
    }
    return originalRename(source, target, ...args)
  }
}

if (mode.startsWith('destination_')) {
  fs.promises.link = async (...args) => {
    const destination = String(args[1] || '')
    if (mode === 'destination_before_claim' && destination.endsWith('.destination.json')) {
      killWithoutCleanup()
      await new Promise(() => {})
    }
    if (destination === publishedArtifactPath) {
      const error = new Error('force exclusive-copy publication for crash recovery')
      error.code = 'EPERM'
      throw error
    }
    return originalLink(...args)
  }
}

if (mode === 'stage_before_claim') {
  fs.promises.link = async (...args) => {
    if (String(args[1] || '').endsWith('.stage.json')) {
      killWithoutCleanup()
      await new Promise(() => {})
    }
    return originalLink(...args)
  }
}

fs.promises.open = async (target, flags, ...args) => {
  const handle = await originalOpen(target, flags, ...args)
  const targetPath = String(target || '')
  const shouldCrashWhileWritingStage = mode === 'stage_after_claim'
    && flags === 'r+'
    && targetPath.endsWith('.tmp')
    && !isOwnershipRecord(targetPath)
  const shouldCrashWhileWritingDestination = mode === 'destination_after_claim'
    && flags === 'r+'
    && !targetPath.endsWith('.tmp')
    && !isOwnershipRecord(targetPath)
  if (!shouldCrashWhileWritingStage && !shouldCrashWhileWritingDestination) return handle

  let crashed = false
  return {
    stat: (...statArgs) => handle.stat(...statArgs),
    read: (...readArgs) => handle.read(...readArgs),
    write: async (buffer, offset, length, position) => {
      const result = await handle.write(buffer, offset, Math.min(length, 17), position)
      if (!crashed) {
        crashed = true
        await handle.sync()
        killWithoutCleanup()
      }
      return result
    },
    sync: (...syncArgs) => handle.sync(...syncArgs),
    close: (...closeArgs) => handle.close(...closeArgs),
  }
}

const { createLocalFileArtifactAsync } = await import('../../server/services/artifactGen.js')
await createLocalFileArtifactAsync({ sourcePath, filename, publicationKey })
process.exit(70)

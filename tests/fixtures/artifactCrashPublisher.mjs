import fs from 'node:fs'
import path from 'node:path'

const [mode, sourcePath, filename, publicationKey] = process.argv.slice(2)
if (!mode || !sourcePath || !filename || !publicationKey || !process.env.ARTIFACT_DIR) {
  process.exit(64)
}

const originalLink = fs.promises.link
const originalOpen = fs.promises.open
const markerDirectorySegment = `${path.sep}.artifact-publications${path.sep}`

function isOwnershipRecord(target) {
  return String(target || '').includes(markerDirectorySegment)
}

function killWithoutCleanup() {
  process.kill(process.pid, 'SIGKILL')
}

if (mode.startsWith('destination_')) {
  fs.promises.link = async (...args) => {
    const destination = String(args[1] || '')
    if (mode === 'destination_before_claim' && destination.endsWith('.destination.json')) {
      killWithoutCleanup()
      await new Promise(() => {})
    }
    if (isOwnershipRecord(destination)) return originalLink(...args)
    const error = new Error('force exclusive-copy publication for crash recovery')
    error.code = 'EPERM'
    throw error
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

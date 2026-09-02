import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-artifact-pathname-safety-'))
process.env.APP_DATA_DIR = tempRoot
process.env.ARTIFACT_DIR = path.join(tempRoot, 'artifacts')
process.env.YMA_TEST_DATA_ROOT = tempRoot

const { closeDb } = await import('../server/db.js')
const {
  createLocalFileArtifact,
  createLocalFileArtifactAsync,
} = await import('../server/services/artifactLocalPublication.js')

after(() => {
  closeDb()
  fs.rmSync(tempRoot, { force: true, recursive: true })
})

function assertSameFileIdentity(actual, expected) {
  assert.equal(actual.dev, expected.dev)
  assert.equal(actual.ino, expected.ino)
}

test('sync non-stable publication never overwrites a pathname winner after allocation', (t) => {
  const sourcePath = path.join(tempRoot, 'sync-source.txt')
  const requestedPath = path.join(process.env.ARTIFACT_DIR, 'sync-result.txt')
  const sourceContents = 'trusted sync artifact'
  const competitorContents = 'pathname winner'
  fs.writeFileSync(sourcePath, sourceContents)

  const copyFileSync = fs.copyFileSync.bind(fs)
  const observedFlags = []
  let competitorIdentity = null
  t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
    observedFlags.push(flags)
    if (!competitorIdentity) {
      fs.writeFileSync(destination, competitorContents, { flag: 'wx' })
      competitorIdentity = fs.lstatSync(destination, { bigint: true })
    }
    return copyFileSync(source, destination, flags)
  })

  const artifact = createLocalFileArtifact({
    sourcePath,
    filename: 'sync-result.txt',
  })

  assert.equal(artifact.filename, 'sync-result-2.txt')
  assert.equal(fs.readFileSync(requestedPath, 'utf8'), competitorContents)
  assertSameFileIdentity(fs.lstatSync(requestedPath, { bigint: true }), competitorIdentity)
  assert.equal(fs.readFileSync(artifact.fullPath, 'utf8'), sourceContents)
  assert.deepEqual(observedFlags, [fs.constants.COPYFILE_EXCL, fs.constants.COPYFILE_EXCL])
})

test('async non-stable publication never overwrites a pathname winner after allocation', async (t) => {
  const sourcePath = path.join(tempRoot, 'async-source.txt')
  const requestedPath = path.join(process.env.ARTIFACT_DIR, 'async-result.txt')
  const sourceContents = 'trusted async artifact'
  const competitorContents = 'async pathname winner'
  await fs.promises.writeFile(sourcePath, sourceContents)

  const copyFile = fs.promises.copyFile.bind(fs.promises)
  const observedFlags = []
  let competitorIdentity = null
  t.mock.method(fs.promises, 'copyFile', async (source, destination, flags) => {
    observedFlags.push(flags)
    if (!competitorIdentity) {
      await fs.promises.writeFile(destination, competitorContents, { flag: 'wx' })
      competitorIdentity = await fs.promises.lstat(destination, { bigint: true })
    }
    return await copyFile(source, destination, flags)
  })

  const artifact = await createLocalFileArtifactAsync({
    sourcePath,
    filename: 'async-result.txt',
  })

  assert.equal(artifact.filename, 'async-result-2.txt')
  assert.equal(await fs.promises.readFile(requestedPath, 'utf8'), competitorContents)
  assertSameFileIdentity(
    await fs.promises.lstat(requestedPath, { bigint: true }),
    competitorIdentity,
  )
  assert.equal(await fs.promises.readFile(artifact.fullPath, 'utf8'), sourceContents)
  assert.deepEqual(observedFlags, [fs.constants.COPYFILE_EXCL, fs.constants.COPYFILE_EXCL])
})

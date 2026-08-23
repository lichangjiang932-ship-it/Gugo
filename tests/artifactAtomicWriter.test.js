import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeGeneratedArtifactAtomically } from '../server/services/artifactAtomicWriter.js'

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-atomic-writer-'))
}

function temporaryFiles(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))
}

test('generated artifact write failure never exposes a partial final file', () => {
  const directory = fixture()
  const fileSystem = Object.create(fs)
  fileSystem.writeFileSync = (descriptor) => {
    fs.writeSync(descriptor, Buffer.from('partial'))
    const error = new Error('injected artifact write failure')
    error.code = 'EIO'
    throw error
  }

  assert.throws(
    () => writeGeneratedArtifactAtomically({
      artifactDirectory: directory,
      preferredFilename: 'report.pdf',
      contents: Buffer.from('complete'),
      fileSystem,
    }),
    /injected artifact write failure/,
  )
  assert.equal(fs.existsSync(path.join(directory, 'report.pdf')), false)
  assert.deepEqual(temporaryFiles(directory), [])
})

test('generated artifact publication preserves an existing winner and retries a suffix', () => {
  const directory = fixture()
  const winner = path.join(directory, 'report.pdf')
  fs.writeFileSync(winner, 'existing-winner')

  const result = writeGeneratedArtifactAtomically({
    artifactDirectory: directory,
    preferredFilename: 'report.pdf',
    contents: Buffer.from('new-artifact'),
  })

  assert.equal(result.filename, 'report-2.pdf')
  assert.equal(fs.readFileSync(winner, 'utf8'), 'existing-winner')
  assert.equal(fs.readFileSync(result.fullPath, 'utf8'), 'new-artifact')
  assert.deepEqual(temporaryFiles(directory), [])
})

test('a staging cleanup failure after publication does not create a duplicate artifact', () => {
  const directory = fixture()
  const fileSystem = Object.create(fs)
  let injected = false
  fileSystem.unlinkSync = (target) => {
    if (!injected && String(target).endsWith('.tmp')) {
      injected = true
      const error = new Error('injected staging cleanup failure')
      error.code = 'EPERM'
      throw error
    }
    return fs.unlinkSync(target)
  }

  const result = writeGeneratedArtifactAtomically({
    artifactDirectory: directory,
    preferredFilename: 'published.pdf',
    contents: Buffer.from('published-once'),
    fileSystem,
  })

  assert.equal(result.filename, 'published.pdf')
  assert.equal(fs.readFileSync(result.fullPath, 'utf8'), 'published-once')
  assert.deepEqual(fs.readdirSync(directory), ['published.pdf'])
})

test('exclusive-copy fallback failure cleans staging without creating the final pathname', () => {
  const directory = fixture()
  const fileSystem = Object.create(fs)
  fileSystem.linkSync = () => {
    const error = new Error('hard links unavailable')
    error.code = 'EPERM'
    throw error
  }
  fileSystem.copyFileSync = () => {
    const error = new Error('injected exclusive-copy failure')
    error.code = 'EIO'
    throw error
  }

  assert.throws(
    () => writeGeneratedArtifactAtomically({
      artifactDirectory: directory,
      preferredFilename: 'deck.pptx',
      contents: Buffer.from('complete-deck'),
      fileSystem,
    }),
    /injected exclusive-copy failure/,
  )
  assert.equal(fs.existsSync(path.join(directory, 'deck.pptx')), false)
  assert.deepEqual(temporaryFiles(directory), [])
})

test('exclusive-copy fallback preserves a concurrent winner and retries a suffix', () => {
  const directory = fixture()
  const fileSystem = Object.create(fs)
  const originalCopyFileSync = fs.copyFileSync
  let injected = false
  fileSystem.linkSync = () => {
    const error = new Error('hard links unavailable')
    error.code = 'EPERM'
    throw error
  }
  fileSystem.copyFileSync = (source, target, flags) => {
    if (!injected && path.basename(target) === 'race.pdf') {
      injected = true
      fs.writeFileSync(target, 'concurrent-winner', { flag: 'wx' })
    }
    return originalCopyFileSync(source, target, flags)
  }

  const result = writeGeneratedArtifactAtomically({
    artifactDirectory: directory,
    preferredFilename: 'race.pdf',
    contents: Buffer.from('generated-artifact'),
    fileSystem,
  })

  assert.equal(injected, true)
  assert.equal(fs.readFileSync(path.join(directory, 'race.pdf'), 'utf8'), 'concurrent-winner')
  assert.equal(result.filename, 'race-2.pdf')
  assert.equal(fs.readFileSync(result.fullPath, 'utf8'), 'generated-artifact')
  assert.deepEqual(temporaryFiles(directory), [])
})

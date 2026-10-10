import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// A delivered file is also published to the artifact store. When the file at its
// original path is later moved or deleted, its link used to 404 ("文件预览失败
// (404)") even though the app still held an exact copy; the desktop app showed
// exactly that for conversations whose output folder had been cleaned up.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-stored-copy-'))
const artifactDir = path.join(tempDir, 'artifacts')
const outputDir = path.join(tempDir, 'output')
fs.mkdirSync(artifactDir)
fs.mkdirSync(outputDir)
const saved = { APP_DATA_DIR: process.env.APP_DATA_DIR, ARTIFACT_DIR: process.env.ARTIFACT_DIR, WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED }
process.env.APP_DATA_DIR = tempDir
process.env.ARTIFACT_DIR = artifactDir
process.env.WORKSPACE_FS_ENABLED = '1'

const { closeDb } = await import('../server/db.js')
const { upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnArtifact } = await import('../server/services/turnArtifactStore.js')
const { getArtifactDir } = await import('../server/services/artifactStorage.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { getVerifiedLocalFile } = await import('../server/services/verifiedLocalFileService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const DECK = Buffer.from('PK\u0003\u0004 synthetic deck bytes')

function fixture(name) {
  const { userId } = issueTestSession({ email: `${name}@example.test` })
  grantLocalPath({ userId, rootPath: outputDir, accessMode: 'read_only' })
  const sessionId = `${name}-session`
  upsertSession({ id: sessionId, userId, title: name })
  const turnId = `${name}-turn`
  const original = path.join(outputDir, `${name}.pptx`)
  fs.writeFileSync(original, DECK)
  fs.writeFileSync(path.join(getArtifactDir(), `${name}.pptx`), DECK)
  appendTurnArtifact({ id: `${name}-artifact`, userId, sessionId, turnId, type: 'pptx', title: name,
    url: `/api/artifacts/${name}.pptx`, filename: `${name}.pptx` })
  const receipt = { id: `${name}-receipt`, path: original, filename: `${name}.pptx`, size: DECK.length, relatedArtifactIds: [`${name}-artifact`] }
  upsertMessage({ id: `${turnId}:assistant`, userId, sessionId, role: 'assistant', content: 'done',
    modelContext: { version: 1, turnId, verifiedLocalFiles: [receipt] } })
  return { userId, sessionId, turnId, receipt, original }
}

test('a link whose original file is gone serves the copy the app kept of it', () => {
  const { userId, sessionId, turnId, receipt, original } = fixture('moved-deck')
  assert.equal(getVerifiedLocalFile({ userId, sessionId, turnId, fileId: receipt.id }).fullPath, fs.realpathSync(original))
  fs.rmSync(original)
  const file = getVerifiedLocalFile({ userId, sessionId, turnId, fileId: receipt.id })
  assert.equal(file.storedCopy, true)
  assert.equal(file.filename, 'moved-deck.pptx', 'the reader still sees the file under its own name')
  assert.deepEqual(fs.readFileSync(file.fullPath), DECK)
})

test('a stored file of the same name but different bytes never stands in', () => {
  const { userId, sessionId, turnId, receipt, original } = fixture('changed-deck')
  fs.writeFileSync(path.join(getArtifactDir(), 'changed-deck.pptx'), Buffer.from('different'))
  fs.rmSync(original)
  assert.throws(() => getVerifiedLocalFile({ userId, sessionId, turnId, fileId: receipt.id }),
    (error) => error.statusCode === 404 && /移动或删除/u.test(error.message))
})

test("another user's turn cannot reach the copy", () => {
  const { sessionId, turnId, receipt, original } = fixture('private-deck')
  fs.rmSync(original)
  const { userId: stranger } = issueTestSession({ email: 'stored-copy-stranger@example.test' })
  assert.throws(() => getVerifiedLocalFile({ userId: stranger, sessionId, turnId, fileId: receipt.id }),
    (error) => error.statusCode === 404)
})

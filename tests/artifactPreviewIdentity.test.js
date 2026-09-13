import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

process.env.GUGO_LOAD_DOTENV = '0'
const initialCwd = process.cwd()
process.chdir(process.env.APP_DATA_DIR)
const { artifactPreviewIdentity } = await import('../server/services/artifactPreviewIdentity.js')
const { closeDb, createUser } = await import('../server/db.js')
const { appendTurnArtifact, getTurnArtifactById, listTurnArtifacts } = await import('../server/services/turnArtifactStore.js')
const { mapArtifact: mapJobArtifact } = await import('../server/services/jobStoreProjection.js')
const { getSessionSnapshot, upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
const { createPptx } = await import('../server/services/artifactGen.js')
const { publishedArtifactResult } = await import('../server/services/loop/heuristics/artifactPublishing.js')
const { createTurnEvent, parseTurnEvent } = await import('../shared/turnEvents.js')
test.after(() => { closeDb(); process.chdir(initialCwd) })

let counter = 0
function fixture(type = 'pptx') {
  const id = `preview-identity-${++counter}`
  const filename = `${id}.${type}`
  const artifact = { id, type, title: id, filename, url: `/api/artifacts/${filename}`,
    fullPath: path.join(process.env.ARTIFACT_DIR, filename) }
  fs.writeFileSync(artifact.fullPath, 'first revision')
  return artifact
}

test('PPT preview identity is stable on reads and changes at the same id, URL and filename', () => {
  const artifact = fixture()
  const before = artifactPreviewIdentity(artifact)
  assert.match(before.previewRevision, /^[a-f0-9]{64}$/u)
  assert.deepEqual(artifactPreviewIdentity(artifact), before)
  assert.deepEqual(Object.keys(before), ['previewRevision'])
  assert.notEqual(before.previewRevision, createHash('sha256').update(fs.readFileSync(artifact.fullPath)).digest('hex'),
    'the preview token is not a digest of the document contents')
  const identity = { id: artifact.id, url: artifact.url, filename: artifact.filename }
  fs.writeFileSync(artifact.fullPath, 'other revision')
  fs.utimesSync(artifact.fullPath, new Date('2024-01-01'), new Date('2024-01-02'))
  const after = artifactPreviewIdentity(artifact)
  assert.notEqual(after.previewRevision, before.previewRevision)
  assert.deepEqual({ id: artifact.id, url: artifact.url, filename: artifact.filename }, identity)
})

test('missing and non-PPT artifacts retain their existing DTO shape without creating directories', () => {
  const absent = path.join(process.env.APP_DATA_DIR, 'does-not-exist')
  assert.deepEqual(artifactPreviewIdentity({ filename: 'missing.pptx', type: 'pptx' }, { artifactDirectory: absent }), {})
  assert.equal(fs.existsSync(absent), false)
  assert.deepEqual(artifactPreviewIdentity(fixture('pdf')), {})
  assert.deepEqual(artifactPreviewIdentity(fixture('docx')), {})
  assert.deepEqual(artifactPreviewIdentity({ filename: 'missing.pptx', type: 'pptx' }), {})
})

test('unsafe filenames and declared external paths never read an external file stat', () => {
  let inspected = 0
  const noInspection = { realpathSync: () => { inspected += 1; throw new Error('unexpected read') } }
  for (const filename of ['../outside.pptx', '..\\outside.pptx', 'dir/deck.pptx', 'deck.pptx:secret', 'deck.pdf']) {
    assert.deepEqual(artifactPreviewIdentity({ filename, type: 'pptx' }, { fileSystem: noInspection }), {})
  }
  assert.equal(inspected, 0)
  const artifact = fixture()
  const fileStats = []
  const fileSystem = { ...fs, lstatSync: (target, options) => {
    fileStats.push(target)
    return fs.lstatSync(target, options)
  } }
  assert.deepEqual(artifactPreviewIdentity({ ...artifact, fullPath: path.join(process.env.APP_DATA_DIR, artifact.filename) }, { fileSystem }), {})
  assert.deepEqual(fileStats, [])
})

test('symbolic-link and inaccessible file metadata degrade without following a target or throwing', () => {
  const artifact = fixture()
  const canonicalized = []
  const symlinkFileSystem = { ...fs,
    realpathSync: target => { canonicalized.push(target); return fs.realpathSync(target) },
    lstatSync: (target, options) => {
      const stat = fs.lstatSync(target, options)
      stat.isSymbolicLink = () => true
      return stat
    },
  }
  assert.deepEqual(artifactPreviewIdentity(artifact, { fileSystem: symlinkFileSystem }), {})
  assert.deepEqual(canonicalized, [path.resolve(process.env.ARTIFACT_DIR)])
  assert.deepEqual(artifactPreviewIdentity(artifact, { fileSystem: {
    ...fs, lstatSync: () => { throw Object.assign(new Error('unavailable'), { code: 'EACCES' }) },
  } }), {})
})

test('BigInt ctime and inode changes invalidate equal-size/equal-mtime previews without reading content', () => {
  let stat = { dev: 1n, ino: 2n, size: 50n, mtimeNs: 10n, ctimeNs: 20n,
    isFile: () => true, isSymbolicLink: () => false }
  const fileSystem = { realpathSync: target => target, lstatSync: () => stat }
  const artifact = { type: 'pptx', filename: 'same.pptx' }
  const first = artifactPreviewIdentity(artifact, { fileSystem })
  stat = { ...stat, ctimeNs: 21n }
  const changed = artifactPreviewIdentity(artifact, { fileSystem })
  assert.notEqual(changed.previewRevision, first.previewRevision)
  stat = { ...stat, ino: 3n }
  assert.notEqual(artifactPreviewIdentity(artifact, { fileSystem }).previewRevision, changed.previewRevision)
})

test('turn DTOs, session snapshots and job DTOs expose current PPT revision without mutating stored identity', () => {
  const artifact = fixture()
  const scope = { userId: `${artifact.id}-user`, sessionId: `${artifact.id}-session`, turnId: `${artifact.id}-turn` }
  createUser({ id: scope.userId, email: `${artifact.id}@example.com` })
  upsertSession({ id: scope.sessionId, userId: scope.userId, title: 'Preview identity fixture' })
  appendTurnArtifact({ ...artifact, ...scope, createdAt: 100 })
  upsertMessage({ id: `${scope.turnId}:assistant`, userId: scope.userId, sessionId: scope.sessionId,
    role: 'assistant', content: 'Generated fixture.', modelContext: { turnId: scope.turnId } })
  const jobRow = { id: artifact.id, user_id: scope.userId, job_id: 'preview-job', step_id: null,
    type: artifact.type, title: 'PPT', url: artifact.url, filename: artifact.filename, created_at: 100 }
  const read = () => ({
    turn: getTurnArtifactById({ id: artifact.id, ...scope }),
    listed: listTurnArtifacts(scope)[0],
    snapshot: getSessionSnapshot(scope).messages.find(message => message.role === 'assistant').artifacts[0],
    job: mapJobArtifact(jobRow),
  })
  const first = read()
  for (const item of Object.values(first)) assert.equal(item.previewRevision, first.turn.previewRevision)
  fs.writeFileSync(artifact.fullPath, 'updated fixture document')
  fs.utimesSync(artifact.fullPath, new Date('2024-02-01'), new Date('2024-02-02'))
  const second = read()
  for (const [source, item] of Object.entries(second)) {
    assert.match(item.previewRevision, /^[a-f0-9]{64}$/u)
    assert.notEqual(item.previewRevision, first[source].previewRevision)
    assert.equal(item.id, first[source].id)
    assert.equal(item.url, first[source].url)
    assert.equal(item.createdAt, first[source].createdAt)
  }
  assert.equal(getTurnArtifactById({ id: artifact.id, ...scope, userId: 'another-owner' }), null)
})

test('current PPT result and strict tool-completed events carry preview revision without verification semantics', async () => {
  const userId = 'preview-current-result-user'
  createUser({ id: userId, email: 'preview-current-result@example.com' })
  const args = { title: 'Preview revision', slides: [{ title: 'Fixture', bullets: ['Preview metadata only.'] }] }
  const artifact = await createPptx({ ...args, userId })
  const result = publishedArtifactResult({ name: 'create_pptx', artifact, args, job: { userId } })
  assert.equal(result.ok, true)
  assert.equal(result.previewRevision, artifactPreviewIdentity(artifact).previewRevision)
  assert.equal(result.userConfirmed, undefined)
  const entry = { id: artifact.id, filename: artifact.filename, type: artifact.type, url: artifact.url,
    previewRevision: result.previewRevision }
  const event = createTurnEvent({ id: 'preview-event', sessionId: 'preview-session', turnId: 'preview-turn', sequence: 1,
    type: 'tool.completed', payload: { toolCallId: 'preview-call', name: 'create_pptx', result,
      artifactId: artifact.id, artifacts: [entry] } })
  const decoded = parseTurnEvent(JSON.parse(JSON.stringify(event)))
  assert.equal(decoded.payload.result.previewRevision, result.previewRevision)
  assert.equal(decoded.payload.artifacts[0].previewRevision, result.previewRevision)
  assert.equal(decoded.payload.artifacts[0].verified, undefined)
  assert.throws(() => createTurnEvent({ ...event, payload: { ...event.payload,
    artifacts: [{ ...entry, previewRevision: 'not-a-cache-token' }] } }))
  const legacy = { ...entry }
  delete legacy.previewRevision
  assert.doesNotThrow(() => createTurnEvent({ ...event, payload: { ...event.payload, artifacts: [legacy] } }))
})

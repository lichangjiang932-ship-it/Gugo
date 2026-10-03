import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import PptxGenJS from 'pptxgenjs'

const tempParent = fs.realpathSync(os.tmpdir())
const root = fs.mkdtempSync(path.join(tempParent, 'gugo-binary-link-evidence-'))
const workspace = path.join(root, 'workspace')
const isolatedEnv = {
  APP_DATA_DIR: path.join(root, 'data'), APP_DB_PATH: path.join(root, 'data', 'app.db'),
  APP_CONFIG_PATH: path.join(root, 'config', 'runtime.json'), ARTIFACT_DIR: path.join(root, 'artifacts'),
  WORKSPACE_ROOT: workspace, WORKSPACE_FS_ENABLED: '1', WORKSPACE_SHARED_TRUSTED: '1',
  YMA_TEST_DEFAULT_OUTPUT_DIR: path.join(root, 'output'), GUGO_LOAD_DOTENV: '0',
  HOME: path.join(root, 'token-home'), USERPROFILE: path.join(root, 'token-home'),
}
const previousEnv = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]))
for (const directory of ['data', 'config', 'artifacts', 'workspace', 'output', 'token-home']) {
  fs.mkdirSync(path.join(root, directory), { recursive: true })
}
Object.assign(process.env, isolatedEnv)

const { getDb, closeDb, createUser } = await import('../server/db.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent, listTurnEvents } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { persistLocalToolArtifactsAsync } = await import('../server/services/loop/heuristics/toolSelection.js')
const { createTurnBinaryArtifactEvidence } = await import('../server/services/turnBinaryArtifactEvidence.js')
const { extractVerifiedLocalFiles, extractRetainedLocalFiles } = await import('../server/services/turnMessageLocalFileEvidence.js')
const { createTurnTerminalEvidenceRuntime } = await import('../server/services/turnTerminalEvidenceRuntime.js')

const userId = 'binary-link-user'
const sessionId = 'binary-link-session'
createUser({ id: userId, email: 'binary-link@example.test' })
upsertSession({ id: sessionId, userId, title: 'Isolated binary projection' })
createUser({ id: 'other-user', email: 'binary-link-other@example.test' })
upsertSession({ id: 'other-session', userId: 'other-user', title: 'Other isolated scope' })
const deck = new PptxGenJS()
deck.addSlide().addText('Receipt-bound final artifact', { x: 1, y: 1, w: 7, h: 1 })
const pptxBytes = Buffer.from(await deck.write({ outputType: 'nodebuffer' }))

test.after(() => {
  closeDb()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(path.dirname(fs.realpathSync(root)), tempParent)
  assert.ok(path.basename(root).startsWith('gugo-binary-link-evidence-'))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function messagesFor(call, result) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
    { role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(result) },
  ]
}

async function fixture({ persist = true, name = 'run_command' } = {}) {
  const turnId = `binary-turn-${randomUUID()}`
  const scope = { userId, sessionId, turnId }
  appendTurnEvent({ userId, event: createTurnEvent({
    id: randomUUID(), sessionId, turnId, sequence: 0, createdAt: Date.now(),
    type: 'turn.started', payload: { model: 'binary-fixture' },
  }) })
  const sourcePath = path.join(workspace, `${turnId}.pptx`)
  fs.writeFileSync(sourcePath, pptxBytes)
  const call = { id: `call-${randomUUID()}`, name,
    args: { command: 'fixture producer already completed', cwd: workspace, expected_outputs: [sourcePath] } }
  const result = { ok: true, exitCode: 0, cwd: workspace, changedPaths: [sourcePath],
    verifiedOutputs: [{ type: 'file', path: sourcePath, declaredPath: sourcePath, change: 'created', size: pptxBytes.length }] }
  // This is the actual host format validator, immutable artifact publication,
  // and same-turn artifact registration path, not a fabricated receipt.
  const artifacts = await persistLocalToolArtifactsAsync({ call, result,
    job: { id: turnId, userId, sessionId, origin: 'chat' }, step: { id: turnId }, toolCallId: call.id })
  assert.equal(artifacts.length, 1, JSON.stringify(artifacts.publicationFailures))
  assert.equal(artifacts.verificationReceipts.length, 1)
  assert.equal(artifacts.verificationReceipts[0].format, 'pptx')
  Object.assign(result, { artifactId: artifacts[0].id, filename: artifacts[0].filename, url: artifacts[0].url,
    artifacts: artifacts.map(({ id, filename, type, url }) => ({ id, filename, type, url })),
    artifactValidation: { ok: true, receipts: artifacts.verificationReceipts.map((receipt) => ({ ...receipt })) } })
  let sequence = 1
  const persistResult = (value = result, overrides = {}) => appendTurnEvent({ userId, event: createTurnEvent({
    id: randomUUID(), sessionId, turnId, sequence: sequence++, createdAt: Date.now(), type: 'tool.completed',
    payload: { name: call.name, toolCallId: call.id, args: call.args, result: value, ...overrides },
  }) })
  if (persist) persistResult()
  return { scope, call, result, sourcePath, managedPath: artifacts[0].fullPath, persistResult,
    messages: () => messagesFor(call, result),
    proof: (options = {}) => createTurnBinaryArtifactEvidence({ scope, replayEvents: listTurnEvents, ...options }),
    updateRegistration(column, value) {
      assert.ok(['id', 'user_id', 'session_id', 'turn_id', 'filename', 'type', 'url'].includes(column))
      assert.equal(process.env.APP_DB_PATH, path.join(root, 'data', 'app.db'))
      getDb().prepare(`UPDATE turn_artifacts SET ${column} = ? WHERE id = ? AND user_id = ?`)
        .run(value, result.artifactId, userId)
    },
  }
}

function verified(f, options = {}, messages = f.messages()) {
  return extractVerifiedLocalFiles(messages, { userId, verifiedAt: 1234, binaryArtifactEvidence: f.proof(), ...options })
}

function remainsRetained(f, options = {}, messages = f.messages()) {
  assert.deepEqual(verified(f, options, messages), [])
  const retained = extractRetainedLocalFiles(messages, { userId, retainedAt: 1234 })
  assert.equal(retained.length, 1)
  assert.equal(retained[0].path, f.sourcePath)
}

test('a real host PPT receipt upgrades only its exact local path and exposes the registered artifact relation', async () => {
  const f = await fixture()
  const [receipt] = verified(f)
  assert.equal(receipt.path, f.sourcePath)
  assert.equal(receipt.size, pptxBytes.length)
  assert.equal(receipt.verifiedAt, 1234)
  assert.deepEqual(receipt.relatedArtifactIds, [f.result.artifactId])
  // The trace's self-reported receipt is not the authority, nor is its presence
  // required once the host independently has the canonical publication proof.
  const traceWithoutReceipt = { ...f.result }
  delete traceWithoutReceipt.artifactValidation
  assert.equal(verified(f, {}, messagesFor(f.call, traceWithoutReceipt)).length, 1)
})

test('new terminal projection consumes the scoped host proof and removes the duplicate retained link', async () => {
  const f = await fixture({ name: 'bash_exec' })
  const evidence = createTurnTerminalEvidenceRuntime({
    scope: f.scope, now: () => 1234, emitter: async () => {}, writeMessage: async () => {},
    writeRecoveryFailure: async () => {}, recordCanaryTerminal: async () => {},
    readState: () => ({ checkpointMessages: f.messages(), baselineToolCallIds: new Set() }),
    replayEvents: listTurnEvents,
  })
  const files = evidence.verifiedLocalFilesAt(1234)
  assert.equal(files.length, 1)
  assert.deepEqual(evidence.retainedLocalFilesAt(1234, files), [])
  const message = evidence.projectEvidence({ state: 'completed', text: 'Complete.',
    artifactIds: [f.result.artifactId], deliveryArtifactIds: [f.result.artifactId] })
  assert.equal(message.modelContext.verifiedLocalFiles[0].path, f.sourcePath)
  assert.deepEqual(message.modelContext.retainedLocalFiles, [])
})

test('canonical binary evidence survives a compacted trace without rewriting the historical messages', async () => {
  const f = await fixture()
  const messages = [{ role: 'system', content: 'Earlier messages were compacted.' }]
  const before = structuredClone(messages)
  const files = verified(f, {}, messages)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, f.sourcePath)
  assert.deepEqual(files[0].relatedArtifactIds, [f.result.artifactId])
  assert.deepEqual(messages, before)
  assert.deepEqual(verified(f, { binaryArtifactEvidence: null }, messages), [])
})

test('missing, unknown, wrapped, or JSON-forged persistence capabilities never consult global evidence', async () => {
  const f = await fixture()
  remainsRetained(f, { binaryArtifactEvidence: null })
  remainsRetained(f, { binaryArtifactEvidence: {} })
  remainsRetained(f, { binaryArtifactEvidence: JSON.parse(JSON.stringify(f.proof())) })
  let reads = 0
  for (const replayEvents of [null, () => { reads += 1; return listTurnEvents(f.scope) }]) {
    assert.equal(f.proof({ replayEvents }), null)
    remainsRetained(f, { binaryArtifactEvidence: f.proof({ replayEvents }) })
  }
  assert.equal(reads, 0)
  assert.equal(f.proof({ scope: { userId } }), null)
})

test('a valid-looking imported receipt without the canonical tool completion remains retained', async () => {
  const f = await fixture({ persist: false })
  remainsRetained(f)
  const alteredCall = { ...f.call, id: 'imported-not-executed' }
  f.persistResult()
  remainsRetained(f, {}, messagesFor(alteredCall, { ...f.result }))
})

const invalidReceiptCases = [
  ['other user', (receipt) => { receipt.userId = 'foreign-user' }],
  ['other session', (receipt) => { receipt.sessionId = 'foreign-session' }],
  ['other turn', (receipt) => { receipt.turnId = 'foreign-turn' }],
  ['other tool call', (receipt) => { receipt.toolCallId = 'foreign-call' }],
  ['other candidate index', (receipt) => { receipt.candidateIndex += 1 }],
  ['other artifact id', (receipt) => { receipt.artifactId = 'local-forged' }],
  ['other source path', (receipt) => { receipt.sourcePath += '.other' }],
  ['other declared path', (receipt) => { receipt.declaredPath += '.other' }],
  ['other managed path', (receipt) => { receipt.artifactPath += '.other' }],
  ['other filename', (receipt) => { receipt.filename = 'other.pptx' }],
  ['other content digest', (receipt) => { receipt.sha256 = '0'.repeat(64) }],
  ['other content size', (receipt) => { receipt.byteLength += 1 }],
  ['no format verification', (receipt) => { receipt.verified = false }],
  ['self-reported verifier', (receipt) => { receipt.verifier = 'model_claim' }],
  ['unknown verifier version', (receipt) => { receipt.verifierVersion = 2 }],
  ['unmatched format', (receipt) => { receipt.format = 'pdf' }],
]
for (const [label, invalidate] of invalidReceiptCases) {
  test(`binary projection rejects ${label} in a canonical receipt`, async () => {
    const f = await fixture({ persist: false })
    const invalid = structuredClone(f.result)
    invalidate(invalid.artifactValidation.receipts[0])
    f.persistResult(invalid)
    remainsRetained(f)
  })
}

test('another scoped turn cannot adopt an earlier turn artifact even with the entire genuine trace', async () => {
  const f = await fixture()
  remainsRetained(f, { binaryArtifactEvidence: f.proof({ scope: { ...f.scope, turnId: 'a-new-turn' } }) })
  remainsRetained(f, { binaryArtifactEvidence: f.proof({ scope: { ...f.scope, sessionId: 'a-new-session' } }) })
  remainsRetained(f, { binaryArtifactEvidence: f.proof({ scope: { ...f.scope, userId: 'a-new-user' } }) })
})

for (const [column, value] of [['turn_id', 'other-turn'], ['user_id', 'other-user'], ['session_id', 'other-session'], ['filename', 'other.pptx'],
  ['type', 'docx'], ['url', '/api/artifacts/unregistered.pptx'], ['id', 'different-artifact-id']]) {
  test(`registered artifact ${column} drift cannot be hidden by a valid receipt`, async () => {
    const f = await fixture()
    f.updateRegistration(column, value)
    remainsRetained(f)
  })
}

for (const target of ['sourcePath', 'managedPath']) {
  test(`same-size ${target} content changes invalidate the binary projection`, async () => {
    const f = await fixture()
    const changed = Buffer.from(pptxBytes)
    changed[changed.length - 1] ^= 1
    fs.writeFileSync(f[target], changed)
    remainsRetained(f)
  })
}

test('publication failure, UNKNOWN, missing metadata, or duplicate canonical identities stay retained', async () => {
  for (const invalidate of [
    (result) => { result.artifactPublication = { ok: false } },
    (result) => { result.code = 'SIDE_EFFECT_OUTCOME_UNKNOWN' },
    (result) => { result.artifactValidation.ok = false },
    (result) => { result.artifacts = [] },
    (result) => { result.changedPaths = [] },
  ]) {
    const f = await fixture({ persist: false })
    const invalid = structuredClone(f.result)
    invalidate(invalid)
    f.persistResult(invalid)
    remainsRetained(f)
  }
  const duplicate = await fixture()
  duplicate.persistResult()
  remainsRetained(duplicate)
})

test('host proof never bypasses local path authorization or stale mutation invalidation', async () => {
  const f = await fixture()
  assert.deepEqual(verified(f, { resolvePath() { throw new Error('access revoked') } }), [])
  const laterCall = { ...f.call, id: 'later-unverified-write' }
  const laterResult = { ok: true, changedPaths: [f.sourcePath] }
  remainsRetained(f, {}, [...f.messages(), ...messagesFor(laterCall, laterResult)])
  assert.deepEqual(verified(f, { baselineToolCallIds: new Set([f.call.id]) }), [])
})

test('an opaque canonical snapshot never caches a permanent file-validation badge', async () => {
  const f = await fixture()
  const proof = f.proof()
  assert.equal(verified(f, { binaryArtifactEvidence: proof }).length, 1)
  const changed = Buffer.from(pptxBytes)
  changed[changed.length - 1] ^= 1
  fs.writeFileSync(f.sourcePath, changed)
  remainsRetained(f, { binaryArtifactEvidence: proof })
})

test('a source changed while its descriptor is being hashed cannot receive a verified link', async (t) => {
  const f = await fixture()
  const nativeOpen = fs.openSync
  const nativeRead = fs.readSync
  let sourceFd = null
  let changedDuringRead = false
  t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    const fd = nativeOpen(file, flags, ...rest)
    if (file === f.sourcePath && flags === 'r') sourceFd = fd
    return fd
  })
  t.mock.method(fs, 'readSync', (fd, ...args) => {
    const length = nativeRead(fd, ...args)
    if (fd === sourceFd && !changedDuringRead) {
      changedDuringRead = true
      const changed = Buffer.from(pptxBytes)
      changed[changed.length - 1] ^= 1
      fs.writeFileSync(f.sourcePath, changed)
    }
    return length
  })
  remainsRetained(f)
  assert.equal(changedDuringRead, true)
})

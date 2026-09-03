import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-user-data-governance-'))
const dataDir = path.join(tempDir, 'data')
const artifactDir = path.join(tempDir, 'artifacts')
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')
process.env.ARTIFACT_DIR = artifactDir
process.env.CREDENTIAL_KEY_PATH = path.join(dataDir, '.credentials.key')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const {
  enqueueAgentEventOutboxInDb,
} = await import('../server/services/agentEventOutboxStore.js')
const { createManagedAttachment } = await import('../server/services/managedAttachmentStore.js')
const { appendJobArtifact } = await import('../server/services/jobStore.js')
const { appendTurnArtifact } = await import('../server/services/turnArtifactStore.js')
const {
  recordTurnEmergencyFailure,
} = await import('../server/services/turnEmergencyFailureJournal.js')
const {
  decodeSessionContentRecord,
  projectSessionContentEvents,
  resolveSessionContentPath,
} = await import('../server/services/sessionJsonlCodec.js')
const {
  enqueueSessionContentEventInDb,
} = await import('../server/services/sessionContentOutboxStore.js')
const {
  rollbackManagedDeletionStage,
  stageManagedDeletionDomain,
} = await import('../server/services/userDataManagedFileCatalog.js')
const {
  _testing: compactionArchiveTesting,
  createCompactionArchiveRecord,
  getCompactionArchiveRecord,
  resolveCompactionArchiveStorage,
} = await import('../server/services/compactionArchiveStore.js')
const {
  USER_DATA_CLEAR_CONFIRMATION,
  buildAuthoritativeUserDataSnapshot: buildAuthoritativeUserDataSnapshotService,
  clearAuthoritativeUserData: clearAuthoritativeUserDataService,
  createAuthoritativeUserDataArchive,
} = await import('../server/services/userDataGovernanceService.js')
const { acquireCompactionArchivePort } = await import('../server/core/compactionArchivePort.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const {
  activateTestCompactionArchivePort,
} = await import('./helpers/testCompactionArchivePort.js')

const compactionArchiveController = activateTestCompactionArchivePort({ env: process.env })

function buildAuthoritativeUserDataSnapshot(options) {
  const lease = acquireCompactionArchivePort()
  try {
    const snapshot = buildAuthoritativeUserDataSnapshotService({
      ...options,
      compactionArchivePort: lease.port,
    })
    snapshot.compactionExport.releaseSnapshot()
    return snapshot
  } finally {
    lease.release()
  }
}

// Most cases in this lower-level fault-injection suite exercise the physical
// clear machinery directly. The public/service default is verified separately
// and remains fail-closed; bypassing preview here must always be explicit.
function clearAuthoritativeUserData(options) {
  return clearAuthoritativeUserDataService({ requirePreview: false, ...options })
}

const db = getDb()
const now = Date.now()

function userBucket(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)
}

function artifactSidecarPaths(artifactId) {
  const digest = crypto.createHash('sha256').update(String(artifactId)).digest('hex')
  return {
    source: path.join(artifactDir, '.artifact-sources', `${digest}.json`),
    html: path.join(artifactDir, '.html-artifact-assets', digest),
  }
}

async function archiveToBuffer(archive) {
  return new Promise((resolve, reject) => {
    const chunks = []
    archive.stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    archive.stream.once('error', reject)
    archive.stream.once('end', () => resolve(Buffer.concat(chunks)))
  })
}

function emergencyJournalRecord(id, entries) {
  return {
    schemaVersion: 1,
    id,
    failedAt: now,
    attempts: 1,
    blocked: false,
    error: { name: 'Error', code: 'TEST_FAILURE', message: 'test failure' },
    journalError: null,
    entries,
  }
}

function writeEmergencyJournal(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    mode: 0o600,
  })
}

function readEmergencyJournal(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
}

function dbWithBeforeTransaction(beforeTransaction) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'transaction') {
        return (callback, ...args) => {
          const transaction = target.transaction(callback, ...args)
          const observe = (runner) => (...parameters) => {
            beforeTransaction()
            return runner(...parameters)
          }
          const wrapped = observe(transaction)
          for (const mode of ['deferred', 'immediate', 'exclusive']) {
            if (typeof transaction[mode] === 'function') {
              wrapped[mode] = observe(transaction[mode])
            }
          }
          return wrapped
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function insertUserFixture(userId, marker) {
  createUser({ id: userId, email: `${marker}@example.com` })
  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(`auth-${marker}`, userId, now + 60_000, now)
  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at, created_at, id, title, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`chat-${marker}`, userId, now + 60_000, now, `chat-${marker}`, `Chat ${marker}`, now)
  db.prepare(`
    INSERT INTO messages
      (id, session_id, user_id, role, content, session_title, created_at, updated_at)
    VALUES (?, ?, ?, 'user', ?, ?, ?, ?)
  `).run(`message-${marker}`, `chat-${marker}`, userId, `content-${marker}`, `Chat ${marker}`, now, now)
  db.prepare(`
    INSERT INTO jobs
      (id, user_id, title, prompt, status, progress, cancel_requested, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'completed', 100, 0, ?, ?)
  `).run(`job-${marker}`, userId, `Job ${marker}`, `prompt-${marker}`, now, now)
}

function insertCompactionClearJournal({
  operationId,
  userId,
  status = 'staging',
  portId = null,
  governanceVersion = null,
  digest = null,
  stageToken = null,
}) {
  const timestamp = Date.now()
  db.prepare(`
    INSERT INTO user_data_clear_operations
      (operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
       status, operation_kind, session_id, compaction_port_id,
       compaction_governance_version, compaction_digest,
       compaction_stage_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'user_clear', NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    operationId,
    userId,
    `compaction-recovery-test-${operationId}`,
    2_147_483_647,
    timestamp - 1,
    status,
    portId,
    governanceVersion,
    digest,
    stageToken,
    timestamp,
    timestamp,
  )
}

function activeCompactionPortIdentity() {
  const lease = acquireCompactionArchivePort()
  try {
    return {
      portId: lease.port.id,
      governanceVersion: lease.port.governanceApiVersion,
    }
  } finally {
    lease.release()
  }
}

function createTerminalCompactionDeletion({ userId, operationId, terminalState }) {
  const lease = acquireCompactionArchivePort()
  try {
    const preview = lease.port.previewDeletion({ userId, scope: { kind: 'user' } })
    const staged = lease.port.stageDeletion({
      userId,
      scope: { kind: 'user' },
      operationId,
      expectedDigest: preview.digest,
    })
    const receipt = {
      userId,
      operationId,
      stageToken: staged.stageToken,
      digest: staged.digest,
    }
    if (terminalState === 'committed') lease.port.commitDeletion(receipt)
    else lease.port.rollbackDeletion(receipt)
    return {
      portId: lease.port.id,
      governanceVersion: lease.port.governanceApiVersion,
      digest: receipt.digest,
      stageToken: receipt.stageToken,
    }
  } finally {
    lease.release()
  }
}

function insertSideEffectFixture(userId, marker, status = 'unknown') {
  db.prepare(`
    INSERT INTO side_effect_executions (
      owner_id, scope_kind, scope_key, session_id, turn_id, job_id, step_id,
      tool_call_id, idempotency_key, tool_name, args_digest, status,
      outcome_json, created_at, updated_at, prepared_at, executing_at, finished_at
    ) VALUES (?, 'job', ?, NULL, NULL, ?, ?, ?, ?, 'write_file', ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    userId,
    JSON.stringify(['job', `job-${marker}`, `step-${marker}`]),
    `job-${marker}`,
    `step-${marker}`,
    `call-${marker}`,
    `job:job-${marker}:step:step-${marker}:tool:call-${marker}`,
    crypto.createHash('sha256').update(marker).digest('hex'),
    status,
    now,
    now,
    now,
    status === 'prepared' ? null : now,
    status === 'unknown' ? now : null,
  )
}

insertUserFixture('user-export-a', 'a')
insertUserFixture('user-export-b', 'b')
insertSideEffectFixture('user-export-a', 'a')
insertSideEffectFixture('user-export-b', 'b')

fs.mkdirSync(artifactDir, { recursive: true })
fs.writeFileSync(path.join(artifactDir, 'artifact-a.txt'), 'artifact-content-a')
db.prepare(`
  INSERT INTO job_artifacts
    (id, job_id, user_id, type, title, url, filename, created_at)
  VALUES (?, ?, ?, 'text', 'Artifact A', ?, ?, ?)
`).run('artifact-row-a', 'job-a', 'user-export-a', '/api/artifacts/artifact-a.txt', 'artifact-a.txt', now)

async function* attachmentSource() {
  yield Buffer.from('attachment-content-a')
}

await createManagedAttachment({
  userId: 'user-export-a',
  id: 'attachment-a-0001',
  name: 'attachment-a.txt',
  mimeType: 'text/plain',
  source: attachmentSource(),
  env: process.env,
})

test.after(() => {
  compactionArchiveController.release()
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('authoritative export includes all owned relational rows and managed file bodies without auth sessions or other users', async () => {
  const snapshot = buildAuthoritativeUserDataSnapshot({
    userId: 'user-export-a',
    db,
    env: process.env,
    now: 1_700_000_000_000,
  })
  assert.equal(snapshot.manifest.format, 'gugo-authoritative-user-data')
  assert.equal(snapshot.manifest.authenticationSessionsIncluded, false)
  assert.deepEqual(snapshot.manifest.database.tables.sessions.map((row) => row.token), ['chat-a'])
  assert.deepEqual(snapshot.manifest.database.tables.messages.map((row) => row.content), ['content-a'])
  assert.equal(snapshot.manifest.database.tables.job_artifacts[0].filename, 'artifact-a.txt')
  assert.deepEqual(
    snapshot.manifest.database.tables.side_effect_executions.map((row) => row.owner_id),
    ['user-export-a'],
  )
  assert.doesNotMatch(JSON.stringify(snapshot.manifest), /content-b|auth-a|auth-b/)

  const archive = createAuthoritativeUserDataArchive({
    userId: 'user-export-a',
    db,
    env: process.env,
    now: 1_700_000_000_000,
  })
  const archiveBuffer = await archiveToBuffer(archive)
  const zip = await JSZip.loadAsync(archiveBuffer)
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  const readme = await zip.file('README.txt').async('string')
  assert.equal(manifest.database.tableCounts.messages, 1)
  assert.doesNotMatch(readme, /Retired legacy internal tables and fields|ledger|credits|accounting/i)
  assert.equal(await zip.file('attachments/attachment-a-0001/attachment-a.txt').async('string'), 'attachment-content-a')
  assert.equal(await zip.file('artifacts/artifact-a.txt').async('string'), 'artifact-content-a')
})

test('authoritative governance exports and clears durable Agent Events for only the selected user', () => {
  const userA = 'user-agent-event-governance-a'
  const userB = 'user-agent-event-governance-b'
  insertUserFixture(userA, 'agent-event-governance-a')
  insertUserFixture(userB, 'agent-event-governance-b')
  const capture = (userId, marker) => db.transaction(() => enqueueAgentEventOutboxInDb(db, {
    userId,
    event: createTurnEvent({
      id: `agent-event-governance-${marker}`,
      sessionId: `chat-agent-event-governance-${marker}`,
      turnId: `turn-agent-event-governance-${marker}`,
      sequence: 0,
      type: 'turn.started',
      payload: {},
      createdAt: now,
    }),
  }))()
  capture(userA, 'a')
  capture(userB, 'b')

  const snapshot = buildAuthoritativeUserDataSnapshot({
    userId: userA,
    db,
    env: process.env,
  })
  assert.deepEqual(
    snapshot.manifest.database.tables.agent_event_outbox.map((row) => row.event_id),
    ['agent-event-governance-a'],
  )
  assert.equal(
    JSON.stringify(snapshot.manifest).includes('agent-event-governance-b'),
    false,
  )

  const result = clearAuthoritativeUserData({
    userId: userA,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(result.deleted.agent_event_outbox, 1)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM agent_event_outbox WHERE user_id = ?')
      .get(userA).count,
    0,
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM agent_event_outbox WHERE user_id = ?')
      .get(userB).count,
    1,
  )
})

test('file-backed compaction archives export verified bodies and clear only the selected user bucket', async () => {
  const userA = 'user-compaction-storage-a'
  const userB = 'user-compaction-storage-b'
  insertUserFixture(userA, 'compaction-storage-a')
  insertUserFixture(userB, 'compaction-storage-b')
  const messagesA = [{ role: 'user', content: 'private archive A' }]
  const messagesB = [{ role: 'user', content: 'private archive B' }]
  const archiveA = createCompactionArchiveRecord({
    id: 'compaction-storage-a',
    userId: userA,
    sessionId: 'chat-compaction-storage-a',
    archivedMessages: messagesA,
    summaryText: 'summary A',
    db,
    env: process.env,
  })
  const archiveB = createCompactionArchiveRecord({
    id: 'compaction-storage-b',
    userId: userB,
    sessionId: 'chat-compaction-storage-b',
    archivedMessages: messagesB,
    summaryText: 'summary B',
    db,
    env: process.env,
  })
  const rowA = db.prepare('SELECT * FROM compaction_archive WHERE id = ?').get(archiveA.id)
  const rowB = db.prepare('SELECT * FROM compaction_archive WHERE id = ?').get(archiveB.id)
  const pathA = resolveCompactionArchiveStorage({
    userId: userA,
    id: archiveA.id,
    storagePath: rowA.storage_path,
    env: process.env,
  }).fullPath
  const pathB = resolveCompactionArchiveStorage({
    userId: userB,
    id: archiveB.id,
    storagePath: rowB.storage_path,
    env: process.env,
  }).fullPath
  const orphanA = path.join(
    path.dirname(pathA),
    `${crypto.randomBytes(32).toString('hex')}.json`,
  )
  fs.writeFileSync(orphanA, 'orphan from interrupted archive write')

  assert.equal(rowA.archived_messages_json, '[]')
  const exported = createAuthoritativeUserDataArchive({
    userId: userA,
    db,
    env: process.env,
  })
  const zip = await JSZip.loadAsync(await archiveToBuffer(exported))
  const descriptor = exported.manifest.files.find((file) => (
    file.kind === 'compaction-archive' && file.id === archiveA.id
  ))
  assert.ok(descriptor)
  assert.deepEqual(JSON.parse(await zip.file(descriptor.archivePath).async('string')), messagesA)
  assert.equal(descriptor.sha256, crypto.createHash('sha256').update(JSON.stringify(messagesA)).digest('hex'))
  assert.equal(exported.manifest.files.some((file) => file.id === archiveB.id), false)
  assert.equal(JSON.stringify(exported.manifest).includes('private archive B'), false)

  const result = clearAuthoritativeUserData({
    userId: userA,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(pathA), false)
  assert.equal(fs.existsSync(orphanA), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive WHERE user_id = ?').get(userA).count, 0)
  assert.equal(fs.existsSync(pathB), true)
  assert.deepEqual(
    getCompactionArchiveRecord({ userId: userB, id: archiveB.id, db, env: process.env })?.archivedMessages,
    messagesB,
  )
  assert.equal(
    compactionArchiveTesting.ownerBucket(userA) === compactionArchiveTesting.ownerBucket(userB),
    false,
  )
})

test('retired accounting tables and columns are physically absent from the final schema', () => {
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get(),
    undefined,
  )
  for (const [table, retiredColumn] of [
    ['users', 'credits'],
    ['session_meters', 'cost_credits'],
    ['subagent_runs', 'credits'],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
    assert.equal(columns.includes(retiredColumn), false, `${table}.${retiredColumn} still exists`)
  }
})

test('authoritative export refuses a session whose durable content is not materialized yet', () => {
  const userId = 'user-export-pending'
  const marker = 'export-pending'
  insertUserFixture(userId, marker)
  enqueueSessionContentEventInDb(db, {
    eventId: 'export-pending-event',
    userId,
    sessionId: `chat-${marker}`,
    eventType: 'message.upsert',
    payload: {
      message: {
        id: `message-${marker}`,
        role: 'user',
        content: `content-${marker}`,
        createdAt: now,
        updatedAt: now,
      },
    },
    createdAt: now,
  })

  assert.throws(
    () => buildAuthoritativeUserDataSnapshot({ userId, db, env: process.env }),
    (error) => error?.code === 'USER_DATA_EXPORT_MATERIALIZATION_PENDING'
      && error?.statusCode === 409,
  )
})

test('authoritative export derives canonical session JSONL without copying stale raw bytes', async () => {
  const userId = 'user-export-jsonl-boundary'
  const marker = 'export-jsonl-boundary'
  const sessionId = `chat-${marker}`
  insertUserFixture(userId, marker)
  const paths = resolveSessionContentPath({ userId, sessionId, env: process.env })
  fs.mkdirSync(paths.userDirectory, { recursive: true })
  fs.writeFileSync(paths.filePath, 'legacy-deleted-secret\n')
  fs.writeFileSync(path.join(paths.userDirectory, 'orphan-deleted-session.jsonl'), 'orphan-session-secret\n')

  const archive = createAuthoritativeUserDataArchive({ userId, db, env: process.env })
  fs.appendFileSync(paths.filePath, 'later-stale-secret\n')
  const zip = await JSZip.loadAsync(await archiveToBuffer(archive))
  const exported = archive.manifest.files.find((file) => file.kind === 'session-content')
  assert.ok(exported)
  const text = await zip.file(exported.archivePath).async('string')
  assert.doesNotMatch(text, /legacy-deleted-secret|later-stale-secret/)
  const projection = projectSessionContentEvents(
    text.trim().split('\n').map((line) => decodeSessionContentRecord(line)),
  )
  assert.deepEqual(projection.messages.map((message) => message.content), [
    'content-export-jsonl-boundary',
  ])
  assert.equal(exported.size, Buffer.byteLength(text))
  assert.equal(exported.sha256, crypto.createHash('sha256').update(text).digest('hex'))
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const bytes = await entry.async('nodebuffer')
    assert.equal(bytes.includes(Buffer.from('legacy-deleted-secret')), false, entry.name)
    assert.equal(bytes.includes(Buffer.from('later-stale-secret')), false, entry.name)
    assert.equal(bytes.includes(Buffer.from('orphan-session-secret')), false, entry.name)
  }
})

test('emergency journals export and clear only the selected user across primary and fallback paths', async () => {
  const userA = 'user-emergency-governance-a'
  const userB = 'user-emergency-governance-b'
  insertUserFixture(userA, 'emergency-governance-a')
  insertUserFixture(userB, 'emergency-governance-b')
  const root = path.join(tempDir, 'emergency-governance-both-paths')
  const journalDataDir = path.join(root, 'data')
  const fallbackDir = path.join(root, 'fallback')
  const journalEnv = { ...process.env, APP_DATA_DIR: journalDataDir }
  const primaryPath = path.join(journalDataDir, 'turn-emergency-failures.jsonl')
  const fallbackPath = path.join(fallbackDir, 'gugo-turn-emergency-failures.jsonl')
  writeEmergencyJournal(primaryPath, [
    emergencyJournalRecord('mixed-primary', [
      { userId: userA, event: { content: 'primary-secret-a' }, checkpointState: { owner: 'a' } },
      { userId: userB, event: { content: 'primary-secret-b' }, checkpointState: { owner: 'b' } },
      { userId: null, event: { content: 'primary-unowned' }, checkpointState: null },
    ]),
    emergencyJournalRecord('primary-b-only', [
      { userId: userB, event: { content: 'primary-b-only' }, checkpointState: null },
    ]),
  ])
  writeEmergencyJournal(fallbackPath, [
    emergencyJournalRecord('fallback-a', [
      { userId: userA, event: { content: 'fallback-secret-a' }, checkpointState: null },
    ]),
    emergencyJournalRecord('fallback-b', [
      { userId: userB, event: { content: 'fallback-secret-b' }, checkpointState: null },
    ]),
  ])

  const archive = createAuthoritativeUserDataArchive({
    userId: userA,
    db,
    env: journalEnv,
    cwd: root,
    tempDir: fallbackDir,
  })
  const zip = await JSZip.loadAsync(await archiveToBuffer(archive))
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  const journalFiles = manifest.files.filter((file) => (
    file.kind === 'turn-emergency-failure-journal'
  ))
  assert.deepEqual(journalFiles.map((file) => file.id), ['primary', 'fallback'])
  const exportedJournalText = (await Promise.all(
    journalFiles.map((file) => zip.file(file.archivePath).async('string')),
  )).join('\n')
  assert.match(exportedJournalText, /primary-secret-a/)
  assert.match(exportedJournalText, /fallback-secret-a/)
  assert.doesNotMatch(exportedJournalText, /primary-secret-b|primary-b-only|fallback-secret-b/)
  assert.doesNotMatch(exportedJournalText, /primary-unowned/)

  const result = clearAuthoritativeUserData({
    userId: userA,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: journalEnv,
    cwd: root,
    tempDir: fallbackDir,
  })
  assert.deepEqual(result.emergencyFailureJournals, {
    filesChanged: 2,
    recordsRemoved: 1,
    entriesRemoved: 2,
  })
  const remaining = [...readEmergencyJournal(primaryPath), ...readEmergencyJournal(fallbackPath)]
  assert.equal(remaining.some((record) => record.entries.some((entry) => entry.userId === userA)), false)
  assert.equal(remaining.filter((record) => record.entries.some((entry) => entry.userId === userB)).length, 3)
  assert.equal(
    remaining.find((record) => record.id === 'mixed-primary').entries[0].event.content,
    'primary-secret-b',
  )
  assert.equal(
    remaining.find((record) => record.id === 'mixed-primary').entries[1].event.content,
    'primary-unowned',
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userA).count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userB).count, 1)
})

test('missing emergency journal paths do not block authoritative export or clear', async () => {
  const userId = 'user-emergency-missing'
  insertUserFixture(userId, 'emergency-missing')
  const root = path.join(tempDir, 'emergency-governance-missing')
  const journalEnv = { ...process.env, APP_DATA_DIR: path.join(root, 'data') }
  const fallbackDir = path.join(root, 'fallback')
  const archive = createAuthoritativeUserDataArchive({
    userId,
    db,
    env: journalEnv,
    cwd: root,
    tempDir: fallbackDir,
  })
  const zip = await JSZip.loadAsync(await archiveToBuffer(archive))
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  assert.equal(
    manifest.files.some((file) => file.kind === 'turn-emergency-failure-journal'),
    false,
  )
  const result = clearAuthoritativeUserData({
    userId,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: journalEnv,
    cwd: root,
    tempDir: fallbackDir,
  })
  assert.deepEqual(result.emergencyFailureJournals, {
    filesChanged: 0,
    recordsRemoved: 0,
    entriesRemoved: 0,
  })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userId).count, 0)
})

test('emergency journal write and rename failures preserve bytes and database rows', () => {
  for (const failureKind of ['write', 'rename']) {
    const userId = `user-emergency-${failureKind}-failure`
    const otherUserId = `user-emergency-${failureKind}-other`
    insertUserFixture(userId, `emergency-${failureKind}-failure`)
    insertUserFixture(otherUserId, `emergency-${failureKind}-other`)
    const root = path.join(tempDir, `emergency-governance-${failureKind}-failure`)
    const journalDataDir = path.join(root, 'data')
    const fallbackDir = path.join(root, 'fallback')
    const journalEnv = { ...process.env, APP_DATA_DIR: journalDataDir }
    const primaryPath = path.join(journalDataDir, 'turn-emergency-failures.jsonl')
    writeEmergencyJournal(primaryPath, [emergencyJournalRecord(`mixed-${failureKind}`, [
      { userId, event: { content: `${failureKind}-target` }, checkpointState: null },
      { userId: otherUserId, event: { content: `${failureKind}-other` }, checkpointState: null },
    ])])
    const originalBytes = fs.readFileSync(primaryPath)
    let injected = false
    const descriptorPaths = new Map()
    const failingFileSystem = failureKind === 'write'
      ? {
          openSync(target, ...args) {
            const descriptor = fs.openSync(target, ...args)
            descriptorPaths.set(descriptor, String(target))
            return descriptor
          },
          writeSync(descriptor, ...args) {
            if (!injected && descriptorPaths.get(descriptor)?.endsWith('.user-data-next')) {
              injected = true
              throw new Error('injected emergency journal write failure')
            }
            return fs.writeSync(descriptor, ...args)
          },
          closeSync(descriptor) {
            descriptorPaths.delete(descriptor)
            return fs.closeSync(descriptor)
          },
        }
      : {
          renameSync(source, destination) {
            if (!injected && source === primaryPath) {
              injected = true
              throw new Error('injected emergency journal rename failure')
            }
            return fs.renameSync(source, destination)
          },
        }
    assert.throws(
      () => clearAuthoritativeUserData({
        userId,
        confirmation: USER_DATA_CLEAR_CONFIRMATION,
        db,
        env: journalEnv,
        cwd: root,
        tempDir: fallbackDir,
        fileSystem: failingFileSystem,
      }),
      (error) => error.code === 'USER_DATA_CLEAR_EMERGENCY_JOURNAL_UNAVAILABLE'
        && error.statusCode === 500
        && error.databaseCleared === false
        && error.cleanupPending === false,
    )
    assert.equal(injected, true)
    assert.deepEqual(fs.readFileSync(primaryPath), originalBytes)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userId).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(otherUserId).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?').get(userId).count, 0)
    assert.equal(
      fs.readdirSync(journalDataDir).some((name) => name.includes('.user-data-')),
      false,
    )
  }
})

test('SQL rollback restores both emergency paths and merges a concurrent append by record id', () => {
  const userA = 'user-emergency-sql-rollback-a'
  const userB = 'user-emergency-sql-rollback-b'
  insertUserFixture(userA, 'emergency-sql-rollback-a')
  insertUserFixture(userB, 'emergency-sql-rollback-b')
  const root = path.join(tempDir, 'emergency-governance-sql-rollback')
  const journalDataDir = path.join(root, 'data')
  const fallbackDir = path.join(root, 'fallback')
  const journalEnv = { ...process.env, APP_DATA_DIR: journalDataDir }
  const primaryPath = path.join(journalDataDir, 'turn-emergency-failures.jsonl')
  const fallbackPath = path.join(fallbackDir, 'gugo-turn-emergency-failures.jsonl')
  for (const [filePath, marker] of [[primaryPath, 'primary'], [fallbackPath, 'fallback']]) {
    writeEmergencyJournal(filePath, [emergencyJournalRecord(`rollback-${marker}`, [
      { userId: userA, event: { content: `${marker}-a` }, checkpointState: null },
      { userId: userB, event: { content: `${marker}-b` }, checkpointState: null },
      { userId: null, event: { content: `${marker}-unowned` }, checkpointState: null },
    ])])
  }
  db.exec(`
    CREATE TRIGGER block_emergency_sql_rollback
    BEFORE DELETE ON messages
    WHEN OLD.user_id = '${userA}'
    BEGIN
      SELECT RAISE(ABORT, 'blocked emergency rollback test');
    END;
  `)
  let appendCount = 0
  const observedDb = dbWithBeforeTransaction(() => {
    if (appendCount > 0 || !db.prepare(`
      SELECT 1 FROM user_data_clear_operations WHERE owner_id = ?
    `).get(userA)) return
    appendCount += 1
    recordTurnEmergencyFailure({
      batch: [{
        userId: userB,
        event: { id: 'concurrent-rollback-event', content: 'concurrent-b-after-stage' },
        checkpointState: { retained: true },
      }],
      errorMessage: 'concurrent rollback append',
    }, { env: journalEnv, cwd: root, tempDir: fallbackDir })
  })
  try {
    assert.throws(
      () => clearAuthoritativeUserData({
        userId: userA,
        confirmation: USER_DATA_CLEAR_CONFIRMATION,
        db: observedDb,
        env: journalEnv,
        cwd: root,
        tempDir: fallbackDir,
      }),
      /blocked emergency rollback test/,
    )
  } finally {
    db.exec('DROP TRIGGER block_emergency_sql_rollback')
  }
  assert.equal(appendCount, 1)
  const primaryText = JSON.stringify(readEmergencyJournal(primaryPath))
  const fallbackText = JSON.stringify(readEmergencyJournal(fallbackPath))
  for (const expected of ['primary-a', 'primary-b', 'primary-unowned', 'concurrent-b-after-stage']) {
    assert.match(primaryText, new RegExp(expected))
  }
  for (const expected of ['fallback-a', 'fallback-b', 'fallback-unowned']) {
    assert.match(fallbackText, new RegExp(expected))
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userA).count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userB).count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?').get(userA).count, 0)
})

test('successful clear preserves an emergency append made after staging', () => {
  const userA = 'user-emergency-concurrent-commit-a'
  const userB = 'user-emergency-concurrent-commit-b'
  insertUserFixture(userA, 'emergency-concurrent-commit-a')
  insertUserFixture(userB, 'emergency-concurrent-commit-b')
  const root = path.join(tempDir, 'emergency-governance-concurrent-commit')
  const journalDataDir = path.join(root, 'data')
  const fallbackDir = path.join(root, 'fallback')
  const journalEnv = { ...process.env, APP_DATA_DIR: journalDataDir }
  const primaryPath = path.join(journalDataDir, 'turn-emergency-failures.jsonl')
  writeEmergencyJournal(primaryPath, [emergencyJournalRecord('commit-original', [
    { userId: userA, event: { content: 'commit-original-a' }, checkpointState: null },
    { userId: userB, event: { content: 'commit-original-b' }, checkpointState: null },
  ])])
  let appendCount = 0
  const observedDb = dbWithBeforeTransaction(() => {
    if (appendCount > 0 || !db.prepare(`
      SELECT 1 FROM user_data_clear_operations WHERE owner_id = ?
    `).get(userA)) return
    appendCount += 1
    recordTurnEmergencyFailure({
      batch: [{
        userId: userB,
        event: { id: 'concurrent-commit-event', content: 'concurrent-b-before-commit' },
        checkpointState: null,
      }],
      errorMessage: 'concurrent commit append',
    }, { env: journalEnv, cwd: root, tempDir: fallbackDir })
  })
  const result = clearAuthoritativeUserData({
    userId: userA,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db: observedDb,
    env: journalEnv,
    cwd: root,
    tempDir: fallbackDir,
  })
  assert.equal(result.ok, true)
  assert.equal(appendCount, 1)
  const remainingText = JSON.stringify(readEmergencyJournal(primaryPath))
  assert.doesNotMatch(remainingText, /commit-original-a/)
  assert.match(remainingText, /commit-original-b/)
  assert.match(remainingText, /concurrent-b-before-commit/)
})

test('post-commit emergency backup cleanup is recovered without deleting concurrent records', () => {
  const userA = 'user-emergency-cleanup-recovery-a'
  const userB = 'user-emergency-cleanup-recovery-b'
  insertUserFixture(userA, 'emergency-cleanup-recovery-a')
  insertUserFixture(userB, 'emergency-cleanup-recovery-b')
  const root = path.join(tempDir, 'emergency-governance-cleanup-recovery')
  const journalDataDir = path.join(root, 'data')
  const fallbackDir = path.join(root, 'fallback')
  const journalEnv = { ...process.env, APP_DATA_DIR: journalDataDir }
  const primaryPath = path.join(journalDataDir, 'turn-emergency-failures.jsonl')
  writeEmergencyJournal(primaryPath, [emergencyJournalRecord('cleanup-original', [
    { userId: userA, event: { content: 'cleanup-a' }, checkpointState: null },
    { userId: userB, event: { content: 'cleanup-b' }, checkpointState: null },
  ])])
  let injected = false
  const failingFileSystem = {
    unlinkSync(target) {
      if (!injected && String(target).endsWith('.user-data-backup')) {
        injected = true
        throw new Error('injected emergency backup cleanup failure')
      }
      return fs.unlinkSync(target)
    },
  }
  assert.throws(
    () => clearAuthoritativeUserData({
      userId: userA,
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: journalEnv,
      cwd: root,
      tempDir: fallbackDir,
      fileSystem: failingFileSystem,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE'
      && error.databaseCleared === true
      && error.cleanupPending === true,
  )
  assert.equal(injected, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userA).count, 0)
  assert.match(JSON.stringify(readEmergencyJournal(primaryPath)), /cleanup-b/)
  assert.doesNotMatch(JSON.stringify(readEmergencyJournal(primaryPath)), /cleanup-a/)
  assert.equal(
    fs.readdirSync(journalDataDir).some((name) => name.endsWith('.user-data-backup')),
    true,
  )
  const recovered = clearAuthoritativeUserData({
    userId: userA,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: journalEnv,
    cwd: root,
    tempDir: fallbackDir,
  })
  assert.equal(recovered.ok, true)
  assert.equal(
    fs.readdirSync(journalDataDir).some((name) => name.includes('.user-data-')),
    false,
  )
  assert.match(JSON.stringify(readEmergencyJournal(primaryPath)), /cleanup-b/)
})

test('malformed emergency journals fail closed for export and clear', () => {
  const userId = 'user-emergency-malformed'
  insertUserFixture(userId, 'emergency-malformed')
  const root = path.join(tempDir, 'emergency-governance-malformed')
  const journalDataDir = path.join(root, 'data')
  const fallbackDir = path.join(root, 'fallback')
  const journalEnv = { ...process.env, APP_DATA_DIR: journalDataDir }
  const primaryPath = path.join(journalDataDir, 'turn-emergency-failures.jsonl')
  fs.mkdirSync(journalDataDir, { recursive: true })
  fs.writeFileSync(primaryPath, '{not valid json}\n')
  assert.throws(
    () => buildAuthoritativeUserDataSnapshot({
      userId, db, env: journalEnv, cwd: root, tempDir: fallbackDir,
    }),
    (error) => error.code === 'USER_DATA_EXPORT_EMERGENCY_JOURNAL_INVALID',
  )
  assert.throws(
    () => clearAuthoritativeUserData({
      userId,
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: journalEnv,
      cwd: root,
      tempDir: fallbackDir,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_EMERGENCY_JOURNAL_INVALID'
      && error.databaseCleared === false,
  )
  assert.equal(fs.readFileSync(primaryPath, 'utf8'), '{not valid json}\n')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userId).count, 1)
})

test('emergency journal symlinks fail closed without changing user data', (t) => {
  const userId = 'user-emergency-symlink'
  insertUserFixture(userId, 'emergency-symlink')
  const root = path.join(tempDir, 'emergency-governance-symlink')
  const journalDataDir = path.join(root, 'data')
  const fallbackDir = path.join(root, 'fallback')
  const journalEnv = { ...process.env, APP_DATA_DIR: journalDataDir }
  const primaryPath = path.join(journalDataDir, 'turn-emergency-failures.jsonl')
  const outsidePath = path.join(root, 'outside.jsonl')
  writeEmergencyJournal(outsidePath, [emergencyJournalRecord('outside', [
    { userId, event: { content: 'outside-secret' }, checkpointState: null },
  ])])
  fs.mkdirSync(journalDataDir, { recursive: true })
  try {
    fs.symlinkSync(outsidePath, primaryPath, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`file symlinks are unavailable: ${error.code}`)
      return
    }
    throw error
  }
  assert.throws(
    () => buildAuthoritativeUserDataSnapshot({
      userId, db, env: journalEnv, cwd: root, tempDir: fallbackDir,
    }),
    (error) => error.code === 'USER_DATA_EXPORT_EMERGENCY_JOURNAL_INVALID',
  )
  assert.throws(
    () => clearAuthoritativeUserData({
      userId,
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: journalEnv,
      cwd: root,
      tempDir: fallbackDir,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_EMERGENCY_JOURNAL_INVALID'
      && error.databaseCleared === false,
  )
  assert.match(fs.readFileSync(outsidePath, 'utf8'), /outside-secret/)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userId).count, 1)
})

test('emergency export rejects a truncated descriptor snapshot', () => {
  const userId = 'user-emergency-truncated-export'
  insertUserFixture(userId, 'emergency-truncated-export')
  const root = path.join(tempDir, 'emergency-governance-truncated-export')
  const journalDataDir = path.join(root, 'data')
  const fallbackDir = path.join(root, 'fallback')
  const journalEnv = { ...process.env, APP_DATA_DIR: journalDataDir }
  const primaryPath = path.join(journalDataDir, 'turn-emergency-failures.jsonl')
  writeEmergencyJournal(primaryPath, [emergencyJournalRecord('truncated-export', [
    { userId, event: { content: 'must-not-be-partially-exported' }, checkpointState: null },
  ])])
  let injected = false
  const truncatedFileSystem = {
    readFileSync(target, ...args) {
      const bytes = fs.readFileSync(target, ...args)
      if (!injected && typeof target === 'number' && Buffer.isBuffer(bytes)) {
        injected = true
        return bytes.subarray(0, Math.max(0, bytes.length - 1))
      }
      return bytes
    },
  }
  assert.throws(
    () => buildAuthoritativeUserDataSnapshot({
      userId,
      db,
      env: journalEnv,
      cwd: root,
      tempDir: fallbackDir,
      fileSystem: truncatedFileSystem,
    }),
    (error) => error.code === 'USER_DATA_EXPORT_EMERGENCY_JOURNAL_UNAVAILABLE',
  )
  assert.equal(injected, true)
})

test('authoritative export and clear cover logs, snapshots, browser profiles, and artifact sidecars without crossing users', async () => {
  insertUserFixture('user-managed-files-a', 'managed-files-a')
  insertUserFixture('user-managed-files-b', 'managed-files-b')

  const logRoot = path.join(dataDir, 'background-logs')
  const snapshotRoot = path.join(dataDir, 'snapshots')
  const browserRoot = path.join(dataDir, 'browser-profiles')
  fs.mkdirSync(logRoot, { recursive: true })
  fs.mkdirSync(snapshotRoot, { recursive: true })
  const logA = path.join(logRoot, 'managed-log-a.log')
  const logB = path.join(logRoot, 'managed-log-b.log')
  const snapshotA = path.join(snapshotRoot, 'managed-snapshot-a.before')
  const snapshotB = path.join(snapshotRoot, 'managed-snapshot-b.before')
  fs.writeFileSync(logA, 'background-log-a')
  fs.writeFileSync(logB, 'background-log-b')
  fs.writeFileSync(snapshotA, 'snapshot-a')
  fs.writeFileSync(snapshotB, 'snapshot-b')
  for (const [id, userId, marker, logPath] of [
    ['managed-process-a', 'user-managed-files-a', 'managed-files-a', logA],
    ['managed-process-b', 'user-managed-files-b', 'managed-files-b', logB],
  ]) {
    db.prepare(`
      INSERT INTO background_processes
        (id, user_id, session_id, turn_id, tool_call_id, command, cwd, pid,
         log_path, status, exit_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'completed command', ?, NULL, ?, 'exited', 0, ?, ?)
    `).run(id, userId, `chat-${marker}`, `turn-${marker}`, `call-${marker}`, tempDir, logPath, now, now)
  }
  for (const [id, userId, marker, beforePath] of [
    ['managed-snapshot-a', 'user-managed-files-a', 'managed-files-a', snapshotA],
    ['managed-snapshot-b', 'user-managed-files-b', 'managed-files-b', snapshotB],
  ]) {
    db.prepare(`
      INSERT INTO file_snapshots
        (id, user_id, session_id, turn_id, tool_call_id, tool_name, file_path, before_path, created_at)
      VALUES (?, ?, ?, ?, ?, 'write_file', ?, ?, ?)
    `).run(
      id,
      userId,
      `chat-${marker}`,
      `turn-${marker}`,
      `call-${marker}`,
      path.join(tempDir, `${marker}.txt`),
      beforePath,
      now,
    )
  }

  const browserA = path.join(browserRoot, userBucket('user-managed-files-a'))
  const browserB = path.join(browserRoot, userBucket('user-managed-files-b'))
  fs.mkdirSync(path.join(browserA, 'Default'), { recursive: true })
  fs.mkdirSync(path.join(browserB, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(browserA, 'Default', 'Cookies'), 'browser-profile-a')
  fs.writeFileSync(path.join(browserB, 'Default', 'Cookies'), 'browser-profile-b')

  const artifactA = path.join(artifactDir, 'managed-artifact-a.html')
  const artifactB = path.join(artifactDir, 'managed-artifact-b.html')
  fs.writeFileSync(artifactA, '<p>artifact-a</p>')
  fs.writeFileSync(artifactB, '<p>artifact-b</p>')
  for (const [id, jobId, userId, filename] of [
    ['managed-artifact-id-a', 'job-managed-files-a', 'user-managed-files-a', 'managed-artifact-a.html'],
    ['managed-artifact-id-b', 'job-managed-files-b', 'user-managed-files-b', 'managed-artifact-b.html'],
  ]) {
    db.prepare(`
      INSERT INTO job_artifacts
        (id, job_id, user_id, type, title, url, filename, created_at)
      VALUES (?, ?, ?, 'html', 'Managed artifact', ?, ?, ?)
    `).run(id, jobId, userId, `/api/artifacts/${filename}`, filename, now)
    const sidecars = artifactSidecarPaths(id)
    fs.mkdirSync(path.dirname(sidecars.source), { recursive: true })
    fs.mkdirSync(sidecars.html, { recursive: true })
    fs.writeFileSync(sidecars.source, `source-${userId}`)
    fs.writeFileSync(path.join(sidecars.html, 'manifest.json'), `manifest-${userId}`)
    fs.writeFileSync(path.join(sidecars.html, 'asset.png'), `asset-${userId}`)
  }
  const sidecarsA = artifactSidecarPaths('managed-artifact-id-a')
  const sidecarsB = artifactSidecarPaths('managed-artifact-id-b')

  const exportSnapshot = buildAuthoritativeUserDataSnapshot({
    userId: 'user-managed-files-a', db, env: process.env,
  })
  const kinds = new Set(exportSnapshot.manifest.files.map((file) => file.kind))
  for (const kind of [
    'background-log',
    'file-snapshot',
    'browser-profile',
    'artifact-source',
    'html-artifact-asset',
  ]) assert.equal(kinds.has(kind), true, `missing ${kind}`)
  assert.doesNotMatch(JSON.stringify(exportSnapshot.manifest), /managed-files-b|managed-log-b|managed-snapshot-b/)

  const archive = createAuthoritativeUserDataArchive({
    userId: 'user-managed-files-a', db, env: process.env,
  })
  const zip = await JSZip.loadAsync(await archiveToBuffer(archive))
  for (const expected of [
    ['background-log', 'background-log-a'],
    ['file-snapshot', 'snapshot-a'],
    ['browser-profile', 'browser-profile-a'],
    ['artifact-source', 'source-user-managed-files-a'],
  ]) {
    const file = exportSnapshot.manifest.files.find((entry) => entry.kind === expected[0])
    assert.ok(file, `missing archive descriptor for ${expected[0]}`)
    assert.equal(await zip.file(file.archivePath).async('string'), expected[1])
  }
  const htmlFiles = exportSnapshot.manifest.files.filter((entry) => entry.kind === 'html-artifact-asset')
  assert.equal(htmlFiles.length, 2)
  assert.deepEqual(
    (await Promise.all(htmlFiles.map((file) => zip.file(file.archivePath).async('string')))).sort(),
    ['asset-user-managed-files-a', 'manifest-user-managed-files-a'],
  )

  const result = clearAuthoritativeUserData({
    userId: 'user-managed-files-a',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(result.ok, true)
  assert.equal(result.walCheckpoint.busy, 0)
  for (const target of [logA, snapshotA, browserA, artifactA, sidecarsA.source, sidecarsA.html]) {
    assert.equal(fs.existsSync(target), false, `expected removed: ${target}`)
  }
  for (const target of [logB, snapshotB, browserB, artifactB, sidecarsB.source, sidecarsB.html]) {
    assert.equal(fs.existsSync(target), true, `expected preserved: ${target}`)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM background_processes WHERE user_id = ?').get('user-managed-files-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM background_processes WHERE user_id = ?').get('user-managed-files-b').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM file_snapshots WHERE user_id = ?').get('user-managed-files-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM file_snapshots WHERE user_id = ?').get('user-managed-files-b').count, 1)
})

test('clear preserves artifact source and HTML bundles when another user references the same artifact id', () => {
  insertUserFixture('user-shared-sidecar-a', 'shared-sidecar-a')
  insertUserFixture('user-shared-sidecar-b', 'shared-sidecar-b')
  const sharedId = 'shared-sidecar-artifact-id'
  const artifactA = path.join(artifactDir, 'shared-sidecar-a.html')
  const artifactB = path.join(artifactDir, 'shared-sidecar-b.html')
  fs.writeFileSync(artifactA, 'artifact-a')
  fs.writeFileSync(artifactB, 'artifact-b')
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'html', 'Shared sidecar A', ?, ?, ?)
  `).run(sharedId, 'job-shared-sidecar-a', 'user-shared-sidecar-a', '/api/artifacts/shared-sidecar-a.html', 'shared-sidecar-a.html', now)
  db.prepare(`
    INSERT INTO turn_artifacts
      (id, user_id, session_id, turn_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, ?, 'html', 'Shared sidecar B', ?, ?, ?)
  `).run(sharedId, 'user-shared-sidecar-b', 'chat-shared-sidecar-b', 'turn-shared-sidecar-b', '/api/artifacts/shared-sidecar-b.html', 'shared-sidecar-b.html', now)
  const sidecars = artifactSidecarPaths(sharedId)
  fs.mkdirSync(path.dirname(sidecars.source), { recursive: true })
  fs.mkdirSync(sidecars.html, { recursive: true })
  fs.writeFileSync(sidecars.source, 'shared-source')
  fs.writeFileSync(path.join(sidecars.html, 'manifest.json'), 'shared-html')

  const snapshot = buildAuthoritativeUserDataSnapshot({
    userId: 'user-shared-sidecar-a', db, env: process.env,
  })
  assert.equal(snapshot.manifest.files.some((file) => file.kind === 'artifact-source'), true)
  assert.equal(snapshot.manifest.files.some((file) => file.kind === 'html-artifact-asset'), true)

  const result = clearAuthoritativeUserData({
    userId: 'user-shared-sidecar-a',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(fs.existsSync(artifactA), false)
  assert.equal(fs.existsSync(artifactB), true)
  assert.equal(fs.existsSync(sidecars.source), true)
  assert.equal(fs.existsSync(sidecars.html), true)
  assert.equal(result.managedFiles.preservedShared, 2)
})

test('clear refuses active turns, jobs, job leases, and background processes without changing data', () => {
  insertUserFixture('user-runtime-guard', 'runtime-guard')
  const browserPath = path.join(dataDir, 'browser-profiles', userBucket('user-runtime-guard'))
  fs.mkdirSync(browserPath, { recursive: true })
  fs.writeFileSync(path.join(browserPath, 'marker.txt'), 'runtime-guard-marker')
  const assertBlocked = (kind) => {
    assert.throws(
      () => clearAuthoritativeUserData({
        userId: 'user-runtime-guard',
        confirmation: USER_DATA_CLEAR_CONFIRMATION,
        db,
        env: process.env,
      }),
      (error) => error.code === 'USER_DATA_CLEAR_RUNTIME_ACTIVE'
        && error.statusCode === 409
        && error.databaseCleared === false
        && error.blockers.some((entry) => entry.kind === kind),
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('user-runtime-guard').count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?').get('user-runtime-guard').count, 0)
    assert.equal(fs.readFileSync(path.join(browserPath, 'marker.txt'), 'utf8'), 'runtime-guard-marker')
  }

  db.prepare(`
    INSERT INTO turn_execution_leases
      (user_id, session_id, turn_id, owner_id, acquired_at, expires_at)
    VALUES (?, ?, ?, 'runtime-guard-owner', ?, ?)
  `).run('user-runtime-guard', 'chat-runtime-guard', 'turn-runtime-guard', now, Date.now() + 60_000)
  assertBlocked('turn')
  db.prepare('DELETE FROM turn_execution_leases WHERE user_id = ?').run('user-runtime-guard')

  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run('job-runtime-guard')
  assertBlocked('job')
  db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?").run('job-runtime-guard')

  db.prepare(`
    INSERT INTO job_execution_leases (job_id, owner_id, acquired_at, expires_at)
    VALUES (?, 'runtime-guard-owner', ?, ?)
  `).run('job-runtime-guard', now, Date.now() + 60_000)
  assertBlocked('job_lease')
  db.prepare('DELETE FROM job_execution_leases WHERE job_id = ?').run('job-runtime-guard')

  const logRoot = path.join(dataDir, 'background-logs')
  fs.mkdirSync(logRoot, { recursive: true })
  const logPath = path.join(logRoot, 'runtime-guard.log')
  fs.writeFileSync(logPath, 'runtime-guard-log')
  db.prepare(`
    INSERT INTO background_processes
      (id, user_id, command, cwd, pid, log_path, status, created_at, updated_at)
    VALUES ('runtime-guard-process', ?, 'long command', ?, NULL, ?, 'running', ?, ?)
  `).run('user-runtime-guard', tempDir, logPath, now, now)
  assertBlocked('background_process')
  db.prepare("UPDATE background_processes SET status = 'exited' WHERE id = 'runtime-guard-process'").run()

  const result = clearAuthoritativeUserData({
    userId: 'user-runtime-guard',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(browserPath), false)
  assert.equal(fs.existsSync(logPath), false)
})

test('successful clear invokes SQLite wal_checkpoint(TRUNCATE)', () => {
  insertUserFixture('user-wal-checkpoint', 'wal-checkpoint')
  const pragmaCalls = []
  const observedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'pragma') {
        return (statement, ...args) => {
          pragmaCalls.push(statement)
          return target.pragma(statement, ...args)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const result = clearAuthoritativeUserData({
    userId: 'user-wal-checkpoint',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db: observedDb,
    env: process.env,
  })
  assert.equal(result.ok, true)
  assert.equal(result.walCheckpoint.busy, 0)
  assert.equal(pragmaCalls.includes('wal_checkpoint(TRUNCATE)'), true)
})

test('crash recovery refuses a managed destination whose parent was replaced by a junction', (t) => {
  const root = path.join(tempDir, 'recovery-junction-root')
  const activeParent = path.join(root, 'safe-parent')
  const activePath = path.join(activeParent, 'payload.txt')
  const stagePath = path.join(root, '.recovery-junction.user-data-staging')
  const outside = path.join(tempDir, 'recovery-junction-outside')
  fs.mkdirSync(activeParent, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(activePath, 'managed-payload')
  const operationId = crypto.randomUUID()
  stageManagedDeletionDomain({
    root,
    stagePath,
    domain: 'data',
    operationId,
    userId: 'recovery-junction-user',
    entries: [{
      kind: 'file-snapshot',
      id: 'recovery-junction-file',
      domain: 'data',
      root,
      fullPath: activePath,
      relativePath: path.relative(root, activePath),
      type: 'file',
      code: 'USER_DATA_CLEAR_FILE_SNAPSHOT_UNSAFE',
      message: 'unsafe snapshot',
    }],
  })
  fs.rmdirSync(activeParent)
  try {
    fs.symlinkSync(outside, activeParent, 'junction')
  } catch (error) {
    fs.mkdirSync(activeParent, { recursive: true })
    rollbackManagedDeletionStage({
      root,
      stagePath,
      domain: 'data',
      operationId,
      userId: 'recovery-junction-user',
    })
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`junction creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }

  assert.throws(
    () => rollbackManagedDeletionStage({
      root,
      stagePath,
      domain: 'data',
      operationId,
      userId: 'recovery-junction-user',
    }),
    (error) => error.code === 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
  )
  assert.equal(fs.existsSync(path.join(outside, 'payload.txt')), false)
  assert.equal(fs.existsSync(stagePath), true)

  fs.unlinkSync(activeParent)
  fs.mkdirSync(activeParent, { recursive: true })
  rollbackManagedDeletionStage({
    root,
    stagePath,
    domain: 'data',
    operationId,
    userId: 'recovery-junction-user',
  })
  assert.equal(fs.readFileSync(activePath, 'utf8'), 'managed-payload')
})

test('partial staging plus rollback failure retains a durable operation journal for recovery', () => {
  const userId = 'user-partial-stage-recovery'
  const marker = 'partial-stage-recovery'
  insertUserFixture(userId, marker)
  const firstPath = path.join(artifactDir, 'partial-stage-first.txt')
  const secondPath = path.join(artifactDir, 'partial-stage-second.txt')
  fs.writeFileSync(firstPath, 'first-content')
  fs.writeFileSync(secondPath, 'second-content')
  for (const [id, filename] of [
    ['partial-stage-first-row', path.basename(firstPath)],
    ['partial-stage-second-row', path.basename(secondPath)],
  ]) {
    db.prepare(`
      INSERT INTO job_artifacts
        (id, job_id, user_id, type, title, url, filename, created_at)
      VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
    `).run(
      id,
      `job-${marker}`,
      userId,
      id,
      `/api/artifacts/${filename}`,
      filename,
      now,
    )
  }

  let stagingFailureInjected = false
  let rollbackFailureInjected = false
  const failingFileSystem = {
    renameSync(source, destination) {
      const resolvedSource = path.resolve(source)
      const resolvedDestination = path.resolve(destination)
      if (!stagingFailureInjected && resolvedSource === path.resolve(secondPath)) {
        stagingFailureInjected = true
        throw new Error('injected second-file staging failure')
      }
      if (stagingFailureInjected
        && !rollbackFailureInjected
        && resolvedDestination === path.resolve(firstPath)
        && String(source).includes('.user-data-staging')) {
        rollbackFailureInjected = true
        throw new Error('injected first-file rollback failure')
      }
      return fs.renameSync(source, destination)
    },
  }

  assert.throws(
    () => clearAuthoritativeUserData({
      userId,
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: process.env,
      fileSystem: failingFileSystem,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_RECOVERY_INCOMPLETE'
      && error.databaseCleared === false
      && error.cleanupPending === true
      && error.recoveryRequired === true,
  )
  assert.equal(stagingFailureInjected, true)
  assert.equal(rollbackFailureInjected, true)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM messages WHERE user_id = ?',
  ).get(userId).count, 1)
  const operation = db.prepare(`
    SELECT operation_id, status FROM user_data_clear_operations WHERE owner_id = ?
  `).get(userId)
  assert.equal(operation.status, 'staging')
  assert.equal(fs.existsSync(firstPath), false)
  assert.equal(fs.existsSync(secondPath), true)
  assert.equal(
    fs.readdirSync(artifactDir).some((name) => (
      name.includes(operation.operation_id) && name.endsWith('.user-data-staging')
    )),
    true,
  )

  const recovered = clearAuthoritativeUserData({
    userId,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(recovered.ok, true)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?',
  ).get(userId).count, 0)
  assert.equal(fs.existsSync(firstPath), false)
  assert.equal(fs.existsSync(secondPath), false)
})

test('relation traversal uses complete composite keys, enforces child ownership, and redacts user authentication fields', async () => {
  db.exec(`
    CREATE TABLE governance_composite_parents (
      namespace TEXT NOT NULL,
      record_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      PRIMARY KEY (namespace, record_key)
    );
    CREATE TABLE governance_composite_children (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      record_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (namespace, record_key)
        REFERENCES governance_composite_parents(namespace, record_key) ON DELETE NO ACTION
    );
    CREATE TABLE governance_scoped_composite_children (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      record_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      FOREIGN KEY (namespace, record_key)
        REFERENCES governance_composite_parents(namespace, record_key) ON DELETE NO ACTION
    );
    ALTER TABLE users ADD COLUMN mfa_secret TEXT;
  `)
  db.prepare(`
    INSERT INTO governance_composite_parents (namespace, record_key, user_id, payload)
    VALUES ('shared', 'owned', 'user-export-a', 'parent-a'),
           ('shared', 'foreign', 'user-export-b', 'parent-b')
  `).run()
  db.prepare(`
    INSERT INTO governance_composite_children (id, namespace, record_key, payload)
    VALUES ('composite-a', 'shared', 'owned', 'child-a'),
           ('composite-b', 'shared', 'foreign', 'child-b')
  `).run()
  db.prepare(`
    INSERT INTO governance_scoped_composite_children
      (id, namespace, record_key, user_id, payload)
    VALUES ('cross-user-child', 'shared', 'owned', 'user-export-b', 'must-not-export')
  `).run()
  db.prepare(`
    UPDATE users
    SET password_hash = ?, password_salt = ?, mfa_secret = ?
    WHERE id = ?
  `).run('secret-password-hash', 'secret-password-salt', 'secret-mfa-seed', 'user-export-a')

  const snapshot = buildAuthoritativeUserDataSnapshot({
    userId: 'user-export-a', db, env: process.env, now: 1_700_000_000_000,
  })
  assert.deepEqual(
    snapshot.manifest.database.tables.governance_composite_children.map((row) => row.id),
    ['composite-a'],
  )
  assert.deepEqual(snapshot.manifest.database.tables.governance_scoped_composite_children, [])
  assert.ok(snapshot.manifest.database.redactedFields.users.includes('password_hash'))
  assert.ok(snapshot.manifest.database.redactedFields.users.includes('password_salt'))
  assert.ok(snapshot.manifest.database.redactedFields.users.includes('mfa_secret'))
  const manifestText = JSON.stringify(snapshot.manifest)
  assert.doesNotMatch(manifestText, /secret-password-hash|secret-password-salt|secret-mfa-seed|child-b|must-not-export/)

  const archive = createAuthoritativeUserDataArchive({
    userId: 'user-export-a', db, env: process.env, now: 1_700_000_000_000,
  })
  const archiveBuffer = await archiveToBuffer(archive)
  assert.doesNotMatch(archiveBuffer.toString('latin1'), /secret-password-hash|secret-password-salt|secret-mfa-seed/)
  db.prepare('DELETE FROM governance_scoped_composite_children WHERE id = ?').run('cross-user-child')
})

test('export rejects attachment directory junctions and final artifact symlinks', (t) => {
  createUser({ id: 'user-link-guard', email: 'link-guard@example.com' })
  const attachmentStorageRoot = path.join(dataDir, 'attachments')
  const bucketName = userBucket('user-link-guard')
  const bucketPath = path.join(attachmentStorageRoot, bucketName)
  const outsideDirectory = path.join(tempDir, 'outside-attachment')
  fs.mkdirSync(bucketPath, { recursive: true })
  fs.mkdirSync(outsideDirectory, { recursive: true })
  fs.writeFileSync(path.join(outsideDirectory, 'outside.txt'), 'outside-attachment-secret')
  const junctionPath = path.join(bucketPath, 'escape')
  try {
    fs.symlinkSync(outsideDirectory, junctionPath, 'junction')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`junction creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }
  db.prepare(`
    INSERT INTO managed_attachments
      (id, user_id, original_name, mime_type, size_bytes, sha256, storage_path, status, created_at, updated_at)
    VALUES (?, ?, ?, 'text/plain', 25, ?, ?, 'ready', ?, ?)
  `).run(
    'junction-attachment',
    'user-link-guard',
    'outside.txt',
    'not-used',
    `${bucketName}/escape/outside.txt`,
    now,
    now,
  )
  assert.throws(
    () => buildAuthoritativeUserDataSnapshot({ userId: 'user-link-guard', db, env: process.env }),
    (error) => error.code === 'USER_DATA_EXPORT_ATTACHMENT_UNAVAILABLE',
  )
  db.prepare('DELETE FROM managed_attachments WHERE id = ?').run('junction-attachment')

  insertUserFixture('user-artifact-link', 'artifact-link')
  const outsideArtifact = path.join(tempDir, 'outside-artifact.txt')
  const linkedArtifact = path.join(artifactDir, 'linked-artifact.txt')
  fs.writeFileSync(outsideArtifact, 'outside-artifact-secret')
  try {
    fs.symlinkSync(outsideArtifact, linkedArtifact, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      const outsideArtifactDirectory = path.join(tempDir, 'outside-artifact-directory')
      fs.mkdirSync(outsideArtifactDirectory, { recursive: true })
      fs.writeFileSync(path.join(outsideArtifactDirectory, 'payload.txt'), 'outside-artifact-secret')
      fs.symlinkSync(outsideArtifactDirectory, linkedArtifact, 'junction')
    } else {
      throw error
    }
  }
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', 'Linked artifact', ?, ?, ?)
  `).run(
    'linked-artifact-row',
    'job-artifact-link',
    'user-artifact-link',
    '/api/artifacts/linked-artifact.txt',
    'linked-artifact.txt',
    now,
  )
  assert.throws(
    () => buildAuthoritativeUserDataSnapshot({ userId: 'user-artifact-link', db, env: process.env }),
    (error) => error.code === 'USER_DATA_EXPORT_ARTIFACT_UNAVAILABLE',
  )
  assert.throws(
    () => clearAuthoritativeUserData({
      userId: 'user-artifact-link',
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: process.env,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_ARTIFACT_UNSAFE'
      && error.databaseCleared === false,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM job_artifacts WHERE id = ?').get('linked-artifact-row').count, 1)
  assert.equal(fs.lstatSync(linkedArtifact).isSymbolicLink(), true)
})

test('post-commit attachment cleanup failure is journaled and completed on the next clear', async () => {
  insertUserFixture('user-rm-failure', 'rm-failure')
  insertSideEffectFixture('user-rm-failure', 'rm-failure')
  async function* source() { yield Buffer.from('rm-failure-attachment') }
  const attachment = await createManagedAttachment({
    userId: 'user-rm-failure',
    id: 'rm-failure-attachment',
    name: 'rm-failure.txt',
    mimeType: 'text/plain',
    source: source(),
    env: process.env,
  })
  const attachmentPath = attachment.fullPath
  const failingFileSystem = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
    rmSync() { throw new Error('injected rm failure') },
  }
  assert.throws(
    () => clearAuthoritativeUserData({
      userId: 'user-rm-failure',
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: process.env,
      fileSystem: failingFileSystem,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE'
      && error.statusCode === 500
      && error.incomplete === true
      && error.databaseCleared === true
      && error.cleanupPending === true,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('user-rm-failure').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM managed_attachments WHERE user_id = ?').get('user-rm-failure').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM side_effect_executions WHERE owner_id = ?').get('user-rm-failure').count, 0)
  assert.equal(fs.existsSync(attachmentPath), false)
  assert.equal(
    fs.readdirSync(path.dirname(path.dirname(attachmentPath))).some((name) => name.endsWith('.user-data-staging')),
    true,
  )
  clearAuthoritativeUserData({
    userId: 'user-rm-failure',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(
    fs.readdirSync(path.dirname(path.dirname(attachmentPath))).some((name) => name.endsWith('.user-data-staging')),
    false,
  )
})

test('clear removes exclusive managed artifacts and preserves files referenced by another user', () => {
  insertUserFixture('user-artifact-clear-a', 'artifact-clear-a')
  insertUserFixture('user-artifact-clear-b', 'artifact-clear-b')
  const exclusivePath = path.join(artifactDir, 'exclusive-clear.txt')
  const sharedPath = path.join(artifactDir, 'shared-clear.txt')
  fs.writeFileSync(exclusivePath, 'exclusive-artifact-content')
  fs.writeFileSync(sharedPath, 'shared-artifact-content')
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'exclusive-clear-row',
    'job-artifact-clear-a',
    'user-artifact-clear-a',
    'Exclusive artifact',
    '/api/artifacts/exclusive-clear.txt',
    'exclusive-clear.txt',
    now,
  )
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'shared-clear-owner-row',
    'job-artifact-clear-a',
    'user-artifact-clear-a',
    'Shared artifact owner',
    '/api/artifacts/shared-clear.txt',
    'shared-clear.txt',
    now,
  )
  db.prepare(`
    INSERT INTO turn_artifacts
      (id, user_id, session_id, turn_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'shared-clear-other-row',
    'user-artifact-clear-b',
    'chat-artifact-clear-b',
    'turn-shared-clear',
    'Shared artifact other user',
    '/api/artifacts/shared-clear.txt',
    'shared-clear.txt',
    now,
  )

  const result = clearAuthoritativeUserData({
    userId: 'user-artifact-clear-a',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.deepEqual(result.artifactFiles, {
    removed: 1,
    preservedShared: 1,
    alreadyMissing: 0,
  })
  assert.equal(fs.existsSync(exclusivePath), false)
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), 'shared-artifact-content')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM job_artifacts WHERE user_id = ?').get('user-artifact-clear-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM turn_artifacts WHERE id = ?').get('shared-clear-other-row').count, 1)
})

test('a cross-owner artifact reference added after staging aborts and rolls back the clear', () => {
  insertUserFixture('user-artifact-reference-race-a', 'artifact-reference-race-a')
  insertUserFixture('user-artifact-reference-race-b', 'artifact-reference-race-b')
  const filename = 'artifact-reference-race.txt'
  const artifactPath = path.join(artifactDir, filename)
  fs.writeFileSync(artifactPath, 'artifact-reference-race-content')
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'artifact-reference-race-owner',
    'job-artifact-reference-race-a',
    'user-artifact-reference-race-a',
    'Artifact reference race owner',
    `/api/artifacts/${filename}`,
    filename,
    now,
  )
  let injected = false
  const fileSystem = {
    renameSync(source, destination) {
      const result = fs.renameSync(source, destination)
      if (!injected && path.resolve(source) === path.resolve(artifactPath)) {
        injected = true
        db.prepare(`
          INSERT INTO turn_artifacts
            (id, user_id, session_id, turn_id, type, title, url, filename, created_at)
          VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?)
        `).run(
          'artifact-reference-race-other',
          'user-artifact-reference-race-b',
          'chat-artifact-reference-race-b',
          'turn-artifact-reference-race-b',
          'Artifact reference race other',
          `/api/artifacts/${filename}`,
          filename,
          now,
        )
      }
      return result
    },
  }

  assert.throws(
    () => clearAuthoritativeUserData({
      userId: 'user-artifact-reference-race-a',
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: process.env,
      fileSystem,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_CHANGED'
      && error.databaseCleared === false,
  )
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'artifact-reference-race-content')
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM job_artifacts WHERE id = ?',
  ).get('artifact-reference-race-owner').count, 1)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM turn_artifacts WHERE id = ?',
  ).get('artifact-reference-race-other').count, 1)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?',
  ).get('user-artifact-reference-race-a').count, 0)
})

test('job artifact writers are fenced while managed files are being staged', () => {
  insertUserFixture('user-artifact-stage-fence-a', 'artifact-stage-fence-a')
  insertUserFixture('user-artifact-stage-fence-b', 'artifact-stage-fence-b')
  const filename = 'artifact-stage-fence.txt'
  const artifactPath = path.join(artifactDir, filename)
  fs.writeFileSync(artifactPath, 'artifact-stage-fence-content')
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'artifact-stage-fence-owner',
    'job-artifact-stage-fence-a',
    'user-artifact-stage-fence-a',
    'Artifact stage fence owner',
    `/api/artifacts/${filename}`,
    filename,
    now,
  )
  let writerError = null
  const fileSystem = {
    renameSync(source, destination) {
      if (!writerError && path.resolve(source) === path.resolve(artifactPath)) {
        try {
          appendJobArtifact({
            id: 'artifact-stage-fence-other',
            jobId: 'job-artifact-stage-fence-b',
            userId: 'user-artifact-stage-fence-b',
            type: 'text',
            title: 'Artifact stage fence other',
            url: `/api/artifacts/${filename}`,
            filename,
            now,
          })
        } catch (error) {
          writerError = error
        }
      }
      return fs.renameSync(source, destination)
    },
  }

  const result = clearAuthoritativeUserData({
    userId: 'user-artifact-stage-fence-a',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
    fileSystem,
  })
  assert.equal(result.ok, true)
  assert.equal(writerError?.code, 'USER_DATA_CLEAR_IN_PROGRESS')
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM job_artifacts WHERE id = ?',
  ).get('artifact-stage-fence-other').count, 0)
  assert.equal(fs.existsSync(artifactPath), false)
})

test('turn artifact writers remain fenced through post-commit physical cleanup', () => {
  insertUserFixture('user-artifact-cleanup-fence-a', 'artifact-cleanup-fence-a')
  insertUserFixture('user-artifact-cleanup-fence-b', 'artifact-cleanup-fence-b')
  const filename = 'artifact-cleanup-fence.txt'
  const artifactPath = path.join(artifactDir, filename)
  fs.writeFileSync(artifactPath, 'artifact-cleanup-fence-content')
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'artifact-cleanup-fence-owner',
    'job-artifact-cleanup-fence-a',
    'user-artifact-cleanup-fence-a',
    'Artifact cleanup fence owner',
    `/api/artifacts/${filename}`,
    filename,
    now,
  )
  let writerError = null
  const fileSystem = {
    rmSync(target, options) {
      if (!writerError) {
        try {
          appendTurnArtifact({
            id: 'artifact-cleanup-fence-other',
            userId: 'user-artifact-cleanup-fence-b',
            sessionId: 'chat-artifact-cleanup-fence-b',
            turnId: 'turn-artifact-cleanup-fence-b',
            type: 'text',
            title: 'Artifact cleanup fence other',
            url: `/api/artifacts/${filename}`,
            filename,
            createdAt: now,
          })
        } catch (error) {
          writerError = error
        }
      }
      return fs.rmSync(target, options)
    },
  }

  const result = clearAuthoritativeUserData({
    userId: 'user-artifact-cleanup-fence-a',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
    fileSystem,
  })
  assert.equal(result.ok, true)
  assert.equal(writerError?.code, 'USER_DATA_CLEAR_IN_PROGRESS')
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM turn_artifacts WHERE id = ?',
  ).get('artifact-cleanup-fence-other').count, 0)
  assert.equal(fs.existsSync(artifactPath), false)
})

test('a durable clear journal serializes clears across different users', () => {
  insertUserFixture('user-global-clear-fence-a', 'global-clear-fence-a')
  insertUserFixture('user-global-clear-fence-b', 'global-clear-fence-b')
  const operationId = crypto.randomUUID()
  db.prepare(`
    INSERT INTO user_data_clear_operations
      (operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
       status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'staging', ?, ?)
  `).run(
    operationId,
    'user-global-clear-fence-a',
    'foreign-clear-test',
    process.pid,
    now + 60_000,
    now,
    now,
  )
  try {
    assert.throws(
      () => clearAuthoritativeUserData({
        userId: 'user-global-clear-fence-b',
        confirmation: USER_DATA_CLEAR_CONFIRMATION,
        db,
        env: process.env,
      }),
      (error) => error.code === 'USER_DATA_CLEAR_IN_PROGRESS'
        && error.statusCode === 409,
    )
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE user_id = ?',
    ).get('user-global-clear-fence-b').count, 1)
  } finally {
    db.prepare('DELETE FROM user_data_clear_operations WHERE operation_id = ?').run(operationId)
  }
})

test('an expired clear lease owned by a live process is never taken over', () => {
  const userId = 'user-live-expired-clear-lease'
  insertUserFixture(userId, 'live-expired-clear-lease')
  const operationId = crypto.randomUUID()
  db.prepare(`
    INSERT INTO user_data_clear_operations
      (operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
       status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'staging', ?, ?)
  `).run(
    operationId,
    userId,
    'foreign-live-expired-clear-test',
    process.pid,
    now - 60_000,
    now - 120_000,
    now - 120_000,
  )
  try {
    assert.throws(
      () => clearAuthoritativeUserData({
        userId,
        confirmation: USER_DATA_CLEAR_CONFIRMATION,
        db,
        env: process.env,
      }),
      (error) => error.code === 'USER_DATA_CLEAR_IN_PROGRESS'
        && error.statusCode === 409,
    )
    assert.deepEqual(db.prepare(`
      SELECT lease_owner, lease_pid, lease_expires_at, status
      FROM user_data_clear_operations WHERE operation_id = ?
    `).get(operationId), {
      lease_owner: 'foreign-live-expired-clear-test',
      lease_pid: process.pid,
      lease_expires_at: now - 60_000,
      status: 'staging',
    })
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE user_id = ?',
    ).get(userId).count, 1)
  } finally {
    db.prepare('DELETE FROM user_data_clear_operations WHERE operation_id = ?').run(operationId)
  }
})

test('v99 clear recovery rejects a partial compaction identity and retains its journal', () => {
  const userId = 'user-partial-compaction-clear-journal'
  const operationId = crypto.randomUUID()
  const identity = activeCompactionPortIdentity()
  insertUserFixture(userId, 'partial-compaction-clear-journal')
  insertCompactionClearJournal({
    operationId,
    userId,
    portId: identity.portId,
  })
  try {
    assert.throws(
      () => clearAuthoritativeUserData({
        userId,
        confirmation: USER_DATA_CLEAR_CONFIRMATION,
        db,
        env: process.env,
      }),
      (error) => error.code === 'USER_DATA_CLEAR_JOURNAL_INVALID'
        && error.incomplete === true
        && error.cleanupPending === true,
    )
    assert.deepEqual(db.prepare(`
      SELECT status, compaction_port_id, compaction_governance_version,
             compaction_digest, compaction_stage_token
      FROM user_data_clear_operations WHERE operation_id = ?
    `).get(operationId), {
      status: 'staging',
      compaction_port_id: identity.portId,
      compaction_governance_version: null,
      compaction_digest: null,
      compaction_stage_token: null,
    })
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE user_id = ?',
    ).get(userId).count, 1)
  } finally {
    db.prepare('DELETE FROM user_data_clear_operations WHERE operation_id = ?').run(operationId)
  }
})

test('v99 clear recovery rejects compaction port id and governance version drift', () => {
  const identity = activeCompactionPortIdentity()
  const cases = [
    {
      marker: 'port-id',
      portId: `${identity.portId}.replacement`,
      governanceVersion: identity.governanceVersion,
    },
    {
      marker: 'governance-version',
      portId: identity.portId,
      governanceVersion: identity.governanceVersion + 1,
    },
  ]
  for (const entry of cases) {
    const userId = `user-compaction-clear-drift-${entry.marker}`
    const operationId = crypto.randomUUID()
    insertUserFixture(userId, `compaction-clear-drift-${entry.marker}`)
    insertCompactionClearJournal({
      operationId,
      userId,
      portId: entry.portId,
      governanceVersion: entry.governanceVersion,
      digest: 'a'.repeat(64),
    })
    try {
      assert.throws(
        () => clearAuthoritativeUserData({
          userId,
          confirmation: USER_DATA_CLEAR_CONFIRMATION,
          db,
          env: process.env,
        }),
        (error) => error.code === 'USER_DATA_CLEAR_COMPACTION_PORT_CHANGED'
          && error.statusCode === 409
          && error.incomplete === true
          && error.cleanupPending === true,
      )
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM user_data_clear_operations
        WHERE operation_id = ? AND status = 'staging'
      `).get(operationId).count, 1)
      assert.equal(db.prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE user_id = ?',
      ).get(userId).count, 1)
    } finally {
      db.prepare('DELETE FROM user_data_clear_operations WHERE operation_id = ?').run(operationId)
    }
  }
})

test('clear recovery rejects journal and adapter terminal-state conflicts without releasing evidence', () => {
  const cases = [
    { marker: 'staging-vs-committed', journalStatus: 'staging', adapterState: 'committed' },
    {
      marker: 'committed-vs-rolled-back',
      journalStatus: 'database_committed',
      adapterState: 'rolled_back',
    },
  ]
  for (const entry of cases) {
    const userId = `user-compaction-terminal-conflict-${entry.marker}`
    const operationId = crypto.randomUUID()
    insertUserFixture(userId, `compaction-terminal-conflict-${entry.marker}`)
    const binding = createTerminalCompactionDeletion({
      userId,
      operationId,
      terminalState: entry.adapterState,
    })
    insertCompactionClearJournal({
      operationId,
      userId,
      status: entry.journalStatus,
      ...binding,
    })
    try {
      assert.throws(
        () => clearAuthoritativeUserData({
          userId,
          confirmation: USER_DATA_CLEAR_CONFIRMATION,
          db,
          env: process.env,
        }),
        (error) => error.code === 'USER_DATA_CLEAR_COMPACTION_RECOVERY_CONFLICT'
          && error.incomplete === true
          && error.cleanupPending === true,
      )
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM user_data_clear_operations
        WHERE operation_id = ? AND status = ? AND compaction_stage_token = ?
      `).get(operationId, entry.journalStatus, binding.stageToken).count, 1)
      assert.equal(db.prepare(
        'SELECT COUNT(*) AS count FROM messages WHERE user_id = ?',
      ).get(userId).count, 1)
    } finally {
      db.prepare('DELETE FROM user_data_clear_operations WHERE operation_id = ?').run(operationId)
    }
  }
})

test('a clear that loses its lease restores staged files without deleting the new owner journal', () => {
  const userId = 'user-clear-lease-loss'
  insertUserFixture(userId, 'clear-lease-loss')
  const filename = 'clear-lease-loss.txt'
  const artifactPath = path.join(artifactDir, filename)
  fs.writeFileSync(artifactPath, 'clear-lease-loss-content')
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'clear-lease-loss-artifact',
    'job-clear-lease-loss',
    userId,
    'Clear lease loss artifact',
    `/api/artifacts/${filename}`,
    filename,
    now,
  )

  let injected = false
  let operationId = null
  const fileSystem = {
    ...fs,
    renameSync(source, destination) {
      fs.renameSync(source, destination)
      if (!injected && path.resolve(source) === path.resolve(artifactPath)) {
        injected = true
        const operation = db.prepare(`
          SELECT operation_id FROM user_data_clear_operations WHERE owner_id = ?
        `).get(userId)
        operationId = operation.operation_id
        db.prepare(`
          UPDATE user_data_clear_operations
          SET lease_owner = ?, lease_pid = ?, lease_expires_at = ?, updated_at = ?
          WHERE operation_id = ?
        `).run('replacement-clear-owner', 999_999, now + 60_000, now, operationId)
      }
    },
  }

  try {
    assert.throws(
      () => clearAuthoritativeUserData({
        userId,
        confirmation: USER_DATA_CLEAR_CONFIRMATION,
        db,
        env: process.env,
        fileSystem,
      }),
      (error) => error.code === 'USER_DATA_CLEAR_LEASE_LOST'
        && error.statusCode === 409
        && error.databaseCleared === false,
    )
    assert.equal(injected, true)
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'clear-lease-loss-content')
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM job_artifacts WHERE id = ?',
    ).get('clear-lease-loss-artifact').count, 1)
    assert.deepEqual(db.prepare(`
      SELECT lease_owner, lease_pid, status
      FROM user_data_clear_operations WHERE operation_id = ?
    `).get(operationId), {
      lease_owner: 'replacement-clear-owner',
      lease_pid: 999_999,
      status: 'staging',
    })
  } finally {
    if (operationId) {
      db.prepare('DELETE FROM user_data_clear_operations WHERE operation_id = ?').run(operationId)
    }
  }
})

test('post-commit artifact cleanup failure remains recoverable without resurrecting database rows', () => {
  insertUserFixture('user-artifact-rm-failure', 'artifact-rm-failure')
  const artifactPath = path.join(artifactDir, 'artifact-rm-failure.txt')
  fs.writeFileSync(artifactPath, 'artifact-rm-failure-content')
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'artifact-rm-failure-row',
    'job-artifact-rm-failure',
    'user-artifact-rm-failure',
    'Artifact rm failure',
    '/api/artifacts/artifact-rm-failure.txt',
    'artifact-rm-failure.txt',
    now,
  )
  let injected = false
  const failingFileSystem = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
    rmSync(target, options) {
      if (!injected) {
        injected = true
        throw new Error('injected artifact rm failure')
      }
      return fs.rmSync(target, options)
    },
  }

  assert.throws(
    () => clearAuthoritativeUserData({
      userId: 'user-artifact-rm-failure',
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: process.env,
      fileSystem: failingFileSystem,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE'
      && error.statusCode === 500
      && error.incomplete === true
      && error.databaseCleared === true
      && error.cleanupPending === true,
  )
  assert.equal(fs.existsSync(artifactPath), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM job_artifacts WHERE id = ?').get('artifact-rm-failure-row').count, 0)
  assert.equal(
    fs.readdirSync(artifactDir).some((name) => name.endsWith('.user-data-staging')),
    true,
  )

  const cleanup = clearAuthoritativeUserData({
    userId: 'user-artifact-rm-failure',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(cleanup.artifactFiles.removed, 0)
  assert.equal(fs.existsSync(artifactPath), false)
  assert.equal(
    fs.readdirSync(artifactDir).some((name) => name.endsWith('.user-data-staging')),
    false,
  )
})

test('a later attachment cleanup failure cannot misreport an already removed artifact as rolled back', async () => {
  insertUserFixture('user-mixed-rm-failure', 'mixed-rm-failure')
  const artifactPath = path.join(artifactDir, 'mixed-rm-failure.txt')
  fs.writeFileSync(artifactPath, 'mixed-artifact-content')
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    'mixed-rm-failure-row',
    'job-mixed-rm-failure',
    'user-mixed-rm-failure',
    'Mixed rm failure',
    '/api/artifacts/mixed-rm-failure.txt',
    'mixed-rm-failure.txt',
    now,
  )
  async function* source() { yield Buffer.from('mixed-attachment-content') }
  const attachment = await createManagedAttachment({
    userId: 'user-mixed-rm-failure',
    id: 'mixed-rm-failure-attachment',
    name: 'mixed-rm-failure.txt',
    mimeType: 'text/plain',
    source: source(),
    env: process.env,
  })
  let removeCalls = 0
  const failingFileSystem = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
    rmSync(target, options) {
      removeCalls += 1
      if (removeCalls === 2) throw new Error('injected second cleanup failure')
      return fs.rmSync(target, options)
    },
  }

  assert.throws(
    () => clearAuthoritativeUserData({
      userId: 'user-mixed-rm-failure',
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: process.env,
      fileSystem: failingFileSystem,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE'
      && error.databaseCleared === true
      && error.cleanupPending === true,
  )
  assert.equal(fs.existsSync(artifactPath), false)
  assert.equal(fs.existsSync(attachment.fullPath), false)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM job_artifacts WHERE id = ?',
  ).get('mixed-rm-failure-row').count, 0)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM managed_attachments WHERE id = ?',
  ).get('mixed-rm-failure-attachment').count, 0)
  assert.equal(db.prepare(`
    SELECT status FROM user_data_clear_operations WHERE owner_id = ?
  `).get('user-mixed-rm-failure').status, 'database_committed')

  const cleanup = clearAuthoritativeUserData({
    userId: 'user-mixed-rm-failure',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(cleanup.ok, true)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?
  `).get('user-mixed-rm-failure').count, 0)
})

test('clear explicitly removes related NO ACTION child rows without user_id and preserves other users', () => {
  insertUserFixture('user-no-owner-a', 'no-owner-a')
  insertUserFixture('user-no-owner-b', 'no-owner-b')
  db.exec(`
    CREATE TABLE governance_clear_parents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL
    );
    CREATE TABLE governance_clear_children (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES governance_clear_parents(id) ON DELETE NO ACTION,
      payload TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO governance_clear_parents (id, user_id, payload)
    VALUES ('clear-parent-a', 'user-no-owner-a', 'a'),
           ('clear-parent-b', 'user-no-owner-b', 'b')
  `).run()
  db.prepare(`
    INSERT INTO governance_clear_children (id, parent_id, payload)
    VALUES ('clear-child-a', 'clear-parent-a', 'a'),
           ('clear-child-b', 'clear-parent-b', 'b')
  `).run()

  const result = clearAuthoritativeUserData({
    userId: 'user-no-owner-a',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(result.ok, true)
  assert.equal(result.deleted.governance_clear_children, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM governance_clear_children WHERE id = ?').get('clear-child-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM governance_clear_parents WHERE id = ?').get('clear-parent-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM governance_clear_children WHERE id = ?').get('clear-child-b').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM governance_clear_parents WHERE id = ?').get('clear-parent-b').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get('user-no-owner-a').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE token = ?').get('auth-no-owner-a').count, 1)
})

test('clear defaults to refusal, rolls back atomically on SQL failure, then clears only the confirmed user', () => {
  const attachmentRow = db.prepare(
    'SELECT storage_path FROM managed_attachments WHERE user_id = ?',
  ).get('user-export-a')
  const attachmentPath = path.join(dataDir, 'attachments', ...attachmentRow.storage_path.split('/'))
  const sidecars = artifactSidecarPaths('artifact-row-a')
  fs.mkdirSync(path.dirname(sidecars.source), { recursive: true })
  fs.mkdirSync(path.join(sidecars.html, 'nested'), { recursive: true })
  fs.writeFileSync(sidecars.source, 'rollback-source')
  fs.writeFileSync(path.join(sidecars.html, 'nested', 'asset.txt'), 'rollback-asset')

  assert.throws(
    () => clearAuthoritativeUserData({ userId: 'user-export-a', confirmation: 'yes', db, env: process.env }),
    (error) => error.code === 'USER_DATA_CLEAR_CONFIRMATION_REQUIRED',
  )
  assert.equal(fs.existsSync(attachmentPath), true)

  db.exec(`
    CREATE TRIGGER block_user_data_clear
    BEFORE DELETE ON messages
    WHEN OLD.user_id = 'user-export-a'
    BEGIN
      SELECT RAISE(ABORT, 'blocked for rollback test');
    END;
  `)
  assert.throws(
    () => clearAuthoritativeUserData({
      userId: 'user-export-a',
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: process.env,
    }),
    /blocked for rollback test/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('user-export-a').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM side_effect_executions WHERE owner_id = ?').get('user-export-a').count, 1)
  assert.equal(fs.existsSync(attachmentPath), true)
  assert.equal(fs.readFileSync(sidecars.source, 'utf8'), 'rollback-source')
  assert.equal(fs.readFileSync(path.join(sidecars.html, 'nested', 'asset.txt'), 'utf8'), 'rollback-asset')
  db.exec('DROP TRIGGER block_user_data_clear')

  const result = clearAuthoritativeUserData({
    userId: 'user-export-a',
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    db,
    env: process.env,
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountPreserved, true)
  assert.equal(result.authenticationSessionsPreserved, true)
  assert.deepEqual(result.retainedAccountFieldsReset, [])
  assert.deepEqual(result.artifactFiles, {
    removed: 1,
    preservedShared: 0,
    alreadyMissing: 0,
  })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get('user-export-a').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE token = ?').get('auth-a').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE token = ?').get('chat-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('user-export-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE user_id = ?').get('user-export-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM managed_attachments WHERE user_id = ?').get('user-export-a').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM side_effect_executions WHERE owner_id = ?').get('user-export-a').count, 0)
  assert.equal(fs.existsSync(attachmentPath), false)
  assert.equal(fs.existsSync(path.join(artifactDir, 'artifact-a.txt')), false)
  assert.equal(fs.existsSync(sidecars.source), false)
  assert.equal(fs.existsSync(sidecars.html), false)

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get('user-export-b').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE token = ?').get('chat-b').count, 1)
  assert.equal(db.prepare('SELECT content FROM messages WHERE user_id = ?').get('user-export-b').content, 'content-b')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM side_effect_executions WHERE owner_id = ?').get('user-export-b').count, 1)
})

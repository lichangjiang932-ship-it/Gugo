import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-outbox-'))
process.env.APP_DATA_DIR = dataDir

const {
  closeDb,
  createUser,
  DB_SCHEMA_VERSION,
  getDb,
} = await import('../server/db.js')
const {
  acknowledgeSessionContentOutbox,
  claimSessionContentOutbox,
  listSessionContentOutbox,
  materializeSessionContentOutbox,
  releaseSessionContentOutboxFailure,
} = await import('../server/services/sessionContentOutboxStore.js')
const {
  claimLocalChatSession,
  deleteMessage,
  deleteSession,
  getSession,
  listMessages,
  replaceSessionMessages,
  upsertMessage,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const {
  claimTurnExecutionLease,
} = await import('../server/services/turnExecutionLeaseStore.js')
const { enqueueTurnSteering } = await import('../server/services/turnSteeringStore.js')
const {
  createSessionContentMaterializerRuntime,
} = await import('../server/services/sessionContentMaterializerRuntime.js')
const { resolveSessionContentPath } = await import('../server/services/sessionJsonlCodec.js')
const {
  readSessionContentProjection,
} = await import('../server/services/sessionJsonlMaterializer.js')
const {
  USER_DATA_CLEAR_CONFIRMATION,
  clearAuthoritativeUserData,
} = await import('../server/services/userDataGovernanceService.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const {
  activateTestCompactionArchivePort,
} = await import('./helpers/testCompactionArchivePort.js')

const compactionArchiveController = activateTestCompactionArchivePort({ env: process.env })

test.after(() => {
  compactionArchiveController.release()
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

let sequence = 0
function fixture(label) {
  sequence += 1
  const userId = `outbox-user-${label}-${sequence}`
  const sessionId = `outbox-session-${label}-${sequence}`
  createUser({ id: userId, email: `${userId}@example.test`, now: 1_000 + sequence })
  upsertSession({
    id: sessionId,
    userId,
    title: label,
    createdAt: 1_000 + sequence,
    updatedAt: 1_000 + sequence,
  })
  return { userId, sessionId }
}

function writeMessage(scope, suffix, timestamp) {
  return upsertMessage({
    id: `${scope.sessionId}:${suffix}`,
    ...scope,
    role: suffix.startsWith('assistant') ? 'assistant' : 'user',
    content: `content ${suffix}`,
    modelContext: { z: 1, a: suffix },
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

test('v94 installs the durable session content outbox contract', () => {
  const db = getDb()
  assert.ok(DB_SCHEMA_VERSION >= 94)
  assert.equal(
    Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value),
    DB_SCHEMA_VERSION,
  )
  const columns = new Set(db.prepare('PRAGMA table_info(session_content_outbox)').all().map((row) => row.name))
  for (const column of [
    'event_id', 'user_id', 'session_id', 'event_type', 'payload_json',
    'event_fingerprint', 'status', 'lease_owner', 'lease_expires_at',
  ]) assert.equal(columns.has(column), true, column)
})

test('message mutation and outbox hand-off commit or roll back together', () => {
  const scope = fixture('atomic')
  writeMessage(scope, 'user-ok', 2_000)
  const rows = listSessionContentOutbox(scope)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].eventType, 'message.upsert')
  assert.equal(rows[0].payload.message.content, 'content user-ok')

  assert.throws(() => upsertMessage({
    id: 'x'.repeat(513),
    ...scope,
    role: 'user',
    content: 'must roll back',
    createdAt: 2_000,
    updatedAt: 2_000,
  }), (error) => error?.code === 'SESSION_JSONL_EVENT_INVALID')
  assert.equal(listMessages(scope).some((message) => message.id === 'x'.repeat(513)), false)
  assert.equal(listSessionContentOutbox(scope).length, 1)
})

test('claim leases only the earliest event per session while allowing cross-session progress', () => {
  const first = fixture('ordered-a')
  const second = {
    userId: first.userId,
    sessionId: `${first.sessionId}:second`,
  }
  upsertSession({
    id: second.sessionId,
    userId: second.userId,
    title: 'ordered-b',
    createdAt: 2_900,
    updatedAt: 2_900,
  })
  writeMessage(first, 'user-1', 3_000)
  writeMessage(first, 'assistant-2', 3_001)
  writeMessage(second, 'user-1', 3_002)

  const claimed = claimSessionContentOutbox({
    ownerId: 'worker-a', userId: first.userId, limit: 10, now: 4_000, leaseMs: 100,
  })
  assert.equal(claimed.length, 2)
  assert.equal(new Set(claimed.map((row) => row.sessionId)).size, 2)
  const firstClaim = claimed.find((row) => row.sessionId === first.sessionId)
  assert.equal(firstClaim.payload.message.id.endsWith(':user-1'), true)
  assert.equal(acknowledgeSessionContentOutbox({
    id: firstClaim.id,
    eventId: firstClaim.eventId,
    ownerId: 'worker-a',
    now: 4_010,
  }), true)

  const next = claimSessionContentOutbox({
    ownerId: 'worker-b', userId: first.userId, limit: 10, now: 4_011, leaseMs: 100,
  })
  assert.equal(next.length, 1)
  assert.equal(next[0].payload.message.id.endsWith(':assistant-2'), true)
  assert.equal(releaseSessionContentOutboxFailure({
    id: next[0].id,
    eventId: next[0].eventId,
    ownerId: 'worker-b',
    error: 'injected append failure',
    now: 4_012,
  }), true)
  const failed = listSessionContentOutbox({ ...first, status: 'pending' })
    .find((row) => row.id === next[0].id)
  assert.equal(failed.attemptCount, 1)
  assert.equal(failed.availableAt > 4_012, true)
})

test('replace, message delete, and session delete produce ordered durable events', () => {
  const scope = fixture('mutations')
  writeMessage(scope, 'user-original', 5_000)
  const initialRevision = getSession(scope).revision
  replaceSessionMessages({
    ...scope,
    expectedRevision: initialRevision,
    now: 5_100,
    messages: [
      { id: `${scope.sessionId}:replacement-a`, role: 'user', content: 'A', createdAt: 5_010 },
      { id: `${scope.sessionId}:replacement-b`, role: 'assistant', content: 'B', createdAt: 5_020 },
    ],
  })
  assert.equal(deleteMessage({ userId: scope.userId, messageId: `${scope.sessionId}:replacement-a` }), true)
  assert.equal(deleteSession({
    ...scope,
    expectedRevision: getSession(scope).revision,
  })?.deleted, true)
  assert.equal(getSession(scope), null)
  assert.deepEqual(
    listSessionContentOutbox(scope).map((row) => row.eventType),
    ['message.upsert', 'session.replace', 'message.delete', 'session.delete'],
  )
})

test('legacy owner claim closes the old stream and snapshots the new owner stream', () => {
  const oldScope = fixture('legacy-owner')
  const newUserId = `new-owner-${sequence}`
  createUser({ id: newUserId, email: `${newUserId}@example.test`, now: 6_000 })
  writeMessage(oldScope, 'user-legacy', 6_010)
  getDb().prepare(`
    INSERT INTO meta (key, value) VALUES ('local_auth_owner_user_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(newUserId)

  const claimed = claimLocalChatSession({
    userId: newUserId,
    sessionId: oldScope.sessionId,
    authMode: 'local',
    now: 6_100,
  })
  assert.equal(claimed.id, oldScope.sessionId)
  assert.equal(listSessionContentOutbox(oldScope).at(-1).eventType, 'session.delete')
  const replacement = listSessionContentOutbox({
    userId: newUserId,
    sessionId: oldScope.sessionId,
  }).at(-1)
  assert.equal(replacement.eventType, 'session.replace')
  assert.equal(replacement.payload.messages[0].content, 'content user-legacy')
})

test('steering idempotency creates exactly one canonical message event', () => {
  const scope = fixture('steering')
  const turnId = `${scope.sessionId}:turn`
  appendTurnEvent({
    userId: scope.userId,
    event: createTurnEvent({
      id: `${turnId}:started`,
      sessionId: scope.sessionId,
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: {},
      createdAt: 7_000,
    }),
  })
  assert.equal(claimTurnExecutionLease({
    ...scope,
    turnId,
    ownerId: 'steering-worker',
    now: 7_001,
    leaseMs: 10_000,
  }), true)
  const input = {
    ...scope,
    turnId,
    content: '追加一条约束',
    clientRequestId: 'steering-request',
  }
  const first = enqueueTurnSteering({ ...input, now: 7_010 })
  const replay = enqueueTurnSteering({ ...input, now: 7_020 })
  assert.equal(replay.id, first.id)
  const events = listSessionContentOutbox(scope)
    .filter((row) => row.eventType === 'message.upsert')
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.message.id, first.messageId)
})

test('runtime drains a durable event to JSONL and authoritative clear removes both domains', async () => {
  const scope = fixture('runtime-clear')
  writeMessage(scope, 'user-runtime', 8_000)
  const errors = []
  const runtime = createSessionContentMaterializerRuntime({
    env: { APP_DATA_DIR: dataDir },
    intervalMs: 60_000,
    claim: (options) => claimSessionContentOutbox({ ...options, userId: scope.userId }),
    onError: (error) => errors.push(error),
  })
  runtime.start()
  await runtime.drainOnce()
  await runtime.close()
  assert.deepEqual(errors, [])
  const paths = resolveSessionContentPath({ ...scope, env: { APP_DATA_DIR: dataDir } })
  assert.equal(fs.existsSync(paths.filePath), true)
  assert.equal(listSessionContentOutbox(scope).at(-1).status, 'materialized')

  const result = clearAuthoritativeUserData({
    userId: scope.userId,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    requirePreview: false,
    env: { APP_DATA_DIR: dataDir },
    tempDir: dataDir,
  })
  assert.equal(result.ok, true)
  assert.equal(fs.existsSync(paths.userDirectory), false)
  assert.equal(getSession(scope), null)
  assert.deepEqual(listSessionContentOutbox(scope), [])
})

test('default runtime physically compacts a deleted message before acknowledging it', async () => {
  const scope = fixture('runtime-delete-privacy')
  const message = upsertMessage({
    id: `${scope.sessionId}:private-message`,
    ...scope,
    role: 'user',
    content: 'runtime-deleted-secret-must-not-remain',
    createdAt: 8_100,
    updatedAt: 8_100,
  })
  const runtime = createSessionContentMaterializerRuntime({
    env: { APP_DATA_DIR: dataDir },
    intervalMs: 60_000,
    claim: (options) => claimSessionContentOutbox({ ...options, userId: scope.userId }),
  })
  try {
    await runtime.drainOnce()
    const paths = resolveSessionContentPath({ ...scope, env: { APP_DATA_DIR: dataDir } })
    assert.match(fs.readFileSync(paths.filePath, 'utf8'), /runtime-deleted-secret-must-not-remain/)
    assert.equal(deleteMessage({ userId: scope.userId, messageId: message.id }), true)
    await runtime.drainOnce()
    assert.doesNotMatch(
      fs.readFileSync(paths.filePath, 'utf8'),
      /runtime-deleted-secret-must-not-remain/,
    )
    assert.deepEqual(readSessionContentProjection({
      ...scope,
      env: { APP_DATA_DIR: dataDir },
    }).messages, [])
    assert.equal(listSessionContentOutbox(scope).every((row) => row.status === 'materialized'), true)
  } finally {
    await runtime.close()
  }
})

test('started runtime performs one final outbox drain during close', async () => {
  const pending = []
  const appended = []
  const acknowledged = []
  const runtime = createSessionContentMaterializerRuntime({
    intervalMs: 60_000,
    ownerId: 'final-drain-worker',
    claim: () => pending.splice(0),
    materialize: null,
    append: (row) => {
      appended.push(row.id)
      return { id: row.id }
    },
    acknowledge: ({ id }) => {
      acknowledged.push(id)
      return true
    },
    releaseFailure: () => {
      throw new Error('final drain should not release a successful row')
    },
  })

  runtime.start()
  await runtime.drainOnce()
  pending.push({ id: 91, eventId: 'final-drain-event' })
  await runtime.close()

  assert.deepEqual(appended, [91])
  assert.deepEqual(acknowledged, [91])
})

test('authoritative clear refuses a live materializer lease without deleting data', () => {
  const scope = fixture('lease-clear')
  writeMessage(scope, 'user-leased', 9_000)
  const [leased] = claimSessionContentOutbox({
    ownerId: 'clear-blocking-worker',
    userId: scope.userId,
    now: Date.now(),
    leaseMs: 60_000,
  })
  assert.ok(leased)
  assert.throws(() => clearAuthoritativeUserData({
    userId: scope.userId,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    requirePreview: false,
    env: { APP_DATA_DIR: dataDir },
    tempDir: dataDir,
  }), (error) => error?.code === 'USER_DATA_CLEAR_RUNTIME_ACTIVE'
    && error?.blockers?.some((blocker) => blocker.kind === 'session_content_materializer'))
  assert.ok(getSession(scope))
  assert.equal(listMessages(scope).length, 1)
  assert.equal(releaseSessionContentOutboxFailure({
    id: leased.id,
    eventId: leased.eventId,
    ownerId: 'clear-blocking-worker',
    error: 'test cleanup',
    now: Date.now(),
  }), true)
})

test('transactional materialization rejects an expired worker before any file mutation', () => {
  const scope = fixture('expired-materializer-fence')
  writeMessage(scope, 'user-expired-fence', 10_000)
  const [leased] = claimSessionContentOutbox({
    ownerId: 'expired-materializer-worker',
    userId: scope.userId,
    now: 10_000,
    leaseMs: 100,
  })
  let appendCalls = 0
  assert.throws(() => materializeSessionContentOutbox({
    id: leased.id,
    eventId: leased.eventId,
    ownerId: 'expired-materializer-worker',
    now: 10_101,
  }, () => {
    appendCalls += 1
  }), (error) => error?.code === 'SESSION_CONTENT_OUTBOX_LEASE_LOST')
  assert.equal(appendCalls, 0)
  assert.equal(listSessionContentOutbox(scope).at(-1).status, 'leased')
})

test('default runtime routes stale rows through the transactional lease fence', async () => {
  const scope = fixture('runtime-expired-fence')
  writeMessage(scope, 'user-runtime-expired', 10_500)
  const [leased] = claimSessionContentOutbox({
    ownerId: 'runtime-expired-worker',
    userId: scope.userId,
    now: 10_500,
    leaseMs: 100,
  })
  let appendCalls = 0
  const errors = []
  const runtime = createSessionContentMaterializerRuntime({
    ownerId: 'runtime-expired-worker',
    intervalMs: 60_000,
    claim: () => [leased],
    append: () => {
      appendCalls += 1
    },
    onError: (error) => errors.push(error),
  })
  const results = await runtime.drainOnce()
  await runtime.close()
  assert.equal(results[0].ok, false)
  assert.equal(results[0].error?.code, 'SESSION_CONTENT_OUTBOX_LEASE_LOST')
  assert.equal(errors.length, 1)
  assert.equal(appendCalls, 0)
})

test('expired worker cannot recreate a session sidecar after authoritative clear commits', () => {
  const scope = fixture('clear-stale-materializer')
  writeMessage(scope, 'user-clear-stale', 11_000)
  const [leased] = claimSessionContentOutbox({
    ownerId: 'clear-stale-worker',
    userId: scope.userId,
    now: 11_000,
    leaseMs: 100,
  })
  const paths = resolveSessionContentPath({ ...scope, env: { APP_DATA_DIR: dataDir } })
  fs.mkdirSync(paths.userDirectory, { recursive: true })
  fs.writeFileSync(paths.filePath, 'stale pre-clear bytes\n')

  const cleared = clearAuthoritativeUserData({
    userId: scope.userId,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    requirePreview: false,
    env: { APP_DATA_DIR: dataDir },
    tempDir: dataDir,
  })
  assert.equal(cleared.ok, true)
  assert.equal(fs.existsSync(paths.userDirectory), false)

  let appendCalls = 0
  assert.throws(() => materializeSessionContentOutbox({
    id: leased.id,
    eventId: leased.eventId,
    ownerId: 'clear-stale-worker',
    now: Date.now(),
  }, () => {
    appendCalls += 1
    fs.mkdirSync(paths.userDirectory, { recursive: true })
  }), (error) => error?.code === 'SESSION_CONTENT_OUTBOX_LEASE_LOST')
  assert.equal(appendCalls, 0)
  assert.equal(fs.existsSync(paths.userDirectory), false)
})

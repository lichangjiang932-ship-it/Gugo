import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-side-effect-recovery-'))
const previousDataDir = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, getDb } = await import('../server/db.js')
const {
  createSideEffectExecutionLedger,
  pruneSideEffectExecutions,
  resolveSideEffectRetentionPolicy,
} = await import('../server/services/sideEffectExecutionLedger.js')
const {
  listSideEffectHistory,
  listUnknownSideEffects,
  resolveUnknownSideEffect,
} = await import('../server/services/sideEffectRecoveryService.js')
const { appendJobSteps, createJob } = await import('../server/services/jobStore.js')
const { saveJobTurnCheckpoint } = await import('../server/services/jobTurnCheckpointStore.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const {
  appendTurnEvent,
  appendTurnEventsInTransaction,
} = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({ AUTH_MODE: 'local' }) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function authHeaders(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

function sideEffectInput(ownerId, marker) {
  return {
    scope: {
      ownerId,
      kind: 'job',
      scopeKey: JSON.stringify(['job', `job-${marker}`, `step-${marker}`]),
      sessionId: null,
      turnId: null,
      jobId: `job-${marker}`,
      stepId: `step-${marker}`,
    },
    toolCallId: `call-${marker}`,
    idempotencyKey: `idempotency-${marker}`,
    toolName: 'write_file',
    args: { path: `/tmp/${marker}.txt`, content: marker },
  }
}

function createUnknown(ownerId, marker, outcome = undefined) {
  const ledger = createSideEffectExecutionLedger({ db: getDb() })
  const input = sideEffectInput(ownerId, marker)
  assert.equal(ledger.prepare(input).status, 'prepared')
  assert.equal(ledger.claimExecution(input).claimed, true)
  assert.equal(ledger.markUnknown(input, { outcome }).status, 'unknown')
  return { input, ledger }
}

function createFinished(ownerId, marker, status = 'committed') {
  const ledger = createSideEffectExecutionLedger({ db: getDb() })
  const input = sideEffectInput(ownerId, marker)
  ledger.prepare(input)
  ledger.claimExecution(input)
  ledger.finish(input, { status, outcome: { ok: status === 'committed', marker } })
  return { input, ledger }
}

function createParentJob(ownerId, marker, { status = 'completed', checkpoint = false } = {}) {
  const jobId = `job-${marker}`
  const stepId = `step-${marker}`
  createJob({
    id: jobId,
    userId: ownerId,
    title: marker,
    prompt: marker,
    status,
    now: 1,
  })
  appendJobSteps(jobId, [{
    id: stepId,
    title: marker,
    kind: 'execute',
    status: status === 'completed' ? 'completed' : 'queued',
  }], 1)
  if (checkpoint) {
    saveJobTurnCheckpoint({
      jobId,
      stepId,
      userId: ownerId,
      state: { phase: 'execute-tool-calls', toolCalls: [] },
      now: 2,
    })
  }
}

function setFinishedAt(input, timestamp) {
  getDb().prepare(`
    UPDATE side_effect_executions
    SET finished_at = ?, updated_at = ?
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
  `).run(timestamp, timestamp, input.scope.ownerId, input.scope.scopeKey, input.toolCallId)
}

function hasExecution(input) {
  return getDb().prepare(`
    SELECT COUNT(*) AS count FROM side_effect_executions
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
  `).get(input.scope.ownerId, input.scope.scopeKey, input.toolCallId).count === 1
}

test('side-effect recovery endpoints require authentication', async () => {
  const getResponse = await fetch(`${origin}/api/side-effects/unknown`)
  assert.equal(getResponse.status, 401)
  assert.equal((await getResponse.json()).error.code, 'UNAUTHORIZED')

  const postResponse = await fetch(`${origin}/api/side-effects/resolve`, { method: 'POST' })
  assert.equal(postResponse.status, 401)
  assert.equal((await postResponse.json()).error.code, 'UNAUTHORIZED')
})

test('unknown side effects are listed only for their authenticated owner', async () => {
  const alice = issueTestSession({ email: 'side-effects-list-alice@example.com' })
  const bob = issueTestSession({ email: 'side-effects-list-bob@example.com' })
  const aliceUnknown = createUnknown(alice.userId, 'list-alice-unknown').input
  createUnknown(bob.userId, 'list-bob-unknown')
  createFinished(alice.userId, 'list-alice-committed')

  const response = await fetch(`${origin}/api/side-effects/unknown?limit=100`, {
    headers: authHeaders(alice.token),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const body = await response.json()
  assert.deepEqual(body.records.map((record) => record.toolCallId), [aliceUnknown.toolCallId])
  assert.ok(body.records.every((record) => record.status === 'unknown'))
  assert.ok(body.records.every((record) => /^[a-f0-9]{64}$/.test(record.argsDigest)))
  assert.ok(body.records.every((record) => !Object.hasOwn(record, 'ownerId')))
  assert.ok(body.records.every((record) => !Object.hasOwn(record, 'idempotencyKey')))
  assert.ok(body.records.every((record) => !Object.hasOwn(record, 'outcome')))
})

test('unknown side effects use stable owner-bound keyset pagination', async () => {
  const owner = issueTestSession({ email: 'side-effects-pagination@example.com' })
  const other = issueTestSession({ email: 'side-effects-pagination-other@example.com' })
  const inputs = ['05', '01', '04', '02', '03'].map((marker) => (
    createUnknown(owner.userId, `pagination-${marker}`).input
  ))
  createUnknown(other.userId, 'pagination-other')
  for (const input of inputs) {
    getDb().prepare(`
      UPDATE side_effect_executions SET updated_at = ?
      WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
    `).run(99_999, owner.userId, input.scope.scopeKey, input.toolCallId)
  }

  const seen = []
  let cursor = null
  do {
    const query = new URLSearchParams({ limit: '2' })
    if (cursor) query.set('cursor', cursor)
    const response = await fetch(`${origin}/api/side-effects/unknown?${query}`, {
      headers: authHeaders(owner.token),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(Object.keys(body).sort(), ['nextCursor', 'records'])
    assert.ok(body.records.length <= 2)
    seen.push(...body.records.map((record) => record.toolCallId))
    cursor = body.nextCursor
  } while (cursor)

  const expected = [...inputs]
    .sort((left, right) => left.scope.scopeKey.localeCompare(right.scope.scopeKey)
      || left.toolCallId.localeCompare(right.toolCallId))
    .map((input) => input.toolCallId)
  assert.deepEqual(seen, expected)
  assert.equal(new Set(seen).size, seen.length)
})

test('side-effect cursors reject malformed, cross-endpoint, and cross-owner reuse', async () => {
  const alice = issueTestSession({ email: 'side-effects-cursor-alice@example.com' })
  const bob = issueTestSession({ email: 'side-effects-cursor-bob@example.com' })
  createUnknown(alice.userId, 'cursor-alice-1')
  createUnknown(alice.userId, 'cursor-alice-2')
  createUnknown(bob.userId, 'cursor-bob')

  const first = await fetch(`${origin}/api/side-effects/unknown?limit=1`, {
    headers: authHeaders(alice.token),
  })
  assert.equal(first.status, 200)
  const cursor = (await first.json()).nextCursor
  assert.equal(typeof cursor, 'string')
  assert.ok(cursor.length > 0)

  for (const [session, pathname] of [
    [alice, `/api/side-effects/unknown?cursor=${encodeURIComponent('not-a-cursor')}`],
    [alice, `/api/side-effects/history?cursor=${encodeURIComponent(cursor)}`],
    [bob, `/api/side-effects/unknown?cursor=${encodeURIComponent(cursor)}`],
  ]) {
    const response = await fetch(`${origin}${pathname}`, { headers: authHeaders(session.token) })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'SIDE_EFFECT_RECOVERY_CURSOR_INVALID')
  }
})

test('unknown side-effect records expose only bounded redacted recovery evidence', async () => {
  const owner = issueTestSession({ email: 'side-effects-safe-evidence@example.com' })
  const secret = 'top-secret-token-value'
  const returnedOutcome = {
    ok: true,
    stdout: `Bearer ${secret}`,
    error: `password=${secret}`,
    url: `https://user:${secret}@example.com/export/report?token=${secret}#private`,
    changedPaths: [`/tmp/report.txt?token=${secret}`],
    verifiedOutputs: [{
      path: '/tmp/report.txt',
      sha256: 'c'.repeat(64),
      secret,
      content: secret,
    }],
    artifactIds: ['artifact-safe-evidence'],
    artifacts: [{
      id: 'artifact-safe-evidence',
      url: `https://example.com/artifacts/report?api_key=${secret}`,
      content: secret,
    }],
  }
  const { input, ledger } = createUnknown(owner.userId, 'safe-evidence', returnedOutcome)

  const response = await fetch(`${origin}/api/side-effects/unknown?limit=100`, {
    headers: authHeaders(owner.token),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  const record = body.records.find((item) => item.toolCallId === input.toolCallId)
  assert.ok(record)
  assert.equal(record.argsDigest, ledger.read(input).argsDigest)
  assert.deepEqual(record.evidence.changedPaths, ['/tmp/report.txt?token=[REDACTED]'])
  assert.deepEqual(record.evidence.verifiedOutputs, [{
    target: '/tmp/report.txt',
    sha256: 'c'.repeat(64),
  }])
  assert.deepEqual(record.evidence.artifactIds, ['artifact-safe-evidence'])
  assert.ok(record.evidence.targetSummary.includes('https://example.com/[REDACTED_PATH]'))
  assert.equal(Object.hasOwn(record, 'outcome'), false)
  assert.equal(Object.hasOwn(record, 'ownerId'), false)
  assert.equal(Object.hasOwn(record, 'idempotencyKey'), false)
  const serialized = JSON.stringify(record)
  assert.doesNotMatch(serialized, /top-secret-token-value/)
  assert.doesNotMatch(serialized, /stdout|password|content/)
})

test('prepare persists a bounded intent summary when an unknown execution has no outcome', async () => {
  const owner = issueTestSession({ email: 'side-effects-intent-summary@example.com' })
  const secret = 'T00000000/B00000000/abcdefghijklmnopqrstuvwxyz'
  const input = {
    ...sideEffectInput(owner.userId, 'intent-summary'),
    toolName: 'send_webhook',
    args: {
      path: '/tmp/report.txt',
      destination: 'release-channel',
      url: `https://hooks.slack.com/services/${secret}?token=never-store#private`,
      command: `curl --api-key never-store https://hooks.slack.com/services/${secret}`,
      content: 'must never be persisted',
    },
  }
  const ledger = createSideEffectExecutionLedger({ db: getDb() })
  ledger.prepare(input)
  ledger.claimExecution(input)
  ledger.markUnknown(input)

  const response = await fetch(`${origin}/api/side-effects/unknown?limit=100`, {
    headers: authHeaders(owner.token),
  })
  assert.equal(response.status, 200)
  const record = (await response.json()).records.find((item) => item.toolCallId === input.toolCallId)
  assert.ok(record)
  assert.equal(record.intentSummary.toolName, 'send_webhook')
  assert.ok(record.intentSummary.targets.some((target) => target.value === '/tmp/report.txt'))
  assert.ok(record.intentSummary.targets.some((target) => target.value === 'https://hooks.slack.com/[REDACTED_PATH]'))
  assert.ok(record.evidence.targetSummary.includes('https://hooks.slack.com/[REDACTED_PATH]'))
  const serialized = JSON.stringify(record)
  assert.doesNotMatch(serialized, /never-store|abcdefghijklmnopqrstuvwxyz|must never be persisted/)
  assert.doesNotMatch(serialized, /[?#]private|\?token=/)
})

test('a user cannot observe or resolve another owner side effect', async () => {
  const alice = issueTestSession({ email: 'side-effects-owner-alice@example.com' })
  const bob = issueTestSession({ email: 'side-effects-owner-bob@example.com' })
  const { input, ledger } = createUnknown(bob.userId, 'owner-bob')

  const response = await fetch(`${origin}/api/side-effects/resolve`, {
    method: 'POST',
    headers: authHeaders(alice.token, true),
    body: JSON.stringify({
      userId: bob.userId,
      scopeKey: input.scope.scopeKey,
      toolCallId: input.toolCallId,
      verificationConfirmed: true,
      confirmToolCallId: input.toolCallId,
      resolution: 'committed',
    }),
  })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, 'SIDE_EFFECT_RECOVERY_NOT_FOUND')
  assert.equal(ledger.read(input).status, 'unknown')
})

test('manual committed confirmation is audited, retained, and replayed only as a result', async () => {
  const alice = issueTestSession({ email: 'side-effects-commit@example.com' })
  const returnedOutcome = {
    ok: true,
    stdout: 'x'.repeat(256 * 1024),
    artifactIds: ['artifact-confirmed'],
    verifiedOutputs: [{ path: '/tmp/confirmed.txt', sha256: 'b'.repeat(64) }],
    changedPaths: ['/tmp/confirmed.txt'],
  }
  const { input, ledger } = createUnknown(
    alice.userId,
    'confirm-committed',
    returnedOutcome,
  )
  const response = await fetch(`${origin}/api/side-effects/resolve`, {
    method: 'POST',
    headers: authHeaders(alice.token, true),
    body: JSON.stringify({
      scopeKey: input.scope.scopeKey,
      toolCallId: input.toolCallId,
      verificationConfirmed: true,
      confirmToolCallId: input.toolCallId,
      resolution: 'committed',
      note: 'Verified the file on disk.',
    }),
  })
  assert.equal(response.status, 200)
  const responseBody = await response.json()
  const record = responseBody.record
  assert.deepEqual(responseBody.resume, {
    kind: 'job',
    jobId: input.scope.jobId,
    stepId: input.scope.stepId,
  })
  assert.equal(record.status, 'committed')
  assert.equal(Object.hasOwn(record, 'scopeKey'), false)
  assert.equal(Object.hasOwn(record, 'outcome'), false)
  assert.equal(Object.hasOwn(record, 'ownerId'), false)
  assert.equal(Object.hasOwn(record, 'idempotencyKey'), false)
  assert.deepEqual(record.evidence.artifactIds, returnedOutcome.artifactIds)
  assert.deepEqual(record.evidence.verifiedOutputs, returnedOutcome.verifiedOutputs.map((output) => ({
    target: output.path,
    sha256: output.sha256,
  })))
  assert.deepEqual(record.evidence.changedPaths, returnedOutcome.changedPaths)

  const persisted = ledger.prepare(input)
  assert.equal(persisted.status, 'committed')
  const persistedOutcome = ledger.parseOutcome(persisted)
  assert.equal(persistedOutcome.userConfirmed, true)
  assert.equal(Object.hasOwn(persistedOutcome, 'audit'), false)
  assert.equal(persisted.audit.action, 'resolve_unknown_side_effect')
  assert.equal(persisted.audit.resolution, 'committed')
  assert.equal(persisted.audit.note, 'Verified the file on disk.')
  assert.deepEqual(persistedOutcome.artifactIds, returnedOutcome.artifactIds)
  assert.deepEqual(persistedOutcome.verifiedOutputs, returnedOutcome.verifiedOutputs)
  assert.deepEqual(persistedOutcome.changedPaths, returnedOutcome.changedPaths)
  assert.equal(persistedOutcome.stdout, undefined)
  assert.equal(persistedOutcome.sideEffectLedgerReplay, true)
  const claim = ledger.claimExecution(input)
  assert.equal(claim.claimed, false)
  assert.equal(claim.record.status, 'committed')
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM side_effect_executions
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
  `).get(alice.userId, input.scope.scopeKey, input.toolCallId).count, 1)

  const repeated = await fetch(`${origin}/api/side-effects/resolve`, {
    method: 'POST',
    headers: authHeaders(alice.token, true),
    body: JSON.stringify({
      scopeKey: input.scope.scopeKey,
      toolCallId: input.toolCallId,
      verificationConfirmed: true,
      confirmToolCallId: input.toolCallId,
      resolution: 'failed',
    }),
  })
  assert.equal(repeated.status, 409)
  assert.equal((await repeated.json()).error.code, 'SIDE_EFFECT_RECOVERY_CONFLICT')
  assert.equal(ledger.read(input).status, 'committed')
})

test('manual failed confirmation preserves safe evidence but not unsafe outcome fields', () => {
  const owner = issueTestSession({ email: 'side-effects-failed@example.com' })
  const { input, ledger } = createUnknown(owner.userId, 'confirm-failed', {
    ok: true,
    stdout: 'small secret-bearing stdout must not be replayed',
    error: 'small secret-bearing error must not be replayed',
    outputPath: '/tmp/failed-output.txt',
    target: '/tmp/failed-target.txt',
    destination: '/tmp/failed-destination.txt',
    changedPaths: ['/tmp/failed-output.txt'],
  })
  const record = resolveUnknownSideEffect({
    userId: owner.userId,
    scopeKey: input.scope.scopeKey,
    toolCallId: input.toolCallId,
    verificationConfirmed: true,
    confirmToolCallId: input.toolCallId,
    resolution: 'failed',
    note: 'Verified that no output was created.',
    now: () => 123_456,
  })
  assert.equal(record.status, 'failed')
  assert.equal(record.finishedAt, 123_456)
  assert.equal(record.outcome.ok, false)
  assert.equal(record.outcome.code, 'SIDE_EFFECT_USER_CONFIRMED_FAILED')
  assert.equal(record.outcome.outputPath, '/tmp/failed-output.txt')
  assert.equal(record.outcome.target, '/tmp/failed-target.txt')
  assert.equal(record.outcome.destination, '/tmp/failed-destination.txt')
  assert.deepEqual(record.outcome.changedPaths, ['/tmp/failed-output.txt'])
  assert.equal(record.outcome.stdout, undefined)
  assert.equal(record.outcome.error, undefined)
  assert.equal(Object.hasOwn(record.outcome, 'audit'), false)
  assert.equal(record.audit.confirmedAt, 123_456)
  assert.equal(record.audit.note, 'Verified that no output was created.')
  assert.equal(ledger.prepare(input).status, 'failed')
  assert.equal(ledger.claimExecution(input).claimed, false)
  const replay = ledger.parseOutcome(ledger.read(input))
  assert.equal(replay.sideEffectLedgerReplay, true)
  assert.equal(replay.stdout, undefined)
  assert.equal(replay.error, undefined)
  assert.equal(Object.hasOwn(replay, 'audit'), false)
})

test('manual disposition history is paginated, owner-scoped, and exposes only local audit DTOs', async () => {
  const owner = issueTestSession({ email: 'side-effects-history@example.com' })
  const other = issueTestSession({ email: 'side-effects-history-other@example.com' })
  const entries = ['03', '01', '02'].map((marker, index) => {
    const created = createUnknown(owner.userId, `history-${marker}`, {
      ok: true,
      outputPath: `/tmp/history-${marker}.txt`,
      stdout: `private-${marker}`,
    })
    resolveUnknownSideEffect({
      userId: owner.userId,
      scopeKey: created.input.scope.scopeKey,
      toolCallId: created.input.toolCallId,
      verificationConfirmed: true,
      confirmToolCallId: created.input.toolCallId,
      resolution: index % 2 === 0 ? 'committed' : 'failed',
      note: `history-note-${marker}`,
      now: () => 77_777,
    })
    return created
  })
  createFinished(owner.userId, 'history-automatic')
  const otherEntry = createUnknown(other.userId, 'history-other')
  resolveUnknownSideEffect({
    userId: other.userId,
    scopeKey: otherEntry.input.scope.scopeKey,
    toolCallId: otherEntry.input.toolCallId,
    verificationConfirmed: true,
    confirmToolCallId: otherEntry.input.toolCallId,
    resolution: 'committed',
    note: 'other-owner-note',
    now: () => 77_777,
  })

  const records = []
  let cursor = null
  do {
    const query = new URLSearchParams({ limit: '2' })
    if (cursor) query.set('cursor', cursor)
    const response = await fetch(`${origin}/api/side-effects/history?${query}`, {
      headers: authHeaders(owner.token),
    })
    assert.equal(response.status, 200)
    const page = await response.json()
    records.push(...page.records)
    cursor = page.nextCursor
  } while (cursor)

  const expected = [...entries]
    .sort((left, right) => left.input.scope.scopeKey.localeCompare(right.input.scope.scopeKey)
      || left.input.toolCallId.localeCompare(right.input.toolCallId))
    .map((entry) => entry.input.toolCallId)
  assert.deepEqual(records.map((record) => record.toolCallId), expected)
  assert.equal(new Set(records.map((record) => record.toolCallId)).size, entries.length)
  for (const record of records) {
    assert.equal(record.audit.confirmedAt, 77_777)
    assert.equal(record.audit.confirmedBy, owner.userId)
    assert.match(record.audit.note, /^history-note-/)
    assert.equal(Object.hasOwn(record, 'scopeKey'), false)
    assert.equal(Object.hasOwn(record, 'outcome'), false)
    assert.equal(Object.hasOwn(record, 'ownerId'), false)
    assert.equal(Object.hasOwn(record, 'idempotencyKey'), false)
  }
  assert.doesNotMatch(JSON.stringify(records), /history-automatic|other-owner-note|private-/)

  for (const entry of entries) {
    const replay = entry.ledger.parseOutcome(entry.ledger.read(entry.input))
    assert.equal(Object.hasOwn(replay, 'audit'), false)
    assert.equal(replay.stdout, undefined)
  }

  const directPage = listSideEffectHistory({ userId: owner.userId, limit: 100 })
  assert.equal(directPage.records.length, entries.length)
})

test('concurrent manual confirmations have exactly one winner', async () => {
  const owner = issueTestSession({ email: 'side-effects-race@example.com' })
  const { input } = createUnknown(owner.userId, 'confirmation-race')
  const request = (resolution) => fetch(`${origin}/api/side-effects/resolve`, {
    method: 'POST',
    headers: authHeaders(owner.token, true),
    body: JSON.stringify({
      scopeKey: input.scope.scopeKey,
      toolCallId: input.toolCallId,
      verificationConfirmed: true,
      confirmToolCallId: input.toolCallId,
      resolution,
      note: `winner-${resolution}`,
    }),
  })
  const responses = await Promise.all([request('committed'), request('failed')])
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])

  const row = getDb().prepare(`
    SELECT status, outcome_json, audit_json FROM side_effect_executions
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
  `).get(owner.userId, input.scope.scopeKey, input.toolCallId)
  const outcome = JSON.parse(row.outcome_json)
  const audit = JSON.parse(row.audit_json)
  assert.equal(outcome.userConfirmed, true)
  assert.equal(Object.hasOwn(outcome, 'audit'), false)
  assert.equal(audit.resolution, row.status)
  assert.equal(audit.note, `winner-${row.status}`)
})

test('turn recovery returns only the owner-scoped minimal resume descriptor after CAS', async () => {
  const owner = issueTestSession({ email: 'side-effects-turn-resume@example.com' })
  const input = {
    ...sideEffectInput(owner.userId, 'turn-resume'),
    scope: {
      ownerId: owner.userId,
      kind: 'turn',
      scopeKey: JSON.stringify(['turn', 'session-resume', 'turn-resume']),
      sessionId: 'session-resume',
      turnId: 'turn-resume',
      jobId: null,
      stepId: 'step-resume',
    },
  }
  const ledger = createSideEffectExecutionLedger({ db: getDb() })
  ledger.prepare(input)
  ledger.claimExecution(input)
  ledger.markUnknown(input)

  const response = await fetch(`${origin}/api/side-effects/resolve`, {
    method: 'POST',
    headers: authHeaders(owner.token, true),
    body: JSON.stringify({
      scopeKey: input.scope.scopeKey,
      toolCallId: input.toolCallId,
      verificationConfirmed: true,
      confirmToolCallId: input.toolCallId,
      resolution: 'failed',
      note: 'private operator note',
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.resume, {
    kind: 'turn',
    sessionId: 'session-resume',
    turnId: 'turn-resume',
    toolCallId: input.toolCallId,
  })
  assert.equal(Object.hasOwn(body.record, 'scopeKey'), false)
  const serialized = JSON.stringify(body)
  assert.doesNotMatch(serialized, new RegExp(owner.userId))
  assert.doesNotMatch(serialized, /private operator note|"(?:outcome|args|idempotencyKey|note|confirmedBy)"/i)
})

test('recovery confirmation cannot be bypassed or applied to a different tool call', async () => {
  const owner = issueTestSession({ email: 'side-effects-confirmation-guard@example.com' })
  const { input, ledger } = createUnknown(owner.userId, 'confirmation-guard')
  const request = async (confirmation) => {
    const response = await fetch(`${origin}/api/side-effects/resolve`, {
      method: 'POST',
      headers: authHeaders(owner.token, true),
      body: JSON.stringify({
        scopeKey: input.scope.scopeKey,
        toolCallId: input.toolCallId,
        resolution: 'committed',
        ...confirmation,
      }),
    })
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.equal(ledger.read(input).status, 'unknown')
    return body.error.code
  }

  assert.equal(
    await request({ confirmToolCallId: input.toolCallId }),
    'SIDE_EFFECT_RECOVERY_VERIFICATION_REQUIRED',
  )
  assert.equal(
    await request({ verificationConfirmed: false, confirmToolCallId: input.toolCallId }),
    'SIDE_EFFECT_RECOVERY_VERIFICATION_REQUIRED',
  )
  assert.equal(
    await request({ verificationConfirmed: true }),
    'SIDE_EFFECT_RECOVERY_CONFIRMATION_MISMATCH',
  )
  assert.equal(
    await request({ verificationConfirmed: true, confirmToolCallId: 'different-call' }),
    'SIDE_EFFECT_RECOVERY_CONFIRMATION_MISMATCH',
  )
  assert.equal(ledger.read(input).status, 'unknown')
})

test('recovery validation rejects unsafe transitions and invalid list limits', () => {
  const owner = issueTestSession({ email: 'side-effects-validation@example.com' })
  const { input } = createUnknown(owner.userId, 'validation')
  assert.throws(
    () => resolveUnknownSideEffect({
      userId: owner.userId,
      scopeKey: input.scope.scopeKey,
      toolCallId: input.toolCallId,
      verificationConfirmed: true,
      confirmToolCallId: input.toolCallId,
      resolution: 'retry',
    }),
    (error) => error?.code === 'SIDE_EFFECT_RECOVERY_INVALID' && error?.statusCode === 400,
  )
  assert.throws(
    () => listUnknownSideEffects({ userId: owner.userId, limit: 0 }),
    (error) => error?.code === 'SIDE_EFFECT_RECOVERY_INVALID' && error?.statusCode === 400,
  )
  assert.throws(
    () => listUnknownSideEffects({ userId: owner.userId, limit: 101 }),
    (error) => error?.code === 'SIDE_EFFECT_RECOVERY_INVALID' && error?.statusCode === 400,
  )
})

test('GC is owner-scoped and retains unknown, active, and checkpoint-backed records', () => {
  const alice = issueTestSession({ email: 'side-effects-gc-alice@example.com' })
  const bob = issueTestSession({ email: 'side-effects-gc-bob@example.com' })

  createParentJob(alice.userId, 'gc-alice-expired')
  const aliceExpired = createFinished(alice.userId, 'gc-alice-expired').input
  createParentJob(alice.userId, 'gc-alice-unknown')
  const aliceUnknown = createUnknown(alice.userId, 'gc-alice-unknown').input
  createParentJob(alice.userId, 'gc-alice-active', { status: 'queued' })
  const aliceActive = createFinished(alice.userId, 'gc-alice-active').input
  createParentJob(alice.userId, 'gc-alice-checkpoint', { checkpoint: true })
  const aliceCheckpoint = createFinished(alice.userId, 'gc-alice-checkpoint').input
  createParentJob(bob.userId, 'gc-bob-expired')
  const bobExpired = createFinished(bob.userId, 'gc-bob-expired').input

  for (const input of [aliceExpired, aliceUnknown, aliceActive, aliceCheckpoint, bobExpired]) {
    setFinishedAt(input, 100)
  }

  const aliceResult = pruneSideEffectExecutions({
    db: getDb(),
    userId: alice.userId,
    now: 10_000,
    resolvedRetentionMs: 1_000,
  })
  assert.equal(aliceResult.deleted, 1)
  assert.equal(aliceResult.unknownRetention, 'until_manual_resolution_or_user_data_clear')
  assert.equal(resolveSideEffectRetentionPolicy({}).unknownRetention, aliceResult.unknownRetention)
  assert.equal(hasExecution(aliceExpired), false)
  assert.equal(hasExecution(aliceUnknown), true)
  assert.equal(hasExecution(aliceActive), true)
  assert.equal(hasExecution(aliceCheckpoint), true)
  assert.equal(hasExecution(bobExpired), true)

  const globalResult = pruneSideEffectExecutions({
    db: getDb(),
    now: 10_000,
    resolvedRetentionMs: 1_000,
  })
  assert.equal(globalResult.deleted, 1)
  assert.equal(hasExecution(bobExpired), false)
  assert.equal(hasExecution(aliceUnknown), true)
  assert.equal(hasExecution(aliceActive), true)
  assert.equal(hasExecution(aliceCheckpoint), true)
})

test('GC retains a resolved Turn side effect while a failed Turn retry is active', () => {
  const owner = issueTestSession({ email: 'side-effects-gc-failed-retry@example.com' })
  const sessionId = 'side-effect-failed-retry-session'
  const turnId = 'side-effect-failed-retry-turn'
  upsertSession({ id: sessionId, userId: owner.userId, title: 'Failed retry retention' })
  const input = {
    scope: {
      ownerId: owner.userId,
      kind: 'turn',
      scopeKey: JSON.stringify(['turn', sessionId, turnId]),
      sessionId,
      turnId,
      jobId: null,
      stepId: null,
    },
    toolCallId: 'call-failed-retry-retention',
    idempotencyKey: 'idempotency-failed-retry-retention',
    toolName: 'write_file',
    args: { path: '/tmp/failed-retry-retention.txt', content: 'retained' },
  }
  const ledger = createSideEffectExecutionLedger({ db: getDb() })
  ledger.prepare(input)
  ledger.claimExecution(input)
  ledger.finish(input, { status: 'committed', outcome: { ok: true } })
  setFinishedAt(input, 100)

  const event = (sequence, type, payload = {}) => createTurnEvent({
    id: `${turnId}:${sequence}`,
    sessionId,
    turnId,
    sequence,
    type,
    payload,
    createdAt: sequence + 1,
  })
  appendTurnEvent({ userId: owner.userId, event: event(0, 'turn.started') })
  appendTurnEvent({
    userId: owner.userId,
    event: event(1, 'turn.failed', {
      code: 'TURN_INCOMPLETE',
      message: 'retryable failure',
      error: { code: 'TURN_INCOMPLETE', message: 'retryable failure', retryable: true },
    }),
  })
  getDb().transaction(() => appendTurnEventsInTransaction(
    [{
      userId: owner.userId,
      event: event(2, 'turn.attempt', {
        attempt: 2,
        reason: 'failed_retry',
        resetStreaming: true,
        checkpointSequence: null,
        previousStreamSequence: 1,
        assistantText: '',
        reasoningText: '',
      }),
    }],
    getDb(),
    { allowFailedRetry: true },
  ))()

  const activeResult = pruneSideEffectExecutions({
    db: getDb(),
    userId: owner.userId,
    now: 10_000,
    resolvedRetentionMs: 1_000,
  })
  assert.equal(activeResult.deleted, 0)
  assert.equal(hasExecution(input), true)

  appendTurnEvent({ userId: owner.userId, event: event(3, 'turn.completed') })
  const terminalResult = pruneSideEffectExecutions({
    db: getDb(),
    userId: owner.userId,
    now: 10_000,
    resolvedRetentionMs: 1_000,
  })
  assert.equal(terminalResult.deleted, 1)
  assert.equal(hasExecution(input), false)
})

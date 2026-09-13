import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = mkdtempSync(path.join(tmpdir(), 'gugo-turn-recovery-read-'))
const savedEnv = { APP_DATA_DIR: process.env.APP_DATA_DIR, APP_DB_PATH: process.env.APP_DB_PATH }
process.env.APP_DATA_DIR = root
process.env.APP_DB_PATH = path.join(root, 'app.db')
const { createAppServer } = await import('../server/appServer.js')
const { getDb, closeDb } = await import('../server/db.js')
const { createSideEffectExecutionLedger } = await import('../server/services/sideEffectExecutionLedger.js')
const { getUnknownSideEffectForTurn, resolveUnknownSideEffect } = await import('../server/services/sideEffectRecoveryService.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const server = createAppServer({ getEnv: () => ({ AUTH_MODE: 'local' }) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise(resolve => server.close(resolve))
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(path.basename(root).startsWith('gugo-turn-recovery-read-'), true)
  rmSync(root, { recursive: true, force: true })
})

function seed(userId, marker, { sessionId = `session-${marker}`, turnId = `turn-${marker}`, toolCallId = 'same-call', outcome = null } = {}) {
  const input = {
    scope: { ownerId: userId, kind: 'turn', scopeKey: JSON.stringify(['turn', sessionId, turnId]),
      sessionId, turnId, stepId: turnId, jobId: null },
    toolCallId, idempotencyKey: `key-${marker}`, toolName: 'write_file',
    args: { path: `workspace/${marker}.txt`, content: 'PRIVATE_INPUT_CONTENT', password: 'PRIVATE_PASSWORD' },
  }
  const ledger = createSideEffectExecutionLedger({ db: getDb() })
  ledger.prepare(input)
  ledger.claimExecution(input)
  ledger.markUnknown(input, { outcome: outcome || { stdout: 'PRIVATE_RAW_OUTPUT', path: input.args.path } })
  return { input, ledger, scope: { userId, sessionId, turnId, toolCallId } }
}

function urlFor(scope) {
  return `${origin}/api/side-effects/unknown/turn?${new URLSearchParams({
    sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: scope.toolCallId,
  })}`
}

function blockTurn(target) {
  const { userId, sessionId, turnId, toolCallId } = target.scope
  upsertSession({ id: sessionId, userId, title: 'Inline recovery fixture' })
  for (const [sequence, type, payload] of [
    [0, 'turn.started', {}],
    [1, 'turn.blocked', { code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', requiresUserVerification: true,
      recoveryKind: 'side_effect_outcome_unknown', toolCallId,
      retryable: false, manualRetryable: true, recoveryStatus: 'dead_letter', turnId,
      recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' } }],
  ]) appendTurnEvent({ userId, event: createTurnEvent({
    id: `${turnId}:${sequence}`, sessionId, turnId, sequence, type, payload, createdAt: sequence + 1,
  }) })
}

test('turn recovery reads are exact, owner-scoped, SELECT-only and expose no raw tool payload', () => {
  const owner = issueTestSession({ email: 'turn-recovery-read@example.com' })
  const other = issueTestSession({ email: 'turn-recovery-other@example.com' })
  const target = seed(owner.userId, 'target')
  seed(owner.userId, 'sibling')
  seed(other.userId, 'other-owner', target.scope)
  const readOnlyDb = { prepare(sql) {
    assert.match(sql, /^SELECT\b/u, 'fetching a recovery card must not prune or mutate records')
    return getDb().prepare(sql)
  } }
  const record = getUnknownSideEffectForTurn({ ...target.scope, db: readOnlyDb })
  assert.equal(record.scopeKey, target.input.scope.scopeKey)
  assert.equal(record.toolCallId, target.scope.toolCallId)
  assert.equal(record.status, 'unknown')
  assert.deepEqual(record.evidence.targetSummary, ['workspace/target.txt'])
  assert.match(record.argsDigest, /^[a-f0-9]{64}$/u)
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|args_json|outcome_json|idempotencyKey|ownerId/u)
  for (const patch of [
    { userId: 'missing-owner' }, { sessionId: 'session-sibling' },
    { turnId: 'turn-sibling' }, { toolCallId: 'wrong-call' },
  ]) assert.equal(getUnknownSideEffectForTurn({ ...target.scope, ...patch }), null)
  assert.equal(getUnknownSideEffectForTurn({ ...target.scope, userId: other.userId }).evidence.targetSummary[0], 'workspace/other-owner.txt')
  assert.equal(target.ledger.read(target.input).status, 'unknown')
})

test('invalid scope identifiers fail before any database operation', () => {
  const valid = { userId: 'owner', sessionId: 'session', turnId: 'turn', toolCallId: 'call' }
  const db = { prepare: () => assert.fail('invalid identity must not access storage') }
  for (const key of Object.keys(valid)) {
    for (const value of [undefined, null, '', ' padded ', 1, {}, 'x'.repeat(501)]) {
      assert.throws(() => getUnknownSideEffectForTurn({ ...valid, [key]: value, db }),
        error => error.code === 'SIDE_EFFECT_RECOVERY_INVALID' && error.statusCode === 400)
    }
  }
})

test('inline recovery exposes bounded actionable failure details without credentials or request objects', () => {
  const owner = issueTestSession({ email: 'turn-recovery-failure@example.com' })
  const secret = `sk-${'z'.repeat(28)}`
  const target = seed(owner.userId, 'failure-evidence', { outcome: {
    failure: { code: 'PPT_BUILD_FAILED', message: `slides[7].bullets is empty; api_key=${secret}`,
      stack: 'PRIVATE_STACK', request: { body: 'PRIVATE_REQUEST' },
      cause: { code: 'ENCODE_FAILED', message: 'Encoder failed', args: 'PRIVATE_ARGS' } },
  } })
  const record = getUnknownSideEffectForTurn(target.scope)
  assert.equal(record.failure.code, 'PPT_BUILD_FAILED')
  assert.match(record.failure.message, /slides\[7\]\.bullets/u)
  assert.equal(record.failure.cause.code, 'ENCODE_FAILED')
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|sk-z{28}/u)
  assert.equal(target.ledger.read(target.input).status, 'unknown')
})

test('an inline confirmation resolves only its exact record and removes it from pending lookup', () => {
  const owner = issueTestSession({ email: 'turn-recovery-confirm@example.com' })
  const target = seed(owner.userId, 'confirm-target')
  const sibling = seed(owner.userId, 'confirm-sibling')
  const record = getUnknownSideEffectForTurn(target.scope)
  resolveUnknownSideEffect({ userId: owner.userId, scopeKey: record.scopeKey,
    toolCallId: record.toolCallId, confirmToolCallId: record.toolCallId,
    verificationConfirmed: true, resolution: 'failed' })
  assert.equal(getUnknownSideEffectForTurn(target.scope), null)
  assert.equal(target.ledger.read(target.input).status, 'failed')
  assert.equal(sibling.ledger.read(sibling.input).status, 'unknown')
})

test('current-turn recovery endpoint requires authentication and never falls back to an owner-wide list', async () => {
  const owner = issueTestSession({ email: 'turn-recovery-http@example.com' })
  const other = issueTestSession({ email: 'turn-recovery-http-other@example.com' })
  const target = seed(owner.userId, 'http-target')
  blockTurn(target)
  const address = urlFor(target.scope)
  const headers = { Authorization: `Bearer ${owner.token}` }
  assert.equal((await fetch(address)).status, 401)
  const response = await fetch(address, { headers })
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.record.scopeKey, target.input.scope.scopeKey)
  assert.equal(data.boundary.sequence, 1)
  assert.equal(data.boundary.type, 'turn.blocked')
  const foreign = await fetch(address, { headers: { Authorization: `Bearer ${other.token}` } })
  assert.equal(foreign.status, 200)
  assert.deepEqual(await foreign.json(), { record: null, boundary: null })
  assert.equal((await fetch(`${origin}/api/side-effects/unknown/turn`, { headers })).status, 400)
  assert.equal((await fetch(address, { headers, method: 'POST' })).status, 405)
  assert.equal(target.ledger.read(target.input).status, 'unknown')
})

async function inlineConfirmation(owner, target) {
  const response = await fetch(urlFor(target.scope), { headers: { Authorization: `Bearer ${owner.token}` } })
  const data = await response.json()
  return { ...target.scope, boundary: data.boundary, argsDigest: data.record.argsDigest,
    verificationConfirmed: true, confirmToolCallId: data.record.toolCallId, resolution: 'failed' }
}

function postInline(owner, body) {
  return fetch(`${origin}/api/side-effects/resolve/turn`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('inline confirmation atomically checks the current boundary, digest and authenticated owner', async () => {
  const owner = issueTestSession({ email: 'turn-recovery-atomic-owner@example.com' })
  const other = issueTestSession({ email: 'turn-recovery-atomic-other@example.com' })
  const target = seed(owner.userId, 'atomic-confirm')
  blockTurn(target)
  const body = await inlineConfirmation(owner, target)
  assert.equal((await postInline(other, body)).status, 409)
  assert.equal((await postInline(owner, { ...body, argsDigest: '0'.repeat(64) })).status, 409)
  assert.equal((await postInline(owner, { ...body, verificationConfirmed: false })).status, 400)
  assert.equal((await postInline(owner, { ...body, boundary: { ...body.boundary, sequence: 0 } })).status, 409)
  assert.equal(target.ledger.read(target.input).status, 'unknown')
  const responses = await Promise.all([postInline(owner, body), postInline(owner, body)])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
  const result = await responses.find(response => response.status === 200).json()
  assert.equal(result.record.status, 'failed')
  assert.deepEqual(result.resume, { kind: 'turn', sessionId: target.scope.sessionId,
    turnId: target.scope.turnId, toolCallId: target.scope.toolCallId })
  assert.equal(target.ledger.read(target.input).status, 'failed')
  const reloaded = await fetch(urlFor(target.scope), { headers: { Authorization: `Bearer ${owner.token}` } })
  const confirmed = await reloaded.json()
  assert.equal(confirmed.record.status, 'failed')
  assert.equal(confirmed.confirmation.resolution, 'failed')
  assert.ok(Number.isSafeInteger(confirmed.confirmation.confirmedAt))
  assert.deepEqual(confirmed.resume, result.resume)
  assert.equal(confirmed.boundary.sequence, body.boundary.sequence)
  assert.equal(target.ledger.read(target.input).status, 'failed', 'reading a stored receipt must not execute or resolve again')
})

test('ordinary known outcomes and inconsistent audit records cannot masquerade as a saved human confirmation', async () => {
  const owner = issueTestSession({ email: 'turn-recovery-audit-owner@example.com' })
  const target = seed(owner.userId, 'invalid-audit')
  blockTurn(target)
  getDb().prepare(`UPDATE side_effect_executions SET status = 'failed', outcome_json = ?, audit_json = ?
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?`).run(
    JSON.stringify({ ok: false, code: 'SIDE_EFFECT_USER_CONFIRMED_FAILED', userConfirmed: true }),
    JSON.stringify({ action: 'resolve_unknown_side_effect', resolution: 'failed', confirmedAt: 1000, confirmedBy: 'other-owner' }),
    owner.userId, target.input.scope.scopeKey, target.scope.toolCallId,
  )
  const response = await fetch(urlFor(target.scope), { headers: { Authorization: `Bearer ${owner.token}` } })
  assert.deepEqual(await response.json(), { record: null, boundary: null })
  getDb().prepare(`UPDATE side_effect_executions SET audit_json = NULL
    WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?`)
    .run(owner.userId, target.input.scope.scopeKey, target.scope.toolCallId)
  const plain = await fetch(urlFor(target.scope), { headers: { Authorization: `Bearer ${owner.token}` } })
  assert.deepEqual(await plain.json(), { record: null, boundary: null })
})

test('a late inline confirmation after cancellation cannot change the recovery ledger', async () => {
  const owner = issueTestSession({ email: 'turn-recovery-late-owner@example.com' })
  const target = seed(owner.userId, 'late-confirm')
  blockTurn(target)
  const body = await inlineConfirmation(owner, target)
  appendTurnEvent({ userId: owner.userId, event: createTurnEvent({
    id: `${target.scope.turnId}:2`, sessionId: target.scope.sessionId, turnId: target.scope.turnId,
    sequence: 2, type: 'turn.cancelled', payload: { code: 'TURN_CANCELLED' }, createdAt: 3,
  }) })
  const response = await postInline(owner, body)
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'TURN_INTERACTION_STALE')
  assert.equal(target.ledger.read(target.input).status, 'unknown')
  const current = await fetch(urlFor(target.scope), { headers: { Authorization: `Bearer ${owner.token}` } })
  assert.deepEqual(await current.json(), { record: null, boundary: null })
})

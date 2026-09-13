import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

process.env.GUGO_LOAD_DOTENV = '0'
process.env.APP_CONFIG_PATH = path.join(process.env.APP_DATA_DIR, 'config.json')
const initialCwd = process.cwd()
process.chdir(process.env.APP_DATA_DIR)
const { getDb, closeDb, createUser } = await import('../server/db.js')
const { HEADLESS_TURN_RECOVERY_PORTS: ports } = await import('../server/adapters/headlessTurnRecoveryPorts.js')
const { grantLocalPath, getPersistentGrantRows, getSessionGrantRows, clearSessionLocalFileGrants } = await import('../server/services/localFileAccessGrantStore.js')
const { createSideEffectExecutionLedger } = await import('../server/services/sideEffectExecutionLedger.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')

test.after(() => { clearSessionLocalFileGrants(); closeDb(); process.chdir(initialCwd) })
let fixtureId = 0
function fixture(kind = 'directory', accessMode = 'read_only') {
  const id = `recovery-ports-${++fixtureId}`
  const scope = { userId: `${id}-user`, sessionId: `${id}-session`, turnId: `${id}-turn` }
  createUser({ id: scope.userId, email: `${id}@example.com` })
  upsertSession({ id: scope.sessionId, userId: scope.userId, title: id })
  const directory = path.join(process.env.APP_DATA_DIR, id)
  mkdirSync(directory)
  const canonical = realpathSync(directory)
  let sequence = 0
  const emit = (type, payload = {}) => {
    const event = createTurnEvent({ id: `${id}:${sequence}`, sessionId: scope.sessionId,
      turnId: scope.turnId, sequence: sequence++, type, payload })
    appendTurnEvent({ userId: scope.userId, event })
    return event
  }
  emit('turn.started', {})
  const toolCallId = `${id}-write`
  const event = kind === 'directory'
    ? emit('turn.paused', { text: 'Select the fixture directory.', clarification: {
      request_type: 'directory', access_mode: accessMode, suggested_path: canonical,
    } })
    : emit('turn.blocked', { code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', requiresUserVerification: true,
      recoveryKind: 'side_effect_outcome_unknown', toolCallId, retryable: false,
      manualRetryable: true, recoveryStatus: 'dead_letter', turnId: scope.turnId,
      recoveryAction: { kind: 'confirm_side_effect' },
    })
  const boundary = { id: event.id, sequence: event.sequence, type: event.type }
  const input = { ...scope, boundary, path: canonical, accessMode, scope: 'session' }
  const settings = () => ['local_file_access_settings', 'user_approval_settings']
    .map(table => getDb().prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(scope.userId))
  return { scope, input, emit, directory: canonical, settings, toolCallId }
}

test('builtin directory port grants only the confirmed canonical read-only path for this process', () => {
  const f = fixture()
  const before = f.settings()
  assert.equal(ports.canonicalizeDirectory({ ...f.scope, path: f.directory }), f.directory)
  const grant = ports.grantDirectory(f.input)
  assert.equal(grant.path, f.directory)
  assert.equal(grant.resourceType, 'directory')
  assert.equal(grant.scope, 'session')
  assert.equal(grant.accessMode, 'read_only')
  assert.equal(getSessionGrantRows(f.scope.userId).length, 1)
  assert.deepEqual(getPersistentGrantRows(f.scope.userId), [])
  assert.deepEqual(f.settings(), before)
})

test('an existing persistent grant is reused without changing settings or widening its persisted row', () => {
  const f = fixture()
  const prior = grantLocalPath({ userId: f.scope.userId, rootPath: f.directory,
    accessMode: 'read_write', scope: 'persistent' })
  const persistedBefore = getPersistentGrantRows(f.scope.userId)
  const settingsBefore = f.settings()
  const grant = ports.grantDirectory(f.input)
  assert.equal(grant.id, prior.id)
  assert.deepEqual(grant.preexistingPermission, {
    id: prior.id, path: prior.path, scope: 'persistent', accessMode: 'read_write',
  })
  assert.deepEqual(getPersistentGrantRows(f.scope.userId), persistedBefore)
  assert.deepEqual(getSessionGrantRows(f.scope.userId), [])
  assert.deepEqual(f.settings(), settingsBefore)
})

test('readonly persistent permission is not upgraded when this CLI requests read-write access', () => {
  const f = fixture('directory', 'read_write')
  grantLocalPath({ userId: f.scope.userId, rootPath: f.directory, accessMode: 'read_only', scope: 'persistent' })
  const prior = getPersistentGrantRows(f.scope.userId)
  const grant = ports.grantDirectory(f.input)
  assert.equal(grant.scope, 'session')
  assert.equal(grant.accessMode, 'read_write')
  assert.deepEqual(getPersistentGrantRows(f.scope.userId), prior)
})

test('a cancelled boundary, wrong user or mismatched access mode cannot create any directory grant', () => {
  const f = fixture()
  assert.throws(() => ports.grantDirectory({ ...f.input, accessMode: 'read_write' }),
    error => error.code === 'CLI_DIRECTORY_CONFIRMATION_MISMATCH')
  assert.throws(() => ports.grantDirectory({ ...f.input, userId: 'foreign-user' }),
    error => error.code === 'TURN_INTERACTION_STALE')
  f.emit('turn.cancelled', { code: 'TURN_CANCELLED' })
  assert.throws(() => ports.grantDirectory(f.input), error => error.code === 'TURN_INTERACTION_STALE' && error.statusCode === 409)
  assert.deepEqual(getSessionGrantRows(f.scope.userId), [])
  assert.deepEqual(getPersistentGrantRows(f.scope.userId), [])
})

function unknownFixture() {
  const f = fixture('unknown')
  const ledgerInput = { scope: { ownerId: f.scope.userId, kind: 'turn',
    scopeKey: JSON.stringify(['turn', f.scope.sessionId, f.scope.turnId]),
    sessionId: f.scope.sessionId, turnId: f.scope.turnId, stepId: f.scope.turnId },
  toolCallId: f.toolCallId, toolName: 'write_file', idempotencyKey: `key-${f.toolCallId}`,
  args: { path: path.join(f.directory, 'target.txt'), content: 'fixture' } }
  const ledger = createSideEffectExecutionLedger({ db: getDb() })
  ledger.prepare(ledgerInput)
  ledger.claimExecution(ledgerInput)
  ledger.markUnknown(ledgerInput)
  const record = ports.readUnknownSideEffect({ ...f.scope, toolCallId: f.toolCallId })
  const confirmation = { ...f.scope, toolCallId: f.toolCallId, boundary: f.input.boundary,
    argsDigest: record.argsDigest, verificationConfirmed: true, confirmToolCallId: f.toolCallId }
  return { ...f, ledger, ledgerInput, record, confirmation }
}

test('builtin unknown resolution atomically binds actual SQLite record, digest, owner and current boundary', () => {
  for (const resolution of ['committed', 'failed']) {
    const f = unknownFixture()
    const before = f.settings()
    assert.throws(() => ports.resolveUnknownSideEffect({ ...f.confirmation, resolution, argsDigest: '0'.repeat(64) }),
      error => error.code === 'SIDE_EFFECT_RECOVERY_CONFLICT')
    assert.equal(f.ledger.read(f.ledgerInput).status, 'unknown')
    const resolved = ports.resolveUnknownSideEffect({ ...f.confirmation, resolution })
    assert.equal(resolved.record.status, resolution)
    assert.equal(resolved.resume.turnId, f.scope.turnId)
    assert.equal(f.ledger.read(f.ledgerInput).status, resolution)
    assert.equal(ports.readUnknownSideEffect({ ...f.scope, toolCallId: f.toolCallId }), null)
    assert.throws(() => ports.resolveUnknownSideEffect({ ...f.confirmation, resolution }),
      error => error.code === 'SIDE_EFFECT_RECOVERY_CONFLICT')
    assert.deepEqual(f.settings(), before)
  }
})

test('late or ordinary approval leaves the actual unknown ledger untouched', () => {
  const f = unknownFixture()
  assert.throws(() => ports.resolveUnknownSideEffect({ ...f.confirmation, resolution: 'committed', verificationConfirmed: false }),
    error => error.code === 'SIDE_EFFECT_RECOVERY_VERIFICATION_REQUIRED')
  f.emit('turn.cancelled', { code: 'TURN_CANCELLED' })
  assert.throws(() => ports.resolveUnknownSideEffect({ ...f.confirmation, resolution: 'failed' }),
    error => error.code === 'TURN_INTERACTION_STALE')
  assert.equal(f.ledger.read(f.ledgerInput).status, 'unknown')
})

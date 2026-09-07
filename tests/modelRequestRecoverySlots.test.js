import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateToV38 } from '../server/migrations/v38JobExecutionLeases.js'
import { migrateToV85 } from '../server/migrations/v85ModelRequestRecovery.js'
import { migrateToV86 } from '../server/migrations/v86JobModelRequestRecovery.js'
import { createModelInvocation, fingerprintModelRequest, reconcileRecoveredModelInvocation } from '../server/services/loop/modelInvocationCheckpoint.js'
import { commitSqliteModelRequestRecoveryResolution, getPendingModelRequestRecovery, readModelRequestRecoveryResolution } from '../server/services/modelRequestRecoveryService.js'
import { getPendingJobModelRequestRecovery, readJobModelRequestRecoveryResolution, resolvePendingJobModelRequest } from '../server/services/jobModelRequestRecoveryService.js'
import { loadRetryCheckpoint, makeRetryCheckpointResumable } from '../server/services/jobRetryRuntime.js'
import { selectModelRequestRecoverySlot, withModelInvocationAtSlot } from '../server/services/modelRequestInvocationSlots.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { createCompactionArchivePort } from '../server/core/compactionArchivePort.js'
import { getModelRequestRecoveryApi, resolveModelRequestRecoveryApi } from '../src/lib/modelRequestRecoveryClient.js'

const binding = { modelName: 'model-a', modelProviderId: 'provider-a', modelConfigRevision: 7 }
const turnScope = { userId: 'owner-a', sessionId: 'session-a', turnId: 'turn-a' }
const jobScope = { userId: 'owner-a', jobId: 'job-a', stepId: 'step-a' }

function invocation(fingerprint) {
  return createModelInvocation({ ...binding, fingerprint: fingerprint.repeat(64), jobId: 'job-a', stepId: 'step-a', iteration: 2, attempt: 1 })
}

function checkpointState({ bothPending = false } = {}) {
  const main = invocation('a')
  return {
    version: 1, iterations: 2, messages: [{ role: 'user', content: 'Do the task' }],
    budget: { used: 3, modelCalls: 2, modelTokens: 80 },
    modelInvocation: bothPending ? main : { ...main, status: 'completed', usageApplied: true, response: { content: 'Previous answer', toolCalls: [] } },
    compactionCheckpoint: {
      version: 1, fingerprint: 'b'.repeat(64), attempt: 0,
      recipes: [{ meta: { compacted: false } }],
      responses: [{ fingerprint: 'c'.repeat(64), response: { content: 'Cached map summary', toolCalls: [] } }],
      modelInvocation: invocation('d'),
    },
  }
}

function fixture(context, state = checkpointState()) {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
    CREATE TABLE jobs (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
    CREATE TABLE job_steps (id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id));
    CREATE TABLE turn_checkpoints (user_id TEXT, session_id TEXT, turn_id TEXT, event_sequence INTEGER, state_json TEXT);
    CREATE TABLE turn_execution_leases (user_id TEXT, session_id TEXT, turn_id TEXT, owner_id TEXT, expires_at INTEGER);
    INSERT INTO users VALUES ('owner-a'), ('owner-b');
    INSERT INTO sessions VALUES ('session-a', 'owner-a');
    INSERT INTO jobs VALUES ('job-a', 'owner-a');
    INSERT INTO job_steps VALUES ('step-a', 'job-a');
  `)
  migrateToV38(db)
  migrateToV85(db)
  migrateToV86(db)
  const stateJson = JSON.stringify(state)
  db.prepare('INSERT INTO turn_checkpoints VALUES (?, ?, ?, ?, ?)').run('owner-a', 'session-a', 'turn-a', 12, stateJson)
  db.prepare('INSERT INTO job_turn_checkpoints (step_id,job_id,user_id,state_json,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?)')
    .run('step-a', 'job-a', 'owner-a', stateJson, 1000, 1000, 1)
  context.after(() => db.close())
  const readTurnCheckpoint = ({ userId, sessionId, turnId }) => {
    const row = db.prepare('SELECT * FROM turn_checkpoints WHERE user_id=? AND session_id=? AND turn_id=?').get(userId, sessionId, turnId)
    return row ? { eventSequence: row.event_sequence, state: JSON.parse(row.state_json) } : null
  }
  return {
    db, state, readTurnCheckpoint,
    readJobCheckpoint: () => {
      const row = db.prepare('SELECT * FROM job_turn_checkpoints WHERE job_id=? AND step_id=?').get('job-a', 'step-a')
      return { state: JSON.parse(row.state_json), revision: row.revision, updatedAt: row.updated_at }
    },
    readTurnPending: (scope = turnScope) => getPendingModelRequestRecovery({
      ...scope, readCheckpoint: readTurnCheckpoint,
      readResolution: (input) => readModelRequestRecoveryResolution({ ...input, db }),
    }),
    readJobPending: () => getPendingJobModelRequestRecovery({ ...jobScope, db }),
  }
}

test('turn recovery exposes the pending summary even when the main slot contains an old completed answer', async (context) => {
  const f = fixture(context)
  const pending = await f.readTurnPending()
  assert.ok(pending)
  assert.equal(pending.modelRequestId, f.state.compactionCheckpoint.modelInvocation.id)
  assert.equal(pending.modelRequestSlot, 'compaction')
})

test('job recovery exposes the pending summary instead of an old completed main slot', (context) => {
  const f = fixture(context)
  const pending = f.readJobPending()
  assert.ok(pending)
  assert.equal(pending.modelRequestId, f.state.compactionCheckpoint.modelInvocation.id)
  assert.equal(pending.modelRequestSlot, 'compaction')
})

test('two unknown model slots fail closed instead of choosing one for manual recovery', async (context) => {
  const f = fixture(context, checkpointState({ bothPending: true }))
  const ambiguous = (error) => error?.code === 'MODEL_REQUEST_RECOVERY_AMBIGUOUS'
    && error.retryable === false && error.unsafeToReplay === true
  await assert.rejects(f.readTurnPending(), ambiguous)
  assert.throws(f.readJobPending, ambiguous)
})

function resolutionInput(pending, scope, db, resolution = 'completed') {
  return {
    ...scope,
    modelRequestId: pending.modelRequestId,
    requestFingerprint: pending.requestFingerprint,
    providerId: pending.providerId,
    modelName: pending.modelName,
    configRevision: pending.configRevision,
    idempotencyKey: pending.idempotencyKey,
    expectedCheckpointSequence: pending.checkpointSequence,
    expectedCheckpointRevision: pending.checkpointRevision,
    verificationConfirmed: true,
    confirmModelRequestId: pending.modelRequestId,
    resolution,
    response: { content: 'Recovered context summary', toolCalls: [], usage: { promptTokens: 30, completionTokens: 5 } },
    receipt: { providerRecord: 'verified-summary-request' },
    now: () => 2_000,
    db,
  }
}

test('turn manual resolution is consumed for the summary request without replacing the main answer', async (context) => {
  const f = fixture(context)
  const pending = await f.readTurnPending()
  const summary = f.state.compactionCheckpoint.modelInvocation
  const record = commitSqliteModelRequestRecoveryResolution(resolutionInput(pending, turnScope, f.db))
  assert.equal(record.modelRequestSlot, 'compaction')
  assert.equal(record.status, 'resolved_pending_resume')
  assert.deepEqual(f.readTurnCheckpoint(turnScope).state, f.state, 'Turn resolution consumption remains owned by the resumed loop')
  let reconcilerCalls = 0
  const replay = await reconcileRecoveredModelInvocation(summary, {
    ...binding, fingerprint: summary.fingerprint, iteration: summary.iteration,
    reconcileRequest: (restored) => {
      reconcilerCalls += 1
      return readModelRequestRecoveryResolution({ ...turnScope, invocation: restored, db: f.db })
    },
  })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.response.content, 'Recovered context summary')
  assert.equal(reconcilerCalls, 1)
  const resumed = withModelInvocationAtSlot(f.state, 'compaction', replay.invocation)
  assert.deepEqual(resumed.modelInvocation, f.state.modelInvocation)
  assert.deepEqual(resumed.compactionCheckpoint.responses, f.state.compactionCheckpoint.responses)
  assert.equal(resumed.compactionCheckpoint.modelInvocation.response.content, 'Recovered context summary')
  assert.equal(resumed.compactionCheckpoint.modelInvocation.usageApplied, false)
})

for (const resolution of ['completed', 'not_sent']) {
  test(`job ${resolution} summary resolution stays in the original slot and preserves the retry budget`, (context) => {
    const f = fixture(context)
    const pending = f.readJobPending()
    const record = resolvePendingJobModelRequest(resolutionInput(pending, jobScope, f.db, resolution))
    const checkpoint = f.readJobCheckpoint()
    assert.equal(record.modelRequestSlot, 'compaction')
    assert.equal(record.checkpointRevision, 2)
    assert.equal(f.readJobPending().modelRequestId, pending.modelRequestId)
    assert.deepEqual(checkpoint.state.modelInvocation, f.state.modelInvocation)
    assert.deepEqual(checkpoint.state.budget, f.state.budget)
    assert.deepEqual(checkpoint.state.compactionCheckpoint.recipes, f.state.compactionCheckpoint.recipes)
    assert.deepEqual(checkpoint.state.compactionCheckpoint.responses, f.state.compactionCheckpoint.responses)
    const materialized = checkpoint.state.compactionCheckpoint.modelInvocation
    assert.equal(materialized.status, resolution)
    if (resolution === 'completed') assert.equal(materialized.usageApplied, false)
    let resetBudget = null
    const runtimeCore = { checkpoint: {
      load: () => checkpoint,
      makeResumable: (_scope, options) => { resetBudget = options.resetBudget; return checkpoint },
    } }
    assert.equal(loadRetryCheckpoint({ runtimeCore, ...jobScope, modelSnapshot: binding }), checkpoint)
    assert.equal(makeRetryCheckpointResumable({ runtimeCore, checkpoint, ...jobScope, resetBudget: true }), checkpoint)
    assert.equal(resetBudget, false)
    assert.throws(() => resolvePendingJobModelRequest(resolutionInput(pending, jobScope, f.db, resolution)),
      (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_CONFLICT')
  })
}

test('a prior manually completed main request cannot hide a materialized summary awaiting consumption', (context) => {
  const state = checkpointState()
  state.modelInvocation.reconciliation = { source: 'manual', outcome: 'completed', contractVersion: 1, reconciledAt: 10 }
  const f = fixture(context, state)
  const pending = f.readJobPending()
  const resolved = resolvePendingJobModelRequest(resolutionInput(pending, jobScope, f.db))
  assert.equal(resolved.modelRequestId, state.compactionCheckpoint.modelInvocation.id)
  assert.equal(f.readJobPending().modelRequestId, resolved.modelRequestId)
  assert.equal(selectModelRequestRecoverySlot(f.readJobCheckpoint().state, { includeMaterialized: true }).slot, 'compaction')
})

test('unknown summary resolution never becomes a fresh request and a stale resolution cannot be consumed', async (context) => {
  const f = fixture(context)
  const pending = f.readJobPending()
  const summary = f.state.compactionCheckpoint.modelInvocation
  resolvePendingJobModelRequest(resolutionInput(pending, jobScope, f.db, 'unknown'))
  assert.equal(f.readJobCheckpoint().state.compactionCheckpoint.modelInvocation.status, 'in_flight')
  await assert.rejects(reconcileRecoveredModelInvocation(summary, {
    ...binding, fingerprint: summary.fingerprint, iteration: summary.iteration,
    reconcileRequest: (restored) => readJobModelRequestRecoveryResolution({ ...jobScope, invocation: restored, db: f.db }),
  }), (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  f.db.prepare('UPDATE job_turn_checkpoints SET revision=revision+1').run()
  assert.throws(() => readJobModelRequestRecoveryResolution({ ...jobScope, invocation: summary, db: f.db }),
    (error) => error?.code === 'JOB_MODEL_REQUEST_RECOVERY_CONFLICT')
})

test('summary recovery retains owner, identity, checkpoint and active-lease fences', async (context) => {
  const f = fixture(context)
  const pending = await f.readTurnPending()
  const args = resolutionInput(pending, turnScope, f.db)
  assert.equal(await f.readTurnPending({ ...turnScope, userId: 'owner-b' }), null)
  for (const patch of [
    { userId: 'owner-b' }, { expectedCheckpointSequence: 13 }, { providerId: 'other-provider' },
    { configRevision: 8 }, { requestFingerprint: 'f'.repeat(64) }, { modelRequestId: f.state.modelInvocation.id, confirmModelRequestId: f.state.modelInvocation.id },
  ]) {
    assert.throws(() => commitSqliteModelRequestRecoveryResolution({ ...args, ...patch }),
      (error) => ['MODEL_REQUEST_RECOVERY_CONFLICT', 'MODEL_REQUEST_RECOVERY_NOT_FOUND'].includes(error?.code))
  }
  f.db.prepare('INSERT INTO turn_execution_leases VALUES (?,?,?,?,?)').run('owner-a', 'session-a', 'turn-a', 'live-worker', 3000)
  assert.throws(() => commitSqliteModelRequestRecoveryResolution(args), (error) => error?.code === 'MODEL_REQUEST_RECOVERY_EXECUTION_ACTIVE')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM model_request_recovery_resolutions').get().count, 0)
  assert.deepEqual(f.readTurnCheckpoint(turnScope).state, f.state)
})

test('summary checkpoint materialization failure rolls back its resolution and every slot', (context) => {
  const f = fixture(context)
  const pending = f.readJobPending()
  f.db.exec("CREATE TRIGGER reject_summary_materialization BEFORE UPDATE ON job_turn_checkpoints BEGIN SELECT RAISE(ABORT, 'injected CAS failure'); END")
  assert.throws(() => resolvePendingJobModelRequest(resolutionInput(pending, jobScope, f.db)), /injected CAS failure/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM job_model_request_recovery_resolutions').get().count, 0)
  assert.deepEqual(f.readJobCheckpoint().state, f.state)
})

test('retry validates the summary binding and rejects unresolved or corrupted secondary slots', () => {
  for (const mutation of [
    (state) => { state.compactionCheckpoint.modelInvocation.configRevision = 8 },
    (state) => { state.compactionCheckpoint.modelInvocation.reconciliation = { source: 'manual', outcome: 'unknown' } },
    (state) => { state.compactionCheckpoint.modelInvocation = { status: 'in_flight' } },
  ]) {
    const state = checkpointState()
    mutation(state)
    const runtimeCore = { checkpoint: { load: () => ({ state }) } }
    assert.throws(() => loadRetryCheckpoint({ runtimeCore, ...jobScope, modelSnapshot: binding }),
      (error) => ['MODEL_REQUEST_OUTCOME_UNKNOWN', 'MODEL_REQUEST_CONTEXT_DRIFT'].includes(error?.code)
        && error.retryable === false)
  }
  const both = checkpointState({ bothPending: true })
  const runtimeCore = { checkpoint: {
    load: () => ({ state: both }),
    makeResumable: () => assert.fail('ambiguous requests cannot mutate the retry checkpoint'),
  } }
  assert.throws(() => loadRetryCheckpoint({ runtimeCore, ...jobScope, modelSnapshot: binding }),
    (error) => error?.code === 'MODEL_REQUEST_RECOVERY_AMBIGUOUS')
  assert.throws(() => makeRetryCheckpointResumable({ runtimeCore, checkpoint: { state: both }, ...jobScope }),
    (error) => error?.code === 'MODEL_REQUEST_RECOVERY_AMBIGUOUS')
})

test('the existing recovery UI client round-trips the selected summary identity rather than the old answer', async (context) => {
  const f = fixture(context)
  const pending = f.readJobPending()
  let submitted
  context.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    if (options.method === 'POST') {
      submitted = JSON.parse(options.body)
      return new Response(JSON.stringify({ recovery: { ...pending, resolution: 'completed' } }))
    }
    return new Response(JSON.stringify({ recovery: pending }))
  })
  const target = { scopeKind: 'job', jobId: 'job-a', stepId: 'step-a' }
  const recovery = await getModelRequestRecoveryApi(target)
  assert.equal(recovery.modelRequestSlot, 'compaction')
  await resolveModelRequestRecoveryApi({
    ...target, recovery, resolution: 'completed', verificationConfirmed: true,
    confirmModelRequestId: recovery.modelRequestId,
    response: { content: 'Recovered context summary', toolCalls: [] }, receipt: { checked: true },
  })
  assert.equal(submitted.modelRequestId, f.state.compactionCheckpoint.modelInvocation.id)
  assert.equal(submitted.requestFingerprint, f.state.compactionCheckpoint.modelInvocation.fingerprint)
  assert.equal(submitted.checkpointRevision, pending.checkpointRevision)
  assert.notEqual(submitted.modelRequestId, f.state.modelInvocation.id)
})

test('the real loop consumes a manually recovered summary in place, resumes remaining compaction, and answers only once', async (context) => {
  const f = fixture(context)
  const key = 'SUMMARY_MUST_NOT_BECOME_THE_ANSWER'
  const messages = [
    { role: 'user', content: 'Read this complete source.\n' + 'Background evidence\n'.repeat(3600) + `\nRequired result: ${key}` },
    { role: 'assistant', content: 'The task is not finished.' },
    { role: 'user', content: `Continue and return ${key}.` },
  ]
  const requests = []
  const archives = []
  const summary = ['Objective and success criteria', 'Decisions and constraints', 'Completed work', 'Current working state', 'Files read or changed', 'Commands and tool outcomes', 'Open work, risks, and next actions']
    .map((title, index) => `## ${index + 2}. ${title}\n- ${key}`).join('\n\n')
  const compactionArchivePort = createCompactionArchivePort({
    id: 'manual-summary-slot-fixture', apiVersion: 1,
    create(input) {
      const archive = { ...input, id: `summary-archive-${archives.length}`, replacedMessageCount: input.archivedMessages.length, createdAt: 1 }
      archives.push(archive)
      return archive
    },
    get: ({ id, userId }) => archives.find((archive) => archive.id === id && archive.userId === userId) || null,
    cleanup: () => ({ deletedCount: 0 }),
  })
  const options = {
    job: { id: 'job-a', userId: 'owner-a', sessionId: 'session-a', origin: 'chat', prompt: messages.at(-1).content, userPrompt: messages.at(-1).content, ...binding },
    step: { id: 'step-a', kind: 'chat' }, messages, toolSpecs: [], fallbackToolSpecs: [], contextWindow: 8192,
    compactionArchivePort, maxIters: 3, enableToolHooks: false, semanticSummary: { mode: 'auto', timeoutMs: 500 },
    saveCheckpoint(state) {
      f.db.prepare('UPDATE job_turn_checkpoints SET state_json=?, revision=revision+1').run(JSON.stringify(state))
      return true
    },
  }
  await assert.rejects(runToolLoop({
    ...options,
    runModel: async (request) => { requests.push(request); return new Promise(() => {}) },
  }), (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  assert.equal(requests.length, 1)
  const pending = f.readJobPending()
  assert.equal(pending.modelRequestSlot, 'compaction')
  const checkedResponse = {
    content: String(requests[0].messages[0]?.content).includes('exactly seven numbered Markdown sections') ? summary : `Evidence digest: ${key}`,
    toolCalls: [], usage: { promptTokens: 30, completionTokens: 5 },
  }
  resolvePendingJobModelRequest({ ...resolutionInput(pending, jobScope, f.db), response: checkedResponse })
  const resumed = f.readJobCheckpoint()
  assert.equal(resumed.state.modelInvocation ?? null, null)
  assert.equal(resumed.state.compactionCheckpoint.modelInvocation.status, 'completed')
  assert.equal(resumed.state.compactionCheckpoint.modelInvocation.usageApplied, false)
  let answerCalls = 0
  const result = await runToolLoop({
    ...options,
    loadCheckpoint: () => structuredClone(resumed.state),
    runModel: async (request) => {
      requests.push(request)
      const system = String(request.messages[0]?.content || '')
      const usage = { promptTokens: 3, completionTokens: 1 }
      if (system.includes('exactly seven numbered Markdown sections')) return { content: summary, usage }
      if (system.includes('evidence digest') || system.includes('untrusted evidence digests')) return { content: `Evidence digest: ${key}`, usage }
      answerCalls += 1
      return { content: `Final answer: ${key}`, usage }
    },
  })
  assert.equal(result.text, `Final answer: ${key}`)
  assert.equal(answerCalls, 1)
  assert.equal(new Set(requests.map((request) => fingerprintModelRequest(request))).size, requests.length)
  assert.equal(archives.length, 1)
  const finished = f.readJobCheckpoint().state
  assert.equal(finished.budget.modelCalls, requests.length)
  assert.equal(finished.budget.modelTokens, 35 + (requests.length - 1) * 4, JSON.stringify({
    beforeBudget: resumed.state.budget,
    beforeSummary: resumed.state.compactionCheckpoint.modelInvocation,
    recipeMeta: resumed.state.compactionCheckpoint.recipes.map((entry) => entry?.meta),
    afterBudget: finished.budget,
    afterSummary: finished.compactionCheckpoint?.modelInvocation || null,
  }))
  assert.equal(finished.compactionCheckpoint?.modelInvocation ?? null, null)
})

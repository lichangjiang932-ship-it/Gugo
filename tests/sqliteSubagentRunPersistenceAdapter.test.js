import assert from 'node:assert/strict'
import test from 'node:test'

import Database from 'better-sqlite3'

import { createSqliteSubagentRunPersistenceAdapter } from '../server/adapters/sqliteSubagentRunPersistenceAdapter.js'
import { prepareSubagentRunPersistencePort } from '../server/core/subagentRunPersistencePort.js'

function createFixture() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      parent_session_id TEXT,
      parent_message_id TEXT,
      agent_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      result_text TEXT,
      trace_json TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      model_name TEXT,
      model_provider_id TEXT,
      model_config_revision INTEGER
    );
    CREATE INDEX idx_subagent_runs_status ON subagent_runs(status);
  `)
  return {
    db,
    adapter: createSqliteSubagentRunPersistenceAdapter({ getDb: () => db }),
  }
}

function createRun(adapter, overrides = {}) {
  return adapter.createRun({
    id: 'run-1',
    userId: 'user-a',
    parentSessionId: 'session-1',
    parentMessageId: 'message-1',
    agentType: 'explore',
    prompt: 'inspect the storage boundary',
    modelName: 'local-model',
    modelProviderId: 'local-provider',
    modelConfigRevision: 7,
    trace: [{ type: 'start', at: 100 }],
    createdAt: 100,
    ...overrides,
  })
}

test('sqlite subagent adapter creates and reads a plain owner-scoped DTO', (t) => {
  const { db, adapter } = createFixture()
  t.after(() => db.close())

  const created = createRun(adapter)

  assert.equal(adapter.apiVersion, 1)
  assert.equal(adapter.id, 'builtin.sqlite')
  assert.equal(Object.isFrozen(created), false)
  assert.deepEqual(created, {
    id: 'run-1',
    userId: 'user-a',
    parentSessionId: 'session-1',
    parentMessageId: 'message-1',
    agentType: 'explore',
    prompt: 'inspect the storage boundary',
    modelName: 'local-model',
    modelProviderId: 'local-provider',
    modelConfigRevision: 7,
    status: 'running',
    resultText: '',
    trace: [{ type: 'start', at: 100 }],
    tokensIn: null,
    tokensOut: null,
    createdAt: 100,
    finishedAt: null,
  })
  assert.deepEqual(adapter.getRun({ userId: 'user-a', id: 'run-1' }), created)
  assert.equal(adapter.getRun({ userId: 'user-b', id: 'run-1' }), null)
})

test('sqlite subagent adapter preserves resume and running-trace state transitions', (t) => {
  const { db, adapter } = createFixture()
  t.after(() => db.close())
  createRun(adapter)

  const interrupted = adapter.finishRun({
    userId: 'user-a',
    id: 'run-1',
    status: 'interrupted',
    resultText: 'service restarted',
    trace: [{ type: 'interrupted', at: 200 }],
    finishedAt: 200,
  })
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.finishedAt, 200)

  const resumed = adapter.markRunning({
    userId: 'user-a',
    id: 'run-1',
    trace: [{ type: 'resume', at: 300 }],
    startedAt: 300,
  })
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.createdAt, 100, 'resume must preserve the original run creation time')
  assert.equal(resumed.finishedAt, null)
  assert.deepEqual(resumed.trace, [{ type: 'resume', at: 300 }])

  const traced = adapter.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: [{ type: 'runtime_checkpoint', state: { iterations: 3 } }],
  })
  assert.deepEqual(traced.trace, [{ type: 'runtime_checkpoint', state: { iterations: 3 } }])

  adapter.finishRun({
    userId: 'user-a',
    id: 'run-1',
    status: 'completed',
    resultText: 'done',
    trace: [{ type: 'done', at: 400 }],
    finishedAt: 400,
  })
  assert.throws(
    () => adapter.saveRunningTrace({ userId: 'user-a', id: 'run-1', trace: [] }),
    /subagent run is not running/,
  )
})

test('sqlite subagent adapter rejects a stale checkpoint trace and preserves newer recovery state', (t) => {
  const { db, adapter } = createFixture()
  const port = prepareSubagentRunPersistencePort(adapter)
  t.after(() => db.close())
  createRun(port)

  const newerTrace = [
    {
      type: 'runtime_checkpoint',
      state: {
        marker: 'newer',
        checkpointWriteSequence: 2,
      },
    },
    // Resume/provider/transcript events are appended after the recovery
    // checkpoint. CAS must locate the latest checkpoint, not assume it is the
    // final trace entry.
    { type: 'resume', fromStatus: 'interrupted', at: 200 },
  ]
  const staleTrace = [{
    type: 'runtime_checkpoint',
    state: {
      marker: 'stale',
      checkpointWriteSequence: 1,
    },
  }]

  const newer = port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: newerTrace,
    checkpointWriteSequence: 2,
  })
  assert.deepEqual(newer.trace, newerTrace)

  const staleAttempt = port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: staleTrace,
    checkpointWriteSequence: 1,
  })
  assert.deepEqual(staleAttempt.trace, newerTrace)

  const restored = port.getRun({ userId: 'user-a', id: 'run-1' })
  assert.deepEqual(restored.trace, newerTrace)
  const restoredCheckpoint = restored.trace.findLast((event) => event.type === 'runtime_checkpoint')
  assert.equal(restoredCheckpoint.state.marker, 'newer')
  assert.equal(restoredCheckpoint.state.checkpointWriteSequence, 2)
})

test('sqlite subagent adapter rejects a stale terminal trace without overwriting a newer running checkpoint', (t) => {
  const { db, adapter } = createFixture()
  const port = prepareSubagentRunPersistencePort(adapter)
  t.after(() => db.close())
  createRun(port)

  const capturedTrace = [
    { type: 'start', at: 100 },
    {
      type: 'runtime_checkpoint',
      state: { marker: 'captured', checkpointWriteSequence: 1 },
      at: 110,
    },
  ]
  port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: capturedTrace,
    checkpointWriteSequence: 1,
  })

  const committedTrace = [
    { type: 'start', at: 100 },
    { type: 'transcript', eventType: 'model_response', at: 120 },
    {
      type: 'runtime_checkpoint',
      state: { marker: 'committed-after-terminal-snapshot', checkpointWriteSequence: 2 },
      at: 130,
    },
  ]
  port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: committedTrace,
    checkpointWriteSequence: 2,
  })

  const staleTerminal = port.finishRun({
    userId: 'user-a',
    id: 'run-1',
    status: 'completed',
    resultText: 'stale completion',
    trace: [...capturedTrace, { type: 'done', at: 140 }],
    finishedAt: 140,
  })

  assert.equal(staleTerminal, null)
  const preserved = port.getRun({ userId: 'user-a', id: 'run-1' })
  assert.equal(preserved.status, 'running')
  assert.equal(preserved.resultText, '')
  assert.equal(preserved.finishedAt, null)
  assert.deepEqual(preserved.trace, committedTrace)

  const completed = port.finishRun({
    userId: 'user-a',
    id: 'run-1',
    status: 'completed',
    resultText: 'fresh completion',
    trace: [...committedTrace, { type: 'done', at: 150 }],
    finishedAt: 150,
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.resultText, 'fresh completion')
  assert.equal(
    completed.trace.findLast((event) => event.type === 'runtime_checkpoint')?.state?.checkpointWriteSequence,
    2,
  )
})

test('sqlite subagent adapter rejects conflicting content at the same checkpoint sequence', (t) => {
  const { db, adapter } = createFixture()
  const port = prepareSubagentRunPersistencePort(adapter)
  t.after(() => db.close())
  createRun(port)

  const committedTrace = [{
    type: 'runtime_checkpoint',
    state: { marker: 'committed', checkpointWriteSequence: 2 },
  }]
  port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: committedTrace,
    checkpointWriteSequence: 2,
  })

  const conflicting = port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: [{
      type: 'runtime_checkpoint',
      state: { marker: 'conflicting', checkpointWriteSequence: 2 },
    }],
    checkpointWriteSequence: 2,
  })

  assert.deepEqual(conflicting.trace, committedTrace)
  assert.deepEqual(port.getRun({ userId: 'user-a', id: 'run-1' }).trace, committedTrace)
})

test('sqlite subagent adapter permits trace extension when the equal-sequence checkpoint is unchanged', (t) => {
  const { db, adapter } = createFixture()
  const port = prepareSubagentRunPersistencePort(adapter)
  t.after(() => db.close())
  createRun(port)

  const committedCheckpoint = {
    type: 'runtime_checkpoint',
    state: {
      marker: 'committed',
      checkpointWriteSequence: 2,
      nested: { alpha: 1, beta: 2 },
    },
    at: 100,
  }
  port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: [committedCheckpoint],
    checkpointWriteSequence: 2,
  })

  const extendedTrace = [
    {
      type: 'runtime_checkpoint',
      state: {
        nested: { beta: 2, alpha: 1 },
        checkpointWriteSequence: 2,
        marker: 'committed',
      },
      at: 999,
    },
    { type: 'resume', fromStatus: 'interrupted', at: 200 },
  ]
  const extended = port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: extendedTrace,
  })

  assert.deepEqual(extended.trace, extendedTrace)
  assert.deepEqual(port.getRun({ userId: 'user-a', id: 'run-1' }).trace, extendedTrace)
})

test('sqlite subagent adapter does not downgrade a sequenced checkpoint with an unversioned trace', (t) => {
  const { db, adapter } = createFixture()
  const port = prepareSubagentRunPersistencePort(adapter)
  t.after(() => db.close())
  createRun(port)

  const committedTrace = [{
    type: 'runtime_checkpoint',
    state: { marker: 'committed', checkpointWriteSequence: 2 },
  }]
  port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: committedTrace,
    checkpointWriteSequence: 2,
  })

  const unversioned = port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: [{ type: 'provider', decision: 'invoking' }],
  })

  assert.deepEqual(unversioned.trace, committedTrace)
  assert.deepEqual(port.getRun({ userId: 'user-a', id: 'run-1' }).trace, committedTrace)
})

test('sqlite subagent adapter rejects a lower checkpoint appended after the committed checkpoint', (t) => {
  const { db, adapter } = createFixture()
  const port = prepareSubagentRunPersistencePort(adapter)
  t.after(() => db.close())
  createRun(port)

  const committedTrace = [{
    type: 'runtime_checkpoint',
    state: { marker: 'committed', checkpointWriteSequence: 2 },
  }]
  port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: committedTrace,
    checkpointWriteSequence: 2,
  })

  assert.throws(
    () => port.saveRunningTrace({
      userId: 'user-a',
      id: 'run-1',
      trace: [
        ...committedTrace,
        {
          type: 'runtime_checkpoint',
          state: { marker: 'stale-appended-last', checkpointWriteSequence: 1 },
        },
      ],
      checkpointWriteSequence: 2,
    }),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_STALE_CHECKPOINT',
  )
  assert.deepEqual(port.getRun({ userId: 'user-a', id: 'run-1' }).trace, committedTrace)
})

test('sqlite subagent adapter rejects duplicate equal-sequence checkpoints with conflicting state', (t) => {
  const { db, adapter } = createFixture()
  const port = prepareSubagentRunPersistencePort(adapter)
  t.after(() => db.close())
  createRun(port)

  const committedTrace = [{
    type: 'runtime_checkpoint',
    state: { marker: 'committed', checkpointWriteSequence: 2 },
  }]
  port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: committedTrace,
    checkpointWriteSequence: 2,
  })

  const result = port.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: [
      ...committedTrace,
      {
        type: 'runtime_checkpoint',
        state: { marker: 'conflicting-last', checkpointWriteSequence: 2 },
      },
    ],
    checkpointWriteSequence: 2,
  })

  assert.deepEqual(result.trace, committedTrace)
  assert.deepEqual(port.getRun({ userId: 'user-a', id: 'run-1' }).trace, committedTrace)
})

test('sqlite subagent adapter enforces owner isolation on every scoped mutation', (t) => {
  const { db, adapter } = createFixture()
  t.after(() => db.close())
  createRun(adapter)

  assert.throws(
    () => adapter.markRunning({ userId: 'user-b', id: 'run-1', trace: [] }),
    /subagent run not found/,
  )
  assert.throws(
    () => adapter.saveRunningTrace({ userId: 'user-b', id: 'run-1', trace: [] }),
    /subagent run is not running/,
  )
  assert.equal(adapter.finishRun({
    userId: 'user-b',
    id: 'run-1',
    status: 'failed',
    resultText: 'wrong owner',
    trace: [],
    finishedAt: 500,
  }), null)
  assert.deepEqual(adapter.interruptRunningRun({
    userId: 'user-b',
    id: 'run-1',
    status: 'interrupted',
    resultText: 'wrong owner',
    trace: [],
    finishedAt: 500,
  }), { userId: 'user-b', id: 'run-1', interrupted: false })

  const owned = adapter.getRun({ userId: 'user-a', id: 'run-1' })
  assert.equal(owned.status, 'running')
  assert.equal(owned.resultText, '')
})

test('sqlite subagent adapter lists running runs and interrupts each run with a status CAS', (t) => {
  const { db, adapter } = createFixture()
  t.after(() => db.close())
  createRun(adapter)
  createRun(adapter, {
    id: 'run-2',
    userId: 'user-b',
    parentSessionId: null,
    parentMessageId: null,
    createdAt: 101,
  })
  createRun(adapter, { id: 'run-3', createdAt: 102 })
  adapter.finishRun({
    userId: 'user-a',
    id: 'run-3',
    status: 'completed',
    resultText: 'already done',
    trace: [{ type: 'done', at: 150 }],
    finishedAt: 150,
  })

  const running = adapter.listRunningRuns()
  assert.deepEqual(new Set(running.map((run) => run.id)), new Set(['run-1', 'run-2']))
  assert.ok(running.every((run) => !Object.isFrozen(run)))

  const trace = [
    { type: 'start', at: 100 },
    { type: 'interrupted', reason: 'service_restart', resumable: false, at: 600 },
  ]
  const changed = adapter.interruptRunningRun({
    userId: 'user-a',
    id: 'run-1',
    status: 'interrupted',
    resultText: '子代理因服务重启而中断；可使用原运行 ID 重试并从 checkpoint 继续。',
    trace,
    finishedAt: 600,
  })
  assert.deepEqual(changed, { userId: 'user-a', id: 'run-1', interrupted: true })
  assert.deepEqual(adapter.interruptRunningRun({
    userId: 'user-a',
    id: 'run-1',
    status: 'interrupted',
    resultText: 'duplicate recovery',
    trace: [],
    finishedAt: 601,
  }), { userId: 'user-a', id: 'run-1', interrupted: false })

  const interrupted = adapter.getRun({ userId: 'user-a', id: 'run-1' })
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.finishedAt, 600)
  assert.deepEqual(interrupted.trace, trace)
  assert.deepEqual(adapter.listRunningRuns().map((run) => run.id), ['run-2'])
})

test('sqlite subagent adapter does not let a stale recovery snapshot erase a newer checkpoint', (t) => {
  const { db, adapter } = createFixture()
  t.after(() => db.close())
  createRun(adapter)

  const staleSnapshot = adapter.listRunningRuns().find((run) => run.id === 'run-1')
  const committedTrace = [
    ...staleSnapshot.trace,
    {
      type: 'runtime_checkpoint',
      state: { marker: 'committed-after-scan', checkpointWriteSequence: 2 },
      at: 200,
    },
  ]
  adapter.saveRunningTrace({
    userId: 'user-a',
    id: 'run-1',
    trace: committedTrace,
    checkpointWriteSequence: 2,
  })

  const receipt = adapter.interruptRunningRun({
    userId: 'user-a',
    id: 'run-1',
    status: 'interrupted',
    resultText: 'stale recovery scan',
    trace: [
      ...staleSnapshot.trace,
      { type: 'interrupted', reason: 'service_restart', resumable: false, at: 300 },
    ],
    finishedAt: 300,
  })

  assert.deepEqual(receipt, { userId: 'user-a', id: 'run-1', interrupted: false })
  const preserved = adapter.getRun({ userId: 'user-a', id: 'run-1' })
  assert.equal(preserved.status, 'running')
  assert.deepEqual(preserved.trace, committedTrace)
})

test('sqlite subagent adapter tolerates malformed legacy trace JSON and requires database injection', (t) => {
  assert.throws(
    () => createSqliteSubagentRunPersistenceAdapter(),
    /requires getDb/,
  )

  const { db, adapter } = createFixture()
  t.after(() => db.close())
  db.prepare(`
    INSERT INTO subagent_runs (
      id, user_id, agent_type, prompt, status, trace_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-run', 'user-a', 'plan', 'legacy', 'interrupted', '{bad json', 10)

  assert.deepEqual(adapter.getRun({ userId: 'user-a', id: 'legacy-run' }).trace, [])
})

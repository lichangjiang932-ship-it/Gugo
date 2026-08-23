import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'

import { migrateToV79 } from '../server/migrations/v79SideEffectExecutions.js'
import { migrateToV92 } from '../server/migrations/v92HookSideEffectExecutions.js'
import {
  createSideEffectExecutionLedger,
  SIDE_EFFECT_LEDGER_CONFLICT,
} from '../server/services/sideEffectExecutionLedger.js'
import {
  createHookSideEffectExecutor,
  createHookSideEffectIdentity,
  HOOK_SIDE_EFFECT_LEDGER_CONFLICT,
  HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN,
} from '../server/services/hookSideEffectExecution.js'

function fixture() {
  const db = new Database(':memory:')
  migrateToV79(db)
  migrateToV92(db)
  let now = 100
  const ledger = createSideEffectExecutionLedger({ db, now: () => now++ })
  const executor = createHookSideEffectExecutor({ ledger })
  const hook = {
    id: 'hook-a',
    userId: 'owner-a',
    event: 'pre_tool_use',
    toolPattern: '*',
    argumentMatcher: null,
    kind: 'http',
    command: null,
    url: 'https://example.com/hook',
    headers: { Authorization: 'Bearer secret' },
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
    updatedAt: 10,
  }
  const payload = {
    event: 'pre_tool_use',
    tool: 'write_file',
    args: { path: 'report.txt' },
    userId: 'owner-a',
    requestId: 'request-a',
    timestamp: 123,
  }
  return { db, ledger, executor, hook, payload, invocationId: 'invocation-a' }
}

test('same Hook invocation executes once and replays a committed outcome', async () => {
  const f = fixture()
  try {
    let calls = 0
    const input = {
      hook: f.hook,
      payload: f.payload,
      invocationId: f.invocationId,
      execute: async ({ idempotencyKey }) => {
        calls += 1
        return { allow: true, idempotencyKey }
      },
    }
    const first = await f.executor.execute(input)
    const replay = await f.executor.execute(input)
    assert.equal(calls, 1)
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.outcome.allow, true)
    assert.equal(replay.outcome.sideEffectLedgerReplay, true)
    const row = f.db.prepare('SELECT effect_kind, scope_kind, request_id, status FROM side_effect_executions').get()
    assert.deepEqual(row, {
      effect_kind: 'hook',
      scope_kind: 'request',
      request_id: f.invocationId,
      status: 'committed',
    })
  } finally {
    f.db.close()
  }
})

test('concurrent identical Hook invocations share one in-process execution', async () => {
  const f = fixture()
  try {
    let calls = 0
    let release
    const boundary = new Promise((resolve) => { release = resolve })
    const input = {
      hook: f.hook,
      payload: f.payload,
      invocationId: f.invocationId,
      execute: async () => {
        calls += 1
        await boundary
        return { allow: true }
      },
    }
    const first = f.executor.execute(input)
    const second = f.executor.execute(input)
    release()
    const [left, right] = await Promise.all([first, second])
    assert.equal(calls, 1)
    assert.strictEqual(left, right)
  } finally {
    f.db.close()
  }
})

test('Hook configuration or payload drift conflicts with the original invocation identity', async () => {
  const f = fixture()
  try {
    await f.executor.execute({
      hook: f.hook,
      payload: f.payload,
      invocationId: f.invocationId,
      execute: async () => ({ allow: true }),
    })
    await assert.rejects(
      f.executor.execute({
        hook: { ...f.hook, updatedAt: 11, url: 'https://example.com/changed' },
        payload: f.payload,
        invocationId: f.invocationId,
        execute: async () => ({ allow: true }),
      }),
      (error) => [HOOK_SIDE_EFFECT_LEDGER_CONFLICT, SIDE_EFFECT_LEDGER_CONFLICT].includes(error?.code),
    )
    await assert.rejects(
      f.executor.execute({
        hook: f.hook,
        payload: { ...f.payload, args: { path: 'other.txt' } },
        invocationId: f.invocationId,
        execute: async () => ({ allow: true }),
      }),
      (error) => [HOOK_SIDE_EFFECT_LEDGER_CONFLICT, SIDE_EFFECT_LEDGER_CONFLICT].includes(error?.code),
    )
  } finally {
    f.db.close()
  }
})

test('prepared Hook executions continue, while executing executions become unknown without replay', async () => {
  const preparedFixture = fixture()
  try {
    const identity = createHookSideEffectIdentity(preparedFixture)
    preparedFixture.ledger.prepare(identity)
    let preparedCalls = 0
    const result = await preparedFixture.executor.execute({
      hook: preparedFixture.hook,
      payload: preparedFixture.payload,
      invocationId: preparedFixture.invocationId,
      execute: async () => {
        preparedCalls += 1
        return { allow: true }
      },
    })
    assert.equal(preparedCalls, 1)
    assert.equal(result.record.status, 'committed')
  } finally {
    preparedFixture.db.close()
  }

  const executingFixture = fixture()
  try {
    const identity = createHookSideEffectIdentity(executingFixture)
    executingFixture.ledger.prepare(identity)
    executingFixture.ledger.claimExecution(identity)
    let executingCalls = 0
    await assert.rejects(
      executingFixture.executor.execute({
        hook: executingFixture.hook,
        payload: executingFixture.payload,
        invocationId: executingFixture.invocationId,
        execute: async () => {
          executingCalls += 1
          return { allow: true }
        },
      }),
      (error) => error?.code === HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN,
    )
    assert.equal(executingCalls, 0)
    assert.equal(executingFixture.ledger.read(identity).status, 'unknown')
  } finally {
    executingFixture.db.close()
  }
})

test('a thrown Hook boundary becomes unknown and is never automatically replayed', async () => {
  const f = fixture()
  try {
    const run = () => f.executor.execute({
      hook: f.hook,
      payload: f.payload,
      invocationId: f.invocationId,
      execute: async () => { throw new Error('connection lost') },
    })
    await assert.rejects(run(), (error) => error?.code === HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN)
    await assert.rejects(run(), (error) => error?.code === HOOK_SIDE_EFFECT_OUTCOME_UNKNOWN)
    assert.equal(f.db.prepare('SELECT status FROM side_effect_executions').get().status, 'unknown')
  } finally {
    f.db.close()
  }
})

test('failed Hook outcomes are durable and replayed without crossing the boundary again', async () => {
  const f = fixture()
  try {
    let calls = 0
    const input = {
      hook: f.hook,
      payload: f.payload,
      invocationId: f.invocationId,
      execute: async () => {
        calls += 1
        return { allow: false, error: 'HTTP 500' }
      },
    }
    const first = await f.executor.execute(input)
    const replay = await f.executor.execute(input)
    assert.equal(first.record.status, 'failed')
    assert.equal(replay.record.status, 'failed')
    assert.equal(replay.outcome.error, 'HTTP 500')
    assert.equal(calls, 1)
  } finally {
    f.db.close()
  }
})

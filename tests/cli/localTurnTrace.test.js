import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { CliUsageError } from '../../bin/cli/errors.js'
import { parseTraceArgs } from '../../bin/cli/traceCommand.js'
import { summarizeTurnTrace, readLocalTurnTrace } from '../../server/services/localTurnTraceService.js'
import { closeDb, getDb } from '../../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../../server/adapters/authAccount.js'
import { upsertSessionForAtomicCommit } from '../../server/services/sessionStore.js'
import { appendTurnEvent } from '../../server/services/turnEventStore.js'
import { createTurnEvent } from '../../shared/turnEvents.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-trace-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const issued = issueEmailCode({ email: 'trace@example.com' })
const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id

test('trace argument parsing requires a turn id and guards options', () => {
  assert.deepEqual(parseTraceArgs(['turn-1']), { turnId: 'turn-1', sessionId: '', limit: 2_000, export: 'text', json: false })
  assert.deepEqual(parseTraceArgs(['turn-1', '--session-id', 's1', '--limit', '50', '--export', 'otel']), {
    turnId: 'turn-1', sessionId: 's1', limit: '50', export: 'otel', json: false,
  })
  assert.equal(parseTraceArgs(['turn-1', '--json']).export, 'json')
  for (const argv of [[], ['--json'], ['turn-1', '--bogus'], ['turn-1', '--session-id'], ['a', 'b'], ['turn-1', '--json=1'], ['turn-1', '--json', '--json'], ['turn-1', '--export', 'yaml']]) {
    assert.throws(() => parseTraceArgs(argv), CliUsageError, JSON.stringify(argv))
  }
})

test('summarizeTurnTrace aggregates model, tool, approval and usage facts', () => {
  const aggregates = summarizeTurnTrace([
    { type: 'model.phase', payload: { phase: 'completed', usage: { promptTokens: 100, completionTokens: 20, cacheHitTokens: 80 } } },
    { type: 'model.phase', payload: { phase: 'completed', usage: { promptTokens: 10 } } },
    { type: 'tool.started', payload: { name: 'read_file' } },
    { type: 'tool.completed', payload: { name: 'read_file', error: null } },
    { type: 'tool.completed', payload: { name: 'bash_exec', error: { code: 'X' } } },
    { type: 'approval.required', payload: { toolName: 'bash_exec' } },
    { type: 'approval.resolved', payload: { proceed: false } },
    { type: 'turn.checkpoint', payload: {} },
  ])
  assert.equal(aggregates.modelPhases, 2)
  assert.equal(aggregates.toolCalls, 1)
  assert.equal(aggregates.toolFailures, 1)
  assert.equal(aggregates.approvalsRequired, 1)
  assert.equal(aggregates.approvalsDenied, 1)
  assert.equal(aggregates.checkpoints, 1)
  assert.deepEqual(aggregates.usage, {
    promptTokens: 110, completionTokens: 20, cacheHitTokens: 80, cacheMissTokens: 0,
  })
  assert.deepEqual(aggregates.tools, [
    { name: 'bash_exec', calls: 1, failures: 1 },
    { name: 'read_file', calls: 1, failures: 0 },
  ])
})

test('readLocalTurnTrace reconstructs a persisted turn and reports missing turns', async () => {
  getDb().transaction(() => upsertSessionForAtomicCommit({ id: 'trace-session', userId, title: 'Trace' }))()
  const base = { sessionId: 'trace-session', turnId: 'trace-turn', userId, createdAt: 1 }
  const events = [
    { id: 'e0', sequence: 0, type: 'turn.started', payload: { approvalMode: 'plan' } },
    { id: 'e1', sequence: 1, type: 'model.phase', payload: { phase: 'completed', usage: { promptTokens: 5 } } },
    { id: 'e2', sequence: 2, type: 'tool.started', payload: { name: 'read_file', toolCallId: 'c1' } },
    { id: 'e3', sequence: 3, type: 'tool.completed', payload: { name: 'read_file', toolCallId: 'c1', error: null } },
    { id: 'e4', sequence: 4, type: 'turn.completed', payload: { text: 'done' } },
  ]
  for (const event of events) {
    appendTurnEvent({ userId, event: createTurnEvent({ ...base, ...event }) })
  }
  // Runtime initialization owns identity creation; read-only trace must not.
  getDb().prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('local_auth_owner_user_id', userId)
  closeDb()

  const trace = await readLocalTurnTrace({ turnId: 'trace-turn' })
  assert.equal(trace.ok, true)
  assert.equal(trace.sessionId, 'trace-session')
  assert.equal(trace.events.length, 5)
  assert.equal(trace.events[0].type, 'turn.started')
  assert.equal(trace.aggregates.modelPhases, 1)
  assert.equal(trace.aggregates.toolCalls, 1)
  assert.equal(trace.aggregates.usage.promptTokens, 5)

  // Deterministic OTel-shaped spans with a root Turn span and tool child.
  assert.match(trace.traceId, /^[a-f0-9]{32}$/u)
  const root = trace.spans.find((span) => !span.parentSpanId)
  assert.equal(root.name, 'turn')
  assert.match(root.spanId, /^[a-f0-9]{16}$/u)
  assert.equal(root.attributes.turnId, 'trace-turn')
  const toolSpan = trace.spans.find((span) => span.name.startsWith('tool.'))
  assert.equal(toolSpan.parentSpanId, root.spanId)
  assert.equal(toolSpan.status.code, 'OK')
  const modelSpan = trace.spans.find((span) => span.name.startsWith('model.iteration.'))
  assert.equal(modelSpan.attributes.promptTokens, 5)
  assert.equal(modelSpan.status.code, 'OK')

  const missing = await readLocalTurnTrace({ turnId: 'no-such-turn' })
  assert.equal(missing.ok, false)
  assert.equal(missing.blocking.code, 'TURN_NOT_FOUND')

  const empty = await readLocalTurnTrace({ turnId: '' })
  assert.equal(empty.ok, false)
  assert.equal(empty.blocking.code, 'TURN_ID_REQUIRED')
})

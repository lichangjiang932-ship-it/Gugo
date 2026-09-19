import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { cmdTrace, parseTraceArgs } from '../../bin/cli/traceCommand.js'
import { closeDb, createUser, getDb } from '../../server/db.js'
import { upsertSessionForAtomicCommit } from '../../server/services/sessionStore.js'
import { appendTurnEvent } from '../../server/services/turnEventStore.js'
import { createTurnEvent } from '../../shared/turnEvents.js'

function capture() {
  let text = ''
  return { stream: new Writable({ write(chunk, _encoding, done) { text += String(chunk); done() } }), text: () => text }
}

function fixture(t, { initialized = true } = {}) {
  closeDb()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-trace-command-'))
  const env = { APP_DATA_DIR: path.join(cwd, 'data'), APP_DB_PATH: path.join(cwd, 'data', 'app.db'),
    ARTIFACT_DIR: path.join(cwd, 'artifacts'), AUTH_MODE: 'local', GUGO_LOAD_DOTENV: '1' }
  const previous = { APP_DATA_DIR: process.env.APP_DATA_DIR, APP_DB_PATH: process.env.APP_DB_PATH }
  Object.assign(process.env, { APP_DATA_DIR: env.APP_DATA_DIR, APP_DB_PATH: env.APP_DB_PATH })
  t.after(() => {
    closeDb()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  if (initialized) {
    createUser({ id: 'trace-command-owner', email: 'trace-command@example.invalid' })
    const db = getDb()
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('local_auth_owner_user_id', 'trace-command-owner')
    db.transaction(() => {
      upsertSessionForAtomicCommit({ id: 'session', userId: 'trace-command-owner', title: 'fixture' })
      for (let sequence = 0; sequence < 4; sequence++) {
        appendTurnEvent({ userId: 'trace-command-owner', event: createTurnEvent({
          id: `trace-command-${sequence}`, userId: 'trace-command-owner', sessionId: 'session', turnId: 'turn', sequence,
          createdAt: sequence + 1, type: sequence === 0 ? 'turn.started' : sequence === 3 ? 'turn.completed' : 'assistant.delta',
          payload: sequence === 0 ? { approvalMode: 'plan' } : { text: 'fixture trace' },
        }) })
      }
    })()
    closeDb()
  }
  return { cwd, env }
}

test('trace help validates explicit bounds/formats without requiring a turn or reading state', () => {
  assert.equal(parseTraceArgs([], { help: true }).turnId, '')
  assert.equal(parseTraceArgs(['turn', '--json', '--export', 'json']).export, 'json')
  for (const [argv, code] of [
    [['turn', '--limit', '0'], 'CLI_TRACE_LIMIT_INVALID'],
    [['turn', '--limit', '10001'], 'CLI_TRACE_LIMIT_INVALID'],
    [['turn', '--json', '--export', 'yaml'], 'CLI_TRACE_EXPORT_INVALID'],
    [['turn', '--json', '--export', 'text'], 'CLI_TRACE_EXPORT_CONFLICT'],
    [['turn', '--session-id', '--json'], 'CLI_OPTION_VALUE_REQUIRED'],
  ]) assert.throws(() => parseTraceArgs(argv, { help: true }), { code })
})

test('trace CLI text, JSON and OTLP preserve actual service coverage without changing its database', async (t) => {
  const f = fixture(t)
  const before = createHash('sha256').update(fs.readFileSync(f.env.APP_DB_PATH)).digest('hex')
  const files = fs.readdirSync(f.env.APP_DATA_DIR).sort()
  for (const [limit, coverage] of [[2, 'partial'], [4, 'complete']]) {
    const text = capture()
    assert.equal(await cmdTrace(['turn', '--limit', String(limit)], { ...f, stdout: text.stream }), 0)
    assert.match(text.text(), new RegExp(`events=${limit} .*coverage=${coverage}`, 'u'))
    assert.equal(text.text().includes('Partial trace:'), coverage === 'partial')
    const json = capture()
    assert.equal(await cmdTrace(['turn', '--limit', String(limit), '--json'], { ...f, stdout: json.stream }), 0)
    const report = JSON.parse(json.text())
    assert.equal(report.events.length, limit)
    assert.equal(report.coverage, coverage)
    assert.equal(report.truncated, coverage === 'partial')
    const otel = capture()
    assert.equal(await cmdTrace(['turn', '--limit', String(limit), '--export', 'otel'], { ...f, stdout: otel.stream }), 0)
    const spans = JSON.parse(otel.text()).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
    const root = spans.find((span) => !span.parentSpanId)
    assert.ok(root.attributes.some((attribute) => attribute.key === 'gugo.trace.coverage' && attribute.value.stringValue === coverage))
  }
  assert.deepEqual(fs.readdirSync(f.env.APP_DATA_DIR).sort(), files)
  assert.equal(createHash('sha256').update(fs.readFileSync(f.env.APP_DB_PATH)).digest('hex'), before)
})

test('trace readonly failures explain initialization and authenticated-service boundaries in English', async (t) => {
  const f = fixture(t, { initialized: false })
  const missing = capture()
  assert.equal(await cmdTrace(['turn'], { ...f, stdout: missing.stream }), 1)
  assert.match(missing.text(), /TRACE_DATABASE_NOT_INITIALIZED.*Trace does not create databases or migrate data/u)
  assert.equal(fs.existsSync(f.env.APP_DATA_DIR), false)
  const networkDeployment = capture()
  assert.equal(await cmdTrace(['turn'], { ...f, env: { ...f.env, AUTH_MODE: 'multi_user' }, stdout: networkDeployment.stream }), 1)
  assert.match(networkDeployment.text(), /AUTH_REQUIRED.*authenticated service or SDK/u)
  assert.match(networkDeployment.text(), /remote gugo login token does not authorize/u)
  assert.equal(fs.existsSync(f.env.APP_DATA_DIR), false)
})

test('trace active-WAL guidance never recommends deleting state or reinitializing identity', async (t) => {
  const f = fixture(t)
  const db = getDb()
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('trace-fixture-live-wal', '1')
  const result = capture()
  assert.equal(await cmdTrace(['turn'], { ...f, stdout: result.stream }), 1)
  assert.match(result.text(), /TRACE_ACTIVE_WAL_UNAVAILABLE.*running authenticated service\/SDK.*normally stop/u)
  assert.match(result.text(), /does not checkpoint or remove active WAL\/SHM/u)
})

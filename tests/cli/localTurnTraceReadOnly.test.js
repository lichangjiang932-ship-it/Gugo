import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { closeDb, createUser, getDb, DB_SCHEMA_VERSION } from '../../server/db.js'
import { upsertSessionForAtomicCommit } from '../../server/services/sessionStore.js'
import { appendTurnEvent } from '../../server/services/turnEventStore.js'
import { createTurnEvent } from '../../shared/turnEvents.js'
import { readLocalTurnTrace } from '../../server/services/localTurnTraceService.js'

const CLI = fileURLToPath(new URL('../../bin/yma-cli.js', import.meta.url))

function fixture(t) {
  closeDb()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-trace-readonly-'))
  const env = { APP_DATA_DIR: path.join(directory, 'data'), APP_DB_PATH: path.join(directory, 'data', 'app.db'),
    ARTIFACT_DIR: path.join(directory, 'artifacts'), AUTH_MODE: 'local', GUGO_LOAD_DOTENV: '0' }
  const previous = { APP_DATA_DIR: process.env.APP_DATA_DIR, APP_DB_PATH: process.env.APP_DB_PATH }
  Object.assign(process.env, { APP_DATA_DIR: env.APP_DATA_DIR, APP_DB_PATH: env.APP_DB_PATH })
  t.after(() => {
    closeDb()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  return { directory, env, read: (options = {}) => readLocalTurnTrace({ cwd: directory, env, turnId: 'turn-a', ...options }) }
}

function seed({ env }, { owner = true, count = 2 } = {}) {
  createUser({ id: 'trace-owner', email: 'trace-owner@example.invalid' })
  createUser({ id: 'other-owner', email: 'other-owner@example.invalid' })
  const db = getDb()
  if (owner) db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('local_auth_owner_user_id', 'trace-owner')
  for (const [userId, sessionId, turnId, size] of [
    ['trace-owner', 'session-a', 'turn-a', count], ['other-owner', 'other-session', 'other-turn', 2],
  ]) {
    db.transaction(() => {
      // Do not leave background fixture hooks that reopen the writable singleton
      // after closeDb; this test owns an already-finished, persisted runtime.
      upsertSessionForAtomicCommit({ id: sessionId, userId, title: sessionId })
      for (let sequence = 0; sequence < size; sequence += 1) {
        const type = sequence === 0 ? 'turn.started' : sequence === size - 1 ? 'turn.completed' : 'assistant.delta'
        appendTurnEvent({ userId, event: createTurnEvent({
          id: `${turnId}-${sequence}`, turnId, sessionId, userId, sequence, createdAt: sequence + 1, type,
          payload: type === 'turn.started' ? { approvalMode: 'plan' } : { text: userId === 'trace-owner' ? 'fixture' : 'foreign-private-text' },
        }) })
      }
    })()
  }
  assert.equal(fs.existsSync(env.APP_DB_PATH), true)
  return db
}

function snapshot(directory) {
  if (!fs.existsSync(directory)) return null
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => {
    const filename = path.join(directory, name)
    return [name, fs.statSync(filename).isFile() ? createHash('sha256').update(fs.readFileSync(filename)).digest('hex') : 'directory']
  }))
}

test('trace CLI on a missing runtime does not create directories, SQLite or a local identity', (t) => {
  const f = fixture(t)
  const env = { ...process.env, ...f.env, GUGO_LOAD_DOTENV: '1', APP_CONFIG_PATH: '', MODEL_BASE_URL: '', MODEL_PROVIDERS: '' }
  const result = spawnSync(process.execPath, [CLI, 'trace', 'turn-a', '--json'], {
    cwd: f.directory, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  })
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.status, 1)
  assert.equal(fs.existsSync(f.env.APP_DATA_DIR), false)
  assert.equal(fs.existsSync(f.env.ARTIFACT_DIR), false)
  assert.doesNotMatch(result.stderr, /\[env\]/u)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.equal(report.blocking.code, 'TRACE_DATABASE_NOT_INITIALIZED')
})

test('trace reads an existing owner and leaves database, sessions and sidecars byte-identical', async (t) => {
  const f = fixture(t)
  seed(f)
  closeDb()
  const before = snapshot(f.env.APP_DATA_DIR)
  const envBefore = { APP_DATA_DIR: process.env.APP_DATA_DIR, APP_DB_PATH: process.env.APP_DB_PATH }
  const trace = await f.read()
  assert.equal(trace.ok, true)
  assert.equal(trace.events.length, 2)
  assert.equal(trace.sessionId, 'session-a')
  assert.equal(trace.coverage, 'complete')
  assert.equal(trace.truncated, false)
  assert.deepEqual(snapshot(f.env.APP_DATA_DIR), before)
  assert.deepEqual({ APP_DATA_DIR: process.env.APP_DATA_DIR, APP_DB_PATH: process.env.APP_DB_PATH }, envBefore)
})

test('trace cannot expose a foreign turn through an explicit session id', async (t) => {
  const f = fixture(t)
  seed(f)
  closeDb()
  const trace = await f.read({ turnId: 'other-turn', sessionId: 'other-session' })
  assert.equal(trace.ok, false)
  assert.equal(trace.blocking.code, 'TURN_NOT_FOUND')
  assert.equal(JSON.stringify(trace).includes('foreign-private-text'), false)
  assert.deepEqual(trace.events, [])
})

test('trace never chooses a first user or manufactures an owner when local identity is absent', async (t) => {
  const f = fixture(t)
  seed(f, { owner: false })
  closeDb()
  const before = snapshot(f.env.APP_DATA_DIR)
  const trace = await f.read()
  assert.equal(trace.ok, false)
  assert.equal(trace.blocking.code, 'TRACE_LOCAL_IDENTITY_NOT_INITIALIZED')
  assert.deepEqual(snapshot(f.env.APP_DATA_DIR), before)
})

test('trace does not migrate an old database', async (t) => {
  const f = fixture(t)
  const db = seed(f)
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(DB_SCHEMA_VERSION - 1), 'schema_version')
  closeDb()
  const before = snapshot(f.env.APP_DATA_DIR)
  const trace = await f.read()
  assert.equal(trace.ok, false)
  assert.equal(trace.blocking.code, 'TRACE_MIGRATION_REQUIRED')
  assert.deepEqual(snapshot(f.env.APP_DATA_DIR), before)
})

test('trace refuses active WAL and recovery journals instead of changing diagnostic state', async (t) => {
  const f = fixture(t)
  seed(f)
  assert.ok(fs.statSync(`${f.env.APP_DB_PATH}-wal`).size > 0)
  const active = snapshot(f.env.APP_DATA_DIR)
  assert.equal((await f.read()).blocking.code, 'TRACE_ACTIVE_WAL_UNAVAILABLE')
  assert.deepEqual(snapshot(f.env.APP_DATA_DIR), active)
  closeDb()
  fs.writeFileSync(`${f.env.APP_DB_PATH}-journal`, 'fixture: recovery required')
  const journal = snapshot(f.env.APP_DATA_DIR)
  assert.equal((await f.read()).blocking.code, 'TRACE_SQLITE_RECOVERY_REQUIRED')
  assert.deepEqual(snapshot(f.env.APP_DATA_DIR), journal)
})

test('trace respects config-layer auth mode and never falls back to local bootstrap', async (t) => {
  const f = fixture(t)
  seed(f)
  closeDb()
  fs.mkdirSync(path.join(f.directory, '.gugo'))
  fs.writeFileSync(path.join(f.directory, '.gugo', 'runtime.json'), JSON.stringify({ AUTH_MODE: 'multi_user' }))
  const env = { ...f.env }
  delete env.AUTH_MODE
  const before = snapshot(f.env.APP_DATA_DIR)
  const trace = await f.read({ env })
  assert.equal(trace.ok, false)
  assert.equal(trace.blocking.code, 'AUTH_REQUIRED')
  assert.deepEqual(snapshot(f.env.APP_DATA_DIR), before)
})

test('trace reports malformed config without initializing storage or exposing its contents', async (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.directory, '.gugo'))
  fs.writeFileSync(path.join(f.directory, '.gugo', 'runtime.json'), '{invalid-private-fixture')
  const trace = await f.read()
  assert.equal(trace.ok, false)
  assert.equal(trace.blocking.code, 'RUNTIME_CONFIG_FILE_INVALID')
  assert.equal(JSON.stringify(trace).includes('private-fixture'), false)
  assert.equal(fs.existsSync(f.env.APP_DATA_DIR), false)
})

test('trace honors limits above a store page and labels partial event history explicitly', async (t) => {
  const f = fixture(t)
  seed(f, { count: 2_005 })
  closeDb()
  const trace = await f.read({ limit: 2_100 })
  assert.equal(trace.ok, true, JSON.stringify(trace.blocking))
  assert.equal(trace.events.length, 2_005)
  assert.equal(trace.coverage, 'complete')
  const partial = await f.read({ limit: 3 })
  assert.equal(partial.events.length, 3)
  assert.equal(partial.truncated, true)
  assert.equal(partial.coverage, 'partial')
  assert.equal(partial.spans.find((span) => !span.parentSpanId).attributes['gugo.trace.coverage'], 'partial')
})

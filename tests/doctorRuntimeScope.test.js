import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getDb, closeDb, createUser, DB_SCHEMA_VERSION } from '../server/db.js'
import { withDiagnosticRuntimeScope } from '../server/core/diagnosticRuntimeScope.js'
import { credentialScopedFingerprint } from '../server/utils/credentialVault.js'
import { buildUserModelEnv } from '../server/services/modelProviderStore.js'
import { runHeadlessDoctor } from '../server/services/headlessDoctorService.js'

let sequence = 0
function fixture(t) {
  closeDb()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-doctor-scope-'))
  const userId = `doctor-scope-${++sequence}`
  const env = { AUTH_MODE: 'local', APP_DATA_DIR: directory, APP_DB_PATH: path.join(directory, 'app.db'),
    ARTIFACT_DIR: path.join(directory, 'artifacts'), GUGO_LOAD_DOTENV: '0', CREDENTIAL_ENCRYPTION_KEY: '',
    MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'fixture-model' }
  process.env.APP_DATA_DIR = env.APP_DATA_DIR
  process.env.APP_DB_PATH = env.APP_DB_PATH
  createUser({ id: userId, email: `${userId}@example.invalid` })
  const db = getDb()
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('local_auth_owner_user_id', userId)
  t.after(() => {
    closeDb()
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  return { db, env, userId, directory }
}

function insertLegacyProvider({ db, userId }, id = 'legacy-fixture') {
  const secret = Buffer.from(JSON.stringify({ apiKey: 'legacy-doctor-fixture-secret' })).toString('base64')
  const headers = Buffer.from(JSON.stringify({ 'X-Fixture': 'legacy-header-fixture' })).toString('base64')
  db.prepare(`INSERT INTO model_providers(id,user_id,provider_key,label,base_url,models_json,default_model,
    enabled,is_default,secret_json,headers_json,created_at,updated_at,config_revision,supports_tools)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, id, 'Legacy fixture', 'http://127.0.0.1:9/v1',
    '["fixture-model"]', 'fixture-model', 1, 1, secret, headers, 1, 1, 1, 1)
  return { id, secret, headers }
}

test('diagnostic database scope is asynchronous and cannot close the concurrent normal singleton', async (t) => {
  const { db: normal, env } = fixture(t)
  const reader = new Database(':memory:')
  reader.exec('CREATE TABLE fixture(value TEXT)')
  reader.pragma('query_only = ON')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const reading = withDiagnosticRuntimeScope({ database: reader, env }, async () => {
    assert.equal(getDb(), reader)
    await gate
    assert.equal(getDb(), reader)
    assert.throws(() => getDb().exec("INSERT INTO fixture VALUES('forbidden')"), /readonly|read-only/iu)
    closeDb()
    assert.equal(getDb(), reader)
  })
  assert.equal(getDb(), normal)
  normal.exec('CREATE TABLE outside_diagnostic(value TEXT)')
  release()
  await reading
  assert.equal(getDb(), normal)
  assert.equal(normal.prepare('SELECT COUNT(*) AS count FROM outside_diagnostic').get().count, 0)
  reader.close()
})

test('legacy provider credentials are readable in diagnostics without lazy migration or a new key', (t) => {
  const state = fixture(t)
  const legacy = insertLegacyProvider(state)
  const before = state.db.prepare('SELECT secret_json,headers_json FROM model_providers WHERE id=?').get(legacy.id)
  const directoryBefore = fs.readdirSync(state.directory).sort()
  withDiagnosticRuntimeScope({ database: state.db, env: state.env }, () => {
    const resolved = buildUserModelEnv({ userId: state.userId, env: state.env })
    assert.equal(resolved.MODEL_API_KEY, 'legacy-doctor-fixture-secret')
  })
  assert.deepEqual(state.db.prepare('SELECT secret_json,headers_json FROM model_providers WHERE id=?').get(legacy.id), before)
  assert.deepEqual(fs.readdirSync(state.directory).sort(), directoryBefore)
  assert.equal(fs.existsSync(path.join(state.directory, '.credentials.key')), false)
})

test('read-only credential fingerprints neither create nor chmod a key file', (t) => {
  const { db, env, directory } = fixture(t)
  const keyPath = path.join(directory, 'missing', 'diagnostic.key')
  const scopedEnv = { ...env, CREDENTIAL_KEY_PATH: keyPath }
  assert.throws(() => withDiagnosticRuntimeScope({ database: db, env: scopedEnv }, () => credentialScopedFingerprint('fixture', {
    purpose: 'doctor-fixture', env: scopedEnv,
  })), { code: 'CREDENTIAL_VAULT_KEY_UNAVAILABLE' })
  assert.equal(fs.existsSync(path.dirname(keyPath)), false)
  const existing = path.join(directory, 'existing.key')
  fs.writeFileSync(existing, `${'12'.repeat(32)}\n`, { mode: 0o644 })
  const bytes = fs.readFileSync(existing)
  const mode = fs.statSync(existing).mode
  withDiagnosticRuntimeScope({ database: db, env: { ...env, CREDENTIAL_KEY_PATH: existing } }, () => {
    assert.match(credentialScopedFingerprint('fixture', { purpose: 'doctor-fixture' }), /^[a-f0-9]{64}$/u)
  })
  assert.deepEqual(fs.readFileSync(existing), bytes)
  assert.equal(fs.statSync(existing).mode, mode)
})

test('default Doctor reports migration and pending recovery without applying either', async (t) => {
  const { db, env, directory } = fixture(t)
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(DB_SCHEMA_VERSION - 1), 'schema_version')
  closeDb()
  const before = fs.readFileSync(env.APP_DB_PATH)
  const old = await runHeadlessDoctor({ runtimeCwd: directory, workspaceCwd: directory, env })
  assert.equal(old.ok, false)
  assert.equal(old.diagnostics.sqlite.schema.status, 'migration_required')
  assert.equal(old.blocking.code, 'DOCTOR_MIGRATION_REQUIRED')
  assert.deepEqual(fs.readFileSync(env.APP_DB_PATH), before)
  const journal = path.join(directory, '.runtime.json.evolution-config.pending.json')
  fs.writeFileSync(journal, '{}\n')
  const recovery = await runHeadlessDoctor({ runtimeCwd: directory, workspaceCwd: directory, env })
  assert.equal(recovery.blocking.code, 'DOCTOR_RECOVERY_REQUIRED')
  assert.equal(fs.readFileSync(journal, 'utf8'), '{}\n')
  assert.deepEqual(fs.readFileSync(env.APP_DB_PATH), before)
})

test('conclusive FK damage blocks a model-ready Doctor without making a request', async (t) => {
  const { db, env, directory } = fixture(t)
  db.exec('CREATE TABLE doctor_parent(id INTEGER PRIMARY KEY); CREATE TABLE doctor_child(value INTEGER REFERENCES doctor_parent(id)); PRAGMA foreign_keys=OFF; INSERT INTO doctor_child VALUES(999); PRAGMA foreign_keys=ON;')
  closeDb()
  const report = await runHeadlessDoctor({ runtimeCwd: directory, workspaceCwd: directory, env,
    runSteps: async () => assert.fail('no model probe was requested') })
  assert.equal(report.ok, false)
  assert.equal(report.blocking.code, 'DOCTOR_DATABASE_CHECK_FAILED')
  assert.equal(report.diagnostics.sqlite.foreignKeys.status, 'failed')
})

test('explicit probe retains canonical provider selection and only updates readiness, not legacy credentials', async (t) => {
  const state = fixture(t)
  const legacy = insertLegacyProvider(state)
  closeDb()
  let calls = 0
  const report = await runHeadlessDoctor({ runtimeCwd: state.directory, workspaceCwd: state.directory, env: state.env,
    providerId: legacy.id, modelName: 'fixture-model', probe: true,
    runSteps: async ({ provider, modelName }) => {
      calls += 1
      assert.equal(provider.id, legacy.id)
      assert.equal(modelName, 'fixture-model')
      return [{ name: 'completion', ok: true }, { name: 'tools', ok: true }]
    },
  })
  assert.equal(report.ok, true, JSON.stringify(report.blocking))
  assert.equal(calls, 1)
  assert.equal(report.model.probe.status, 'passed')
  assert.equal(report.runtime.probeWritesRequested, true)
  assert.equal(report.runtime.credentialWritesAllowed, false)
  const read = new Database(state.env.APP_DB_PATH, { readonly: true })
  try {
    const row = read.prepare('SELECT secret_json,headers_json,readiness_json FROM model_providers WHERE id=?').get(legacy.id)
    assert.equal(row.secret_json, legacy.secret)
    assert.equal(row.headers_json, legacy.headers)
    assert.equal(JSON.parse(row.readiness_json).models['fixture-model'].agent, true)
  } finally { read.close() }
  assert.equal(fs.existsSync(path.join(state.directory, '.credentials.key')), false)
  assert.equal(JSON.stringify(report).includes('legacy-doctor-fixture-secret'), false)
})

test('non-boolean probe/integrity values never opt into network or expensive checks', async (t) => {
  const { env, directory } = fixture(t)
  closeDb()
  const report = await runHeadlessDoctor({ runtimeCwd: directory, workspaceCwd: directory, env,
    probe: 'true', integrity: 'true', runSteps: async () => assert.fail('a string is not explicit probe authorization') })
  assert.equal(report.ok, true, JSON.stringify(report.blocking))
  assert.equal(report.model.probe.status, 'not_run')
  assert.equal(report.runtime.probeWritesRequested, false)
  assert.equal(report.diagnostics.sqlite.integrityCheck.status, 'not_checked')
})

test('blank schema versions are invalid rather than a request to silently migrate', async (t) => {
  const { db, env, directory } = fixture(t)
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(' ', 'schema_version')
  closeDb()
  const before = fs.readFileSync(env.APP_DB_PATH)
  const report = await runHeadlessDoctor({ runtimeCwd: directory, workspaceCwd: directory, env })
  assert.equal(report.ok, false)
  assert.equal(report.blocking.code, 'DB_SCHEMA_VERSION_INVALID')
  assert.deepEqual(fs.readFileSync(env.APP_DB_PATH), before)
})

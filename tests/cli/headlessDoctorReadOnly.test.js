import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parseDoctorArgs } from '../../bin/cli/headlessDoctor.js'
import { getDb, closeDb, createUser } from '../../server/db.js'

function temporaryRuntime(t) {
  closeDb()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-doctor-readonly-'))
  t.after(() => {
    closeDb()
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  return { directory, dataDir: path.join(directory, 'runtime'), dbPath: path.join(directory, 'runtime', 'app.db') }
}

function doctor(fixture, args = []) {
  return spawnSync(process.execPath, ['bin/yma-cli.js', 'doctor', '--headless', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, APP_DATA_DIR: fixture.dataDir, APP_DB_PATH: fixture.dbPath,
      ARTIFACT_DIR: path.join(fixture.directory, 'artifacts'), AUTH_MODE: 'local', GUGO_LOAD_DOTENV: '0',
      MODEL_PROVIDERS: '', MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_NAMES: '', MODEL_API_KEY: '' },
  })
}

function fileFingerprint(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

test('doctor accepts explicit --json without changing the default output contract', () => {
  assert.equal(parseDoctorArgs(['--json']).json, true)
  assert.equal(parseDoctorArgs(['--headless', '--json']).headless, true)
  assert.equal(parseDoctorArgs(['--headless', '--integrity']).integrity, true)
  assert.throws(() => parseDoctorArgs(['--integrity']), { code: 'CLI_OPTION_UNKNOWN' })
  assert.throws(() => parseDoctorArgs(['--json', '--json']), { code: 'CLI_OPTION_DUPLICATE' })
})

test('default doctor does not initialize a missing database or create local login state', (t) => {
  const fixture = temporaryRuntime(t)
  const result = doctor(fixture)
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(fs.existsSync(fixture.dataDir), false, 'a read-only doctor must not create a data directory or database')
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.equal(report.diagnostics.sqlite.status, 'not_initialized')
  assert.equal(report.blocking.action, 'initialize_runtime')
})

test('default doctor leaves an existing database and directory byte-identical', (t) => {
  const fixture = temporaryRuntime(t)
  process.env.APP_DATA_DIR = fixture.dataDir
  process.env.APP_DB_PATH = fixture.dbPath
  createUser({ id: 'doctor-existing-owner', email: 'doctor-existing-owner@example.invalid' })
  getDb().prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('local_auth_owner_user_id', 'doctor-existing-owner')
  closeDb()
  const before = fileFingerprint(fixture.dbPath)
  const files = fs.readdirSync(fixture.dataDir).sort()
  const result = doctor(fixture)
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(fileFingerprint(fixture.dbPath), before, 'doctor must not migrate SQLite or refresh/create an auth session')
  assert.deepEqual(fs.readdirSync(fixture.dataDir).sort(), files)
  const report = JSON.parse(result.stdout)
  assert.equal(report.diagnostics.sqlite.quickCheck.status, 'passed')
  assert.equal(report.diagnostics.sqlite.integrityCheck.status, 'not_checked')
})

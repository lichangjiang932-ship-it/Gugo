import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  collectHeadlessDoctorDiagnostics, inspectDoctorAttachmentStorage, inspectDoctorDatabase, inspectDoctorDependencies,
} from '../server/services/headlessDoctorDiagnostics.js'
import { openDoctorDatabaseReader } from '../server/services/headlessDoctorDatabaseReader.js'

const manifests = {
  gugo: { engines: { node: '^20.19.0 || ^22.13.0 || >=24.0.0' } },
  react: { version: '19.2.6' }, 'react-dom': { version: '19.2.6' },
  ink: { version: '7.1.1', engines: { node: '>=22' }, peerDependencies: { react: '>=19.2.0' } },
}

test('Doctor distinguishes application Node support from optional Ink support', () => {
  const readPackageManifest = (name) => manifests[name]
  const node20 = inspectDoctorDependencies({ nodeVersion: '20.19.0', readPackageManifest })
  assert.equal(node20.node.status, 'passed')
  assert.equal(node20.ink.status, 'unavailable')
  assert.equal(node20.ink.fallback, 'readline')
  const node22 = inspectDoctorDependencies({ nodeVersion: '22.20.0', readPackageManifest })
  assert.equal(node22.ink.status, 'passed')
  assert.equal(node22.runtimeRenderTested, false)
  assert.equal(inspectDoctorDependencies({ nodeVersion: '20.18.0', readPackageManifest }).node.status, 'failed')
})

test('missing optional Ink and mismatched React/DOM are reported without importing renderers', () => {
  const absent = inspectDoctorDependencies({ nodeVersion: '22.20.0', readPackageManifest: (name) => name === 'ink' ? null : manifests[name] })
  assert.equal(absent.ink.status, 'unavailable')
  assert.equal(absent.ink.optional, true)
  const mismatch = inspectDoctorDependencies({ nodeVersion: '22.20.0', readPackageManifest: (name) => name === 'react'
    ? { version: '19.3.0' } : manifests[name] })
  assert.equal(mismatch.reactDom.status, 'failed')
  assert.equal(mismatch.reactDom.code, 'REACT_DOM_VERSION_MISMATCH')
  const unknown = inspectDoctorDependencies({ nodeVersion: 'not-a-version', readPackageManifest: () => null })
  assert.equal(unknown.node.status, 'not_checked')
})

test('SQLite quick/integrity and FK checks execute real read-only PRAGMAs', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id));')
    const before = db.prepare('SELECT total_changes() AS count').get().count
    const healthy = inspectDoctorDatabase({ db })
    assert.equal(healthy.quickCheck.status, 'passed')
    assert.equal(healthy.integrityCheck.status, 'not_checked')
    assert.equal(healthy.foreignKeys.status, 'passed')
    assert.equal(db.prepare('SELECT total_changes() AS count').get().count, before)
    db.exec('PRAGMA foreign_keys=OFF; INSERT INTO child VALUES(1,99); PRAGMA foreign_keys=ON;')
    const unhealthy = inspectDoctorDatabase({ db, integrity: true })
    assert.equal(unhealthy.quickCheck.status, 'passed')
    assert.equal(unhealthy.integrityCheck.status, 'passed')
    assert.equal(unhealthy.foreignKeys.status, 'failed')
    assert.equal(unhealthy.foreignKeys.violations[0].table, 'child')
    assert.equal(unhealthy.status, 'failed')
  } finally { db.close() }
})

test('a real stored CHECK violation is not described as a passed SQLite check', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE fixture(value INTEGER CHECK(value > 0)); PRAGMA ignore_check_constraints=ON; INSERT INTO fixture VALUES(-1); PRAGMA ignore_check_constraints=OFF;')
    const report = inspectDoctorDatabase({ db, integrity: true })
    assert.equal(report.quickCheck.status, 'failed')
    assert.equal(report.integrityCheck.status, 'failed')
    assert.match(report.quickCheck.issues[0], /CHECK constraint/iu)
  } finally { db.close() }
})

test('large databases explicitly defer expensive health checks unless opted in', () => {
  const db = new Database(':memory:')
  try {
    const skipped = inspectDoctorDatabase({ db, databaseBytes: 100 * 1024 * 1024 })
    assert.equal(skipped.status, 'not_checked')
    assert.equal(skipped.quickCheck.checked, false)
    assert.equal(skipped.foreignKeys.checked, false)
    assert.equal(skipped.integrityCheck.checked, false)
    const optedIn = inspectDoctorDatabase({ db, databaseBytes: 100 * 1024 * 1024, integrity: true })
    assert.equal(optedIn.integrityCheck.status, 'passed')
    assert.equal(optedIn.foreignKeys.status, 'passed')
  } finally { db.close() }
})

test('FTS, bounded pending indexing, disabled embeddings and cache observations remain distinct', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE VIRTUAL TABLE messages_fts USING fts5(content); CREATE TABLE memory_search_pending(user_id TEXT);')
    const insert = db.prepare('INSERT INTO memory_search_pending VALUES(?)')
    db.transaction(() => { for (let index = 0; index < 1010; index += 1) insert.run('owner'); insert.run('other') })()
    const calls = []
    const deps = { readPackageManifest: (name) => manifests[name], platform: 'win32',
      resolveMcpCommand: ({ command, args }) => { calls.push({ command, args }); return { command: `C:\\fixture\\${command}.exe`, args } },
    }
    const result = collectHeadlessDoctorDiagnostics({ db, userId: 'owner', env: { MEMORY_EMBEDDINGS_ENABLED: '0' } }, deps)
    assert.equal(result.fts.status, 'passed')
    assert.equal(result.memoryIndex.pending, 1000)
    assert.equal(result.memoryIndex.pendingIsExact, false)
    assert.equal(result.memoryIndex.rebuilt, false)
    assert.equal(result.memoryIndex.embedding.status, 'disabled')
    assert.equal(result.cache.status, 'not_observed')
    assert.equal(result.cache.hitRate, null)
    assert.equal(result.cache.kvCacheInspected, false)
    assert.equal(result.mcp.processStarted, false)
    assert.deepEqual(calls.map((entry) => entry.command), ['node', 'npx', 'python', 'uvx'])
    assert.ok(calls.every((entry) => entry.args.length === 0))
  } finally { db.close() }
})

test('attachment checks inspect metadata without creating an upload directory or file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-doctor-attachment-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const report = inspectDoctorAttachmentStorage({ APP_DATA_DIR: directory })
  assert.equal(report.status, 'not_checked')
  assert.equal(report.exists, false)
  assert.equal(report.writeTested, false)
  assert.deepEqual(fs.readdirSync(directory), [])
  const denied = inspectDoctorAttachmentStorage({ APP_DATA_DIR: directory }, {
    stat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    access: () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }) },
  })
  assert.equal(denied.status, 'failed')
  assert.equal(denied.writeTested, false)
})

test('Node 20 fallback inspects a bounded memory image without changing WAL-mode source bytes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-doctor-image-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'fixture.db')
  const source = new Database(filename)
  source.pragma('journal_mode=WAL')
  source.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('retained')")
  source.close()
  const hash = () => createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
  const before = hash()
  const reader = await openDoctorDatabaseReader(filename, {
    loadNodeSqlite: async () => { throw Object.assign(new Error('Node 20 fixture'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' }) },
  })
  try {
    assert.equal(reader.mode, 'bounded_memory_snapshot')
    assert.equal(reader.database.prepare('SELECT value FROM fixture').get().value, 'retained')
    assert.equal(reader.unchanged(), true)
    assert.throws(() => reader.database.exec("INSERT INTO fixture VALUES('forbidden')"), /readonly|read-only/iu)
  } finally { reader.database.close() }
  assert.equal(hash(), before)
  assert.deepEqual(fs.readdirSync(directory), ['fixture.db'])
})

test('live WAL contents are not silently discarded by immutable diagnostics', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-doctor-wal-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'fixture.db')
  const source = new Database(filename)
  try {
    source.pragma('journal_mode=WAL')
    source.exec('CREATE TABLE fixture(value TEXT)')
    await assert.rejects(openDoctorDatabaseReader(filename), { code: 'DOCTOR_ACTIVE_WAL_UNAVAILABLE' })
    assert.equal(source.prepare('SELECT COUNT(*) AS count FROM fixture').get().count, 0)
  } finally { source.close() }
})

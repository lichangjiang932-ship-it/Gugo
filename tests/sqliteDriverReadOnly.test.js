import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNodeSqliteDatabase } from '../server/adapters/sqliteDriver.js'

test('Node SQLite maps the shared readonly option and refuses a missing file before constructor side effects', () => {
  const calls = []
  class FakeDatabaseSync { constructor(filename, options) { calls.push({ filename, options }) } }
  const Driver = createNodeSqliteDatabase(FakeDatabaseSync)
  new Driver(':memory:', { readonly: true, fileMustExist: true })
  assert.deepEqual(calls, [{ filename: ':memory:', options: { readOnly: true } }])
  assert.throws(() => new Driver(path.join(os.tmpdir(), `missing-doctor-${process.pid}-${Date.now()}`, 'app.db'), {
    readonly: true, fileMustExist: true,
  }), { code: 'ENOENT' })
  assert.equal(calls.length, 1)
})

let native = null
try { native = await import('node:sqlite') } catch { /* Optional on Node 20. */ }

test('Node SQLite shared readonly opens existing files without allowing writes', { skip: !native }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-sqlite-readonly-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const Driver = createNodeSqliteDatabase(native.DatabaseSync)
  const filename = path.join(directory, 'fixture.db')
  const writer = new Driver(filename)
  writer.exec('CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(1)')
  writer.close()
  const reader = new Driver(filename, { readonly: true, fileMustExist: true })
  try {
    assert.equal(reader.prepare('SELECT value FROM fixture').get().value, 1)
    assert.throws(() => reader.exec('INSERT INTO fixture VALUES(2)'), /readonly|read-only/iu)
  } finally { reader.close() }
})

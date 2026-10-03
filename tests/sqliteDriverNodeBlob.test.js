import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createNodeSqliteDatabase } from '../server/adapters/sqliteDriver.js'
import { deserializeMemoryVector, serializeMemoryVector } from '../server/services/memoryEmbeddingService.js'

function fakeDriver(row) {
  const runResult = { changes: 1, lastInsertRowid: 9007199254740993n }
  class FakeDatabaseSync {
    prepare() {
      return {
        get: () => row,
        all: () => [row],
        iterate: function* iterate() { yield row },
        run: () => runResult,
      }
    }
    close() {}
  }
  const Driver = createNodeSqliteDatabase(FakeDatabaseSync)
  return { db: new Driver(':memory:'), runResult }
}

test('node wrapper normalizes BLOB cells in get, all and iterate with exact view boundaries', () => {
  const backing = Uint8Array.from([0xde, 0xad, 1, 2, 3, 0xbe, 0xef])
  const row = Object.assign(Object.create(null), { bytes: backing.subarray(2, 5) })
  const { db } = fakeDriver(row)
  const statement = db.prepare('fixture')
  for (const result of [statement.get(), ...statement.all(), ...statement.iterate()]) {
    assert.equal(Buffer.isBuffer(result.bytes), true)
    assert.deepEqual([...result.bytes], [1, 2, 3])
    assert.equal(result.bytes.byteLength, 3)
    assert.equal(Object.getPrototypeOf(result), Object.prototype)
  }
  assert.equal(Buffer.isBuffer(row.bytes), false, 'the driver-owned row must remain unchanged')
  db.close()
})

test('node wrapper uses the same BLOB contract for pragma rows and simple values', () => {
  const { db } = fakeDriver({ value: Uint8Array.from([4, 5]) })
  assert.equal(Buffer.isBuffer(db.pragma('fixture')[0].value), true)
  assert.equal(Buffer.isBuffer(db.pragma('fixture', { simple: true })), true)
  assert.deepEqual([...db.pragma('fixture', { simple: true })], [4, 5])
  db.close()
})

test('node wrapper leaves non-BLOB values and run metadata untouched', () => {
  const bytes = Buffer.from([6, 7])
  const nested = { untouched: true }
  const otherView = new Int16Array([3, 5])
  const { db, runResult } = fakeDriver({ bytes, number: 7, big: 9007199254740993n, string: 'value', empty: null, nested, otherView })
  const result = db.prepare('fixture').get()
  assert.equal(result.bytes, bytes)
  assert.equal(result.number, 7)
  assert.equal(result.big, 9007199254740993n)
  assert.equal(result.string, 'value')
  assert.equal(result.empty, null)
  assert.equal(result.nested, nested)
  assert.equal(result.otherView, otherView)
  assert.equal(db.prepare('fixture').run(), runResult)
  db.close()
})

test('node wrapper preserves absent rows and empty BLOB values', () => {
  const missing = fakeDriver(undefined)
  assert.equal(missing.db.prepare('fixture').get(), undefined)
  const empty = fakeDriver({ value: new Uint8Array(0) })
  assert.equal(Buffer.isBuffer(empty.db.prepare('fixture').get().value), true)
  assert.equal(empty.db.prepare('fixture').get().value.byteLength, 0)
  missing.db.close()
  empty.db.close()
})

const drivers = [['better-sqlite3', Database]]
try {
  const { DatabaseSync } = await import('node:sqlite')
  drivers.push(['node:sqlite', createNodeSqliteDatabase(DatabaseSync)])
} catch { /* Node 20 has no optional built-in SQLite implementation. */ }

for (const [label, Driver] of drivers) {
  test(`${label}: actual BLOB roundtrip remains usable by existing vector consumers`, () => {
    const db = new Driver(':memory:')
    try {
      db.exec('CREATE TABLE fixture(vector BLOB, label TEXT, nullable_value TEXT)')
      db.prepare('INSERT INTO fixture(vector,label,nullable_value) VALUES(?,?,?)')
        .run(serializeMemoryVector([1, 0, -0.5]), 'retained', null)
      const statement = db.prepare('SELECT * FROM fixture')
      for (const row of [statement.get(), ...statement.all(), ...statement.iterate()]) {
        assert.equal(Buffer.isBuffer(row.vector), true)
        assert.deepEqual(deserializeMemoryVector(row.vector, 3), [1, 0, -0.5])
        assert.equal(row.label, 'retained')
        assert.equal(row.nullable_value, null)
      }
    } finally { db.close() }
  })
}

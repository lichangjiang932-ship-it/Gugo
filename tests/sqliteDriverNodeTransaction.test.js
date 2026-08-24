import test from 'node:test'
import assert from 'node:assert/strict'
import { createNodeSqliteDatabase } from '../server/adapters/sqliteDriver.js'

class FakeDatabaseSync {
  prepare() {
    return {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
      iterate: function* iterate() {},
    }
  }

  exec() {}
  close() {}
}

test('node sqlite wrapper exposes caller-owned transaction state', () => {
  const Database = createNodeSqliteDatabase(FakeDatabaseSync)
  const db = new Database(':memory:')

  assert.equal(db.inTransaction, false)
  db.transaction(() => {
    assert.equal(db.inTransaction, true)
    db.transaction(() => assert.equal(db.inTransaction, true))()
    assert.equal(db.inTransaction, true)
  })()
  assert.equal(db.inTransaction, false)
})

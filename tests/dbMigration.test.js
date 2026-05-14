import assert from 'node:assert/strict'
import test from 'node:test'

import { getDb, migrateFromJson } from '../server/db.js'

function cleanDb() {
  const db = getDb()
  for (const table of ['ledger', 'sessions', 'login_codes', 'users', 'rate_limits']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
}

test.beforeEach(() => {
  cleanDb()
})

test.after(() => {
  cleanDb()
})

test('legacy JSON migration is idempotent for ledger rows', () => {
  const store = {
    users: {
      user_1: {
        id: 'user_1',
        email: 'legacy@example.com',
        credits: 100,
        createdAt: 1700000000000,
      },
    },
    sessions: {},
    ledger: [
      {
        id: 'legacy-ledger-1',
        userId: 'user_1',
        type: 'recharge',
        packageId: 'local-10',
        credits: 100,
        balance: 100,
        createdAt: 1700000001000,
      },
    ],
  }

  migrateFromJson(store)
  assert.doesNotThrow(() => migrateFromJson(store))

  const rows = getDb().prepare('SELECT * FROM ledger WHERE id = ?').all('legacy-ledger-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].balance, 100)
})

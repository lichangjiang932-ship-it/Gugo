import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SQLITE_SESSION_CATALOG_FINGERPRINT_STRATEGY } from '../server/core/sessionAdminPort.js'
import { describeSessionCatalogSource } from '../server/services/sessionCatalogSource.js'

const SQLITE_SOURCE_PORT = Object.freeze({
  catalogSource: Object.freeze({
    backendType: 'sqlite',
    fingerprintStrategy: SQLITE_SESSION_CATALOG_FINGERPRINT_STRATEGY,
  }),
})

test('catalog source identity follows the database while workspace aliases normalize', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-source-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  try {
    const database = path.join(root, 'data', 'app.db')
    const first = describeSessionCatalogSource({
      cwd: workspace,
      env: { APP_DB_PATH: database, WORKSPACE_ROOT: `${workspace}${path.sep}.` },
      sessionAdmin: SQLITE_SOURCE_PORT,
    })
    const sameDatabase = describeSessionCatalogSource({
      cwd: root,
      env: { APP_DB_PATH: database, WORKSPACE_ROOT: workspace },
      sessionAdmin: SQLITE_SOURCE_PORT,
    })
    const otherDatabase = describeSessionCatalogSource({
      cwd: workspace,
      env: { APP_DB_PATH: path.join(root, 'other', 'app.db') },
      sessionAdmin: SQLITE_SOURCE_PORT,
    })

    assert.deepEqual(first, sameDatabase)
    assert.equal(first.version, 1)
    assert.match(first.backendInstanceId, /^sqlite:[a-f0-9]{24}$/)
    assert.match(first.workspaceScope.key, /^workspace:[a-f0-9]{24}$/)
    const expectedWorkspace = typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(workspace)
      : fs.realpathSync(workspace)
    assert.equal(first.workspaceScope.path, expectedWorkspace)
    assert.notEqual(first.backendInstanceId, otherDatabase.backendInstanceId)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('catalog identity does not expose the database path', () => {
  const source = describeSessionCatalogSource({
    cwd: process.cwd(),
    env: { APP_DB_PATH: path.join(process.cwd(), 'private-data', 'secret-name.db') },
    sessionAdmin: SQLITE_SOURCE_PORT,
  })
  assert.doesNotMatch(JSON.stringify(source), /private-data|secret-name/)
})

test('custom backend identity uses only its declared opaque fingerprint', () => {
  const fingerprint = 'ab'.repeat(32)
  const source = describeSessionCatalogSource({
    cwd: process.cwd(),
    env: {},
    sessionAdmin: {
      catalogSource: { backendType: 'remote-store', instanceFingerprint: fingerprint },
    },
  })

  assert.equal(source.backendInstanceId, `remote-store:${fingerprint.slice(0, 24)}`)
  assert.doesNotMatch(JSON.stringify(source), new RegExp(fingerprint))
})

test('unknown adapters fail closed instead of inheriting SQLite identity', () => {
  assert.equal(describeSessionCatalogSource({
    cwd: process.cwd(),
    env: { APP_DB_PATH: path.join(process.cwd(), 'must-not-imply-sqlite.db') },
    sessionAdmin: {},
  }), null)
})

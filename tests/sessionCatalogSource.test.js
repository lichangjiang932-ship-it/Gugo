import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { describeSessionCatalogSource } from '../server/services/sessionCatalogSource.js'

test('catalog source identity follows the database while workspace aliases normalize', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-source-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  try {
    const database = path.join(root, 'data', 'app.db')
    const first = describeSessionCatalogSource({
      cwd: workspace,
      env: { APP_DB_PATH: database, WORKSPACE_ROOT: `${workspace}${path.sep}.` },
    })
    const sameDatabase = describeSessionCatalogSource({
      cwd: root,
      env: { APP_DB_PATH: database, WORKSPACE_ROOT: workspace },
    })
    const otherDatabase = describeSessionCatalogSource({
      cwd: workspace,
      env: { APP_DB_PATH: path.join(root, 'other', 'app.db') },
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
  })
  assert.doesNotMatch(JSON.stringify(source), /private-data|secret-name/)
})

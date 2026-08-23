import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

const projectRoot = path.resolve(import.meta.dirname, '..')
const authModuleUrl = pathToFileURL(
  path.join(projectRoot, 'server', 'adapters', 'authAccount.js'),
).href
const dbModuleUrl = pathToFileURL(path.join(projectRoot, 'server', 'db.js')).href

function runBootstrap(dataDir) {
  const script = `
    const { bootstrapAuth } = await import(${JSON.stringify(authModuleUrl)});
    const { closeDb } = await import(${JSON.stringify(dbModuleUrl)});
    bootstrapAuth({ env: { AUTH_MODE: 'local' } });
    closeDb();
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_DATA_DIR: dataDir,
      APP_DB_PATH: path.join(dataDir, 'app.db'),
      NODE_ENV: 'production',
    },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test('legacy account migration retires plaintext JSON and cleans up after an interrupted retirement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-legacy-account-'))
  const storePath = path.join(root, 'app-data.json')
  const markerPath = path.join(root, '.migrated')
  try {
    fs.writeFileSync(storePath, JSON.stringify({
      users: {
        owner: { id: 'owner', email: 'owner@example.com', createdAt: 1_700_000_000_000 },
      },
      sessions: { 'legacy-token': 'owner' },
    }))

    runBootstrap(root)
    assert.equal(fs.existsSync(storePath), false)
    assert.equal(fs.existsSync(markerPath), true)
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.startsWith('.migrated.') && name.endsWith('.tmp')),
      [],
    )
    let db = new Database(path.join(root, 'app.db'), { readonly: true })
    assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get('owner').email, 'owner@example.com')
    assert.equal(db.prepare('SELECT user_id FROM sessions WHERE token = ?').get('legacy-token').user_id, 'owner')
    db.close()

    fs.writeFileSync(storePath, JSON.stringify({
      users: { stale: { id: 'stale', email: 'stale@example.com' } },
      sessions: {},
    }))
    runBootstrap(root)
    assert.equal(fs.existsSync(storePath), false)
    db = new Database(path.join(root, 'app.db'), { readonly: true })
    assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get('stale'), undefined)
    db.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('invalid legacy JSON is preserved for recovery and is never marked migrated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-legacy-account-invalid-'))
  const storePath = path.join(root, 'app-data.json')
  try {
    fs.writeFileSync(storePath, '{ invalid json')
    runBootstrap(root)
    assert.equal(fs.readFileSync(storePath, 'utf8'), '{ invalid json')
    assert.equal(fs.existsSync(path.join(root, '.migrated')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

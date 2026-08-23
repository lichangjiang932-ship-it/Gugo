import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-db-schema-preflight-'))
const originalDataDir = process.env.APP_DATA_DIR
const originalDbPath = process.env.APP_DB_PATH

const {
  DB_SCHEMA_VERSION,
  closeDb,
  getDb,
  getSchemaVersion,
} = await import('../server/db.js')

function selectDatabase(filePath) {
  closeDb()
  process.env.APP_DATA_DIR = path.dirname(filePath)
  process.env.APP_DB_PATH = filePath
}

function seedVersionDatabase(filePath, value, { includeVersion = true } = {}) {
  const db = new Database(filePath)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE preflight_sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO preflight_sentinel (id, value) VALUES ('sentinel', 'preserve-me');
  `)
  if (includeVersion) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(value))
  }
  db.close()
}

function databaseSnapshot(filePath) {
  const db = new Database(filePath, { readonly: true })
  try {
    return {
      pragmas: {
        applicationId: db.pragma('application_id', { simple: true }),
        journalMode: db.pragma('journal_mode', { simple: true }),
        schemaVersion: db.pragma('schema_version', { simple: true }),
        userVersion: db.pragma('user_version', { simple: true }),
      },
      schema: db.prepare(`
        SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all(),
      meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      sentinel: db.prepare('SELECT id, value FROM preflight_sentinel ORDER BY id').all(),
    }
  } finally {
    db.close()
  }
}

function databaseFileSnapshot(filePath) {
  const stat = fs.statSync(filePath, { bigint: true })
  return {
    bytes: fs.readFileSync(filePath),
    mtimeNs: stat.mtimeNs,
    size: stat.size,
    shmExists: fs.existsSync(`${filePath}-shm`),
    walExists: fs.existsSync(`${filePath}-wal`),
  }
}

test.afterEach(() => {
  closeDb()
})

test.after(() => {
  closeDb()
  if (originalDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = originalDataDir
  if (originalDbPath === undefined) delete process.env.APP_DB_PATH
  else process.env.APP_DB_PATH = originalDbPath
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('existing databases fail closed on future or invalid schema versions without mutation', () => {
  const cases = [
    { label: 'future', value: DB_SCHEMA_VERSION + 1, code: 'DB_SCHEMA_VERSION_UNSUPPORTED' },
    { label: 'negative', value: -1, code: 'DB_SCHEMA_VERSION_INVALID' },
    { label: 'fractional', value: 1.5, code: 'DB_SCHEMA_VERSION_INVALID' },
    { label: 'nan', value: 'not-a-version', code: 'DB_SCHEMA_VERSION_INVALID' },
    { label: 'infinity', value: 'Infinity', code: 'DB_SCHEMA_VERSION_INVALID' },
  ]

  for (const entry of cases) {
    const filePath = path.join(tempDir, `${entry.label}.db`)
    seedVersionDatabase(filePath, entry.value)
    const before = databaseSnapshot(filePath)
    const fileBefore = databaseFileSnapshot(filePath)
    selectDatabase(filePath)

    assert.throws(() => getDb(), (error) => error?.code === entry.code)
    assert.throws(() => getDb(), (error) => error?.code === entry.code)
    assert.deepEqual(databaseSnapshot(filePath), before)
    assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
  }
})

test('an existing meta table without schema_version fails closed without mutation', () => {
  const filePath = path.join(tempDir, 'missing-version.db')
  seedVersionDatabase(filePath, null, { includeVersion: false })
  const before = databaseSnapshot(filePath)
  const fileBefore = databaseFileSnapshot(filePath)
  selectDatabase(filePath)

  assert.throws(() => getDb(), (error) => error?.code === 'DB_SCHEMA_VERSION_INVALID')
  assert.deepEqual(databaseSnapshot(filePath), before)
  assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
})

test('a database without meta and a new empty database still initialize normally', () => {
  const noMetaPath = path.join(tempDir, 'no-meta.db')
  const seed = new Database(noMetaPath)
  seed.exec("CREATE TABLE preflight_sentinel (id TEXT PRIMARY KEY); INSERT INTO preflight_sentinel VALUES ('keep')")
  seed.close()

  selectDatabase(noMetaPath)
  const initialized = getDb()
  assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION)
  assert.equal(initialized.prepare("SELECT id FROM preflight_sentinel WHERE id = 'keep'").get().id, 'keep')
  closeDb()

  const emptyPath = path.join(tempDir, 'empty.db')
  selectDatabase(emptyPath)
  const empty = getDb()
  assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION)
  assert.ok(empty.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get())
})

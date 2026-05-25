import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 独立数据库目录，避免和其它测试串扰
const tmpDir = path.join(os.tmpdir(), 'yma-hub-tests', String(process.pid))
process.env.APP_DATA_DIR = tmpDir
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

const { getDb, closeDb } = await import('../server/db.js')
const {
  runHubMigrations,
  enqueueJob,
  claimNextPending,
  markDone,
  markFailed,
  listJobs,
  HUB_SCHEMA_VERSION,
} = await import('../server/hub/hubDb.js')
const { runOnce } = await import('../server/hub/index.js')

function cleanHub() {
  const db = getDb()
  db.prepare('DELETE FROM hub_jobs').run()
}

test.beforeEach(() => {
  runHubMigrations()
  cleanHub()
})

test.after(() => {
  try { cleanHub() } catch { /* ignore */ }
  try { closeDb() } catch { /* ignore */ }
})

test('runHubMigrations 幂等且创建 hub_jobs 表', () => {
  runHubMigrations()
  runHubMigrations() // 第二次不应报错也不应改 schema
  const db = getDb()
  const rows = db.prepare("PRAGMA table_info(hub_jobs)").all()
  const cols = rows.map((r) => r.name).sort()
  assert.deepEqual(
    cols,
    ['created_at', 'id', 'last_error', 'last_run_at', 'name', 'payload', 'status', 'updated_at'].sort()
  )
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'hub_schema_version'").get()
  assert.equal(Number(versionRow.value), HUB_SCHEMA_VERSION)

  // 不能动主 schema 版本
  const mainRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  assert.ok(mainRow, 'main schema_version row must still exist')
})

test('enqueue + claimNextPending + markDone 端到端', () => {
  const job = enqueueJob({ name: 'echo', payload: { text: 'hi' } })
  assert.equal(job.status, 'pending')
  assert.equal(job.name, 'echo')
  assert.deepEqual(job.payload, { text: 'hi' })

  const claimed = claimNextPending()
  assert.equal(claimed.id, job.id)
  assert.equal(claimed.status, 'running')
  assert.ok(claimed.lastRunAt >= job.createdAt)

  const done = markDone(job.id, { lastError: 'echo:hi' })
  assert.equal(done.status, 'done')
  assert.equal(done.lastError, 'echo:hi')

  const failed = markFailed(enqueueJob({ name: 'echo', payload: { text: 'x' } }).id, 'boom')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.lastError, 'boom')

  const all = listJobs({ limit: 10 })
  assert.equal(all.length, 2)
})

test('重复 claim 不会拉到同一条', () => {
  const a = enqueueJob({ name: 'echo', payload: { text: 'a' } })
  const b = enqueueJob({ name: 'echo', payload: { text: 'b' } })

  const first = claimNextPending()
  const second = claimNextPending()
  const third = claimNextPending()

  assert.ok(first && second)
  assert.notEqual(first.id, second.id)
  const ids = new Set([first.id, second.id])
  assert.ok(ids.has(a.id) && ids.has(b.id))
  assert.equal(third, null, 'queue exhausted')
})

test('echo handler 端到端跑通（runOnce）', async () => {
  const job = enqueueJob({ name: 'echo', payload: { text: 'hello' } })
  const ran = await runOnce()
  assert.equal(ran, true)

  const db = getDb()
  const row = db.prepare('SELECT * FROM hub_jobs WHERE id = ?').get(job.id)
  assert.equal(row.status, 'done')
  assert.equal(row.last_error, 'echo:hello')

  // 空队列时 runOnce 返回 false
  const ran2 = await runOnce()
  assert.equal(ran2, false)
})

test('未知 handler 标记 failed', async () => {
  const job = enqueueJob({ name: 'no_such_handler', payload: null })
  await runOnce()
  const db = getDb()
  const row = db.prepare('SELECT * FROM hub_jobs WHERE id = ?').get(job.id)
  assert.equal(row.status, 'failed')
  assert.match(row.last_error, /no handler/)
})

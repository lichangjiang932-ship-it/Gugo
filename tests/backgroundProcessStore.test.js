import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-bg-process-'))
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  APP_DATA_DIR: process.env.APP_DATA_DIR,
  LOCAL_CODE_EXECUTION_ENABLED: process.env.LOCAL_CODE_EXECUTION_ENABLED,
}
process.env.APP_DB_PATH = path.join(workspace, 'bg.db')
process.env.APP_DATA_DIR = path.join(workspace, 'data')
process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'

const { closeDb, getDb } = await import('../server/db.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const {
  listBackgroundProcesses,
  killBackgroundProcess,
  readBackgroundLog,
  startBackgroundProcess,
  _testing,
} = await import('../server/services/backgroundProcessStore.js')

const userId = 'bg-user'
const now = Date.now()
getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
  .run(userId, 'bg@example.com', now, now)
grantLocalPath({ userId, rootPath: workspace, accessMode: 'read_write' })

after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* Windows may briefly retain native handles */ }
})

test('startBackgroundProcess launches a background process and records it', async () => {
  const bgProcess = startBackgroundProcess({
    userId,
    sessionId: 'bg-session',
    turnId: 'bg-turn',
    toolCallId: 'bg-call',
    command: 'echo bg-ok',
    cwd: workspace,
  })
  assert.equal(bgProcess.status, 'running')
  assert.ok(bgProcess.id)
  assert.ok(bgProcess.logPath)
  assert.ok(fs.existsSync(bgProcess.logPath))

  // Wait for the child to write and exit.
  await new Promise((resolve) => setTimeout(resolve, 500))

  const listed = listBackgroundProcesses({ userId })
  assert.ok(listed.some((item) => item.id === bgProcess.id))
  const read = readBackgroundLog({ userId, id: bgProcess.id })
  assert.match(read.log, /bg-ok/)
})

test('killBackgroundProcess marks the record killed', async () => {
  const node = process.execPath
  const bgProcess = startBackgroundProcess({
    userId,
    command: `"${node}" -e "setInterval(() => {}, 1000)"`,
    cwd: workspace,
  })
  const killed = await killBackgroundProcess({ userId, id: bgProcess.id })
  assert.equal(killed.status, 'killed')
  await new Promise((resolve) => setTimeout(resolve, 300))
})

test('background processes are owner-scoped', async () => {
  const otherId = 'bg-other'
  getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
    .run(otherId, 'bg-other@example.com', now, now)
  const bgProcess = startBackgroundProcess({
    userId,
    command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    cwd: workspace,
  })
  assert.equal(await killBackgroundProcess({ userId: otherId, id: bgProcess.id }), null)
  assert.equal(readBackgroundLog({ userId: otherId, id: bgProcess.id }), null)
  await killBackgroundProcess({ userId, id: bgProcess.id })
  await new Promise((resolve) => setTimeout(resolve, 400))
})

test('background process cwd must stay inside a user-authorized writable directory', () => {
  const unauthorized = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-bg-unauthorized-'))
  try {
    assert.throws(
      () => startBackgroundProcess({ userId, command: 'echo denied', cwd: unauthorized }),
      (error) => error?.statusCode === 403 || error?.status === 403,
    )
    assert.equal(
      getDb().prepare('SELECT COUNT(*) AS count FROM background_processes WHERE cwd = ?').get(unauthorized).count,
      0,
    )
  } finally {
    fs.rmSync(unauthorized, { recursive: true, force: true })
  }
})

test('background log sink enforces its physical hard limit', async () => {
  const logPath = path.join(workspace, 'bounded-background.log')
  fs.writeFileSync(logPath, '', { flag: 'wx', mode: 0o600 })
  const sink = _testing.createBoundedLogSink(logPath)
  sink.stream.write(Buffer.alloc(_testing.MAX_LOG_BYTES + 1024 * 1024, 120))
  await sink.close()

  const stat = fs.statSync(logPath)
  const tail = fs.readFileSync(logPath).subarray(-256).toString('utf8')
  assert.ok(stat.size <= _testing.MAX_LOG_BYTES)
  assert.match(tail, /Gugo background log truncated/)
})

test('a quoted executable path runs successfully through the Windows background shell', async () => {
  const bgProcess = startBackgroundProcess({
    userId,
    command: `"${process.execPath}" -e "console.log('quoted-background-ok')"`,
    cwd: workspace,
  })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const current = listBackgroundProcesses({ userId }).find((item) => item.id === bgProcess.id)
    if (current?.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  const read = readBackgroundLog({ userId, id: bgProcess.id })
  assert.match(read.log, /quoted-background-ok/)
})

test('an untracked running record becomes orphaned and kill never reports a false success', async () => {
  const id = 'background-from-previous-runtime'
  const createdAt = Date.now()
  getDb().prepare(`
    INSERT INTO background_processes
      (id, user_id, command, cwd, pid, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(id, userId, 'unknown old process', workspace, process.pid, createdAt, createdAt)

  const listed = listBackgroundProcesses({ userId }).find((item) => item.id === id)
  assert.equal(listed.status, 'orphaned')
  const killed = await killBackgroundProcess({ userId, id })
  assert.equal(killed.status, 'orphaned')
  assert.equal(
    getDb().prepare('SELECT status FROM background_processes WHERE id = ?').get(id).status,
    'orphaned',
  )
})

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-bg-process-'))
const savedEnv = { APP_DB_PATH: process.env.APP_DB_PATH, APP_DATA_DIR: process.env.APP_DATA_DIR }
process.env.APP_DB_PATH = path.join(workspace, 'bg.db')
process.env.APP_DATA_DIR = path.join(workspace, 'data')

const { closeDb, getDb } = await import('../server/db.js')
const {
  listBackgroundProcesses,
  killBackgroundProcess,
  readBackgroundLog,
  startBackgroundProcess,
} = await import('../server/services/backgroundProcessStore.js')

const userId = 'bg-user'
const now = Date.now()
getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
  .run(userId, 'bg@example.com', now, now)

after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* Windows may briefly retain native handles */ }
})

test('startBackgroundProcess launches a detached process and records it', async () => {
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
  const killed = killBackgroundProcess({ userId, id: bgProcess.id })
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
  assert.equal(killBackgroundProcess({ userId: otherId, id: bgProcess.id }), null)
  assert.equal(readBackgroundLog({ userId: otherId, id: bgProcess.id }), null)
  killBackgroundProcess({ userId, id: bgProcess.id })
  await new Promise((resolve) => setTimeout(resolve, 400))
})

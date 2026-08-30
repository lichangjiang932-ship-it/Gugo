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
const { _testing: processGroupTesting } = await import('../server/utils/processGroup.js')
const {
  listBackgroundProcesses,
  killBackgroundProcess,
  readBackgroundLog,
  startBackgroundProcess,
  _testing,
} = await import('../server/services/backgroundProcessStore.js')

const userId = 'bg-user'
const now = Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (processExists(pid) && Date.now() < deadline) await sleep(25)
  return !processExists(pid)
}

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

test('killBackgroundProcess marks the record killed and the terminal state stays stable', async (t) => {
  const node = process.execPath
  const bgProcess = startBackgroundProcess({
    userId,
    command: `"${node}" -e "setInterval(() => {}, 1000)"`,
    cwd: workspace,
  })
  t.after(async () => {
    try { await killBackgroundProcess({ userId, id: bgProcess.id }) } catch { /* best-effort cleanup */ }
  })
  const killed = await killBackgroundProcess({ userId, id: bgProcess.id })
  assert.equal(killed.status, 'killed')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(
    getDb().prepare('SELECT status FROM background_processes WHERE id = ?').get(bgProcess.id).status,
    'killed',
    'late close/error events must not overwrite the kill-owned terminal state',
  )
})

test('killBackgroundProcess removes the real grandchild tree before releasing its cwd', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async (t) => {
  const fixture = fs.mkdtempSync(path.join(workspace, 'real-grandchild-'))
  const childScript = path.join(fixture, 'child.cjs')
  const rootScript = path.join(fixture, 'root.cjs')
  const identityPath = path.join(fixture, 'tree.json')
  const identities = []
  let bgProcess = null
  let removed = false
  t.after(async () => {
    if (bgProcess) {
      try { await killBackgroundProcess({ userId, id: bgProcess.id }) } catch { /* best-effort cleanup */ }
    }
    for (const pid of identities.reverse()) {
      if (!processExists(pid)) continue
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
    }
    if (!removed) {
      try {
        fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      } catch { /* assertion below preserves the primary failure */ }
    }
  })

  fs.writeFileSync(childScript, [
    "const fs = require('node:fs')",
    "const { spawn } = require('node:child_process')",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: __dirname, stdio: 'ignore', windowsHide: true })",
    "fs.writeFileSync(process.argv[2], JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }))",
    'setInterval(() => {}, 1000)',
  ].join(';'), 'utf8')
  fs.writeFileSync(rootScript, [
    "const { spawn } = require('node:child_process')",
    `spawn(process.execPath, [${JSON.stringify(childScript)}, ${JSON.stringify(identityPath)}], { cwd: __dirname, stdio: 'ignore', windowsHide: true })`,
    'setInterval(() => {}, 1000)',
  ].join(';'), 'utf8')

  bgProcess = startBackgroundProcess({
    userId,
    command: `"${process.execPath}" "${rootScript}"`,
    cwd: fixture,
  })
  const readyDeadline = Date.now() + 5_000
  while (!fs.existsSync(identityPath) && Date.now() < readyDeadline) await sleep(25)
  assert.equal(fs.existsSync(identityPath), true, 'the real grandchild PID must be observable')
  const recorded = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
  identities.push(recorded.childPid, recorded.grandchildPid)
  assert.equal(identities.every(processExists), true, 'child and grandchild must be alive before kill')

  const killed = await killBackgroundProcess({ userId, id: bgProcess.id })
  assert.equal(killed.status, 'killed')
  assert.deepEqual(
    await Promise.all(identities.map((pid) => waitForProcessExit(pid))),
    [true, true],
    'kill must not report success while a descendant is still alive',
  )
  assert.doesNotThrow(() => {
    fs.rmSync(fixture, { recursive: true, force: false })
    removed = true
  }, 'kill must not return before the process tree releases its working directory')
})

test('unconfirmed process-tree cleanup remains running and can be retried', async (t) => {
  const bgProcess = startBackgroundProcess({
    userId,
    command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    cwd: workspace,
  })
  t.after(async () => {
    try { await killBackgroundProcess({ userId, id: bgProcess.id }) } catch { /* best-effort cleanup */ }
  })

  await assert.rejects(
    killBackgroundProcess(
      { userId, id: bgProcess.id },
      { terminateProcessTreeFn: async () => false },
    ),
    (error) => error?.code === 'PROCESS_TREE_CLEANUP_UNCONFIRMED' && error?.retryable === true,
  )
  assert.equal(
    getDb().prepare('SELECT status FROM background_processes WHERE id = ?').get(bgProcess.id).status,
    'running',
    'unproven cleanup must continue blocking destructive user-data cleanup',
  )

  let retried
  try {
    retried = await killBackgroundProcess({ userId, id: bgProcess.id })
  } catch (error) {
    assert.fail(
      `${error?.message || String(error)}; processGroup=${JSON.stringify(processGroupTesting.getWindowsTreeKillWorkerSnapshot())}`,
    )
  }
  assert.equal(retried.status, 'killed')
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
  try {
    await killBackgroundProcess({ userId, id: bgProcess.id })
  } catch (error) {
    assert.fail(
      `${error?.message || String(error)}; processGroup=${JSON.stringify(processGroupTesting.getWindowsTreeKillWorkerSnapshot())}`,
    )
  }
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

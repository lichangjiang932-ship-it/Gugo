import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

import {
  _testing,
  closeAllShellSessions,
  closeShellSession,
  runShellSessionCommand,
} from '../server/services/shellSessionStore.js'

const posixOnly = { skip: process.platform === 'win32' }
const windowsOnly = { skip: process.platform !== 'win32' }
let workspace

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitUntil(predicate, {
  timeoutMs = 8_000,
  intervalMs = 25,
  description = 'condition',
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(intervalMs)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function terminateProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
}

function windowsBackgroundNodeCommand(pidPath) {
  const source = [
    "const fs = require('node:fs')",
    'fs.writeFileSync(process.argv[1], String(process.pid))',
    'setInterval(() => {}, 1_000)',
  ].join(';')
  const encodedSource = Buffer.from(source, 'utf8').toString('base64')
  return [
    'start "" /b',
    `"${process.execPath}"`,
    `-e "eval(Buffer.from('${encodedSource}','base64').toString('utf8'))"`,
    `"${pidPath}"`,
  ].join(' ')
}

function readPid(pidPath) {
  return Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10)
}

async function removeWorkspace() {
  try {
    await fs.promises.rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  } catch { /* best-effort test cleanup */ }
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-shell-lifecycle-'))
})

beforeEach(async () => {
  await closeAllShellSessions()
})

after(async () => {
  await closeAllShellSessions()
  await removeWorkspace()
})

test('POSIX shell never removes a caller-owned fullOutputPath', posixOnly, async () => {
  const fullOutputPath = path.join(workspace, 'caller-owned-shell-output.log')
  const original = 'CALLER_OWNED_SENTINEL\n'
  fs.writeFileSync(fullOutputPath, original, 'utf8')

  const result = await runShellSessionCommand({
    userId: 'caller-owned-log-user',
    rootPath: workspace,
    cwd: workspace,
    command: "printf 'command-output-that-will-be-truncated\\n'",
    maxBuffer: 8,
    fullOutputPath,
  })

  assert.equal(result.code, 0, JSON.stringify(result))
  assert.equal(result.truncated, true, JSON.stringify(result))
  assert.equal(fs.readFileSync(fullOutputPath, 'utf8'), original)
  assert.equal(Object.hasOwn(result, 'fullOutputPath'), false)
})

test('POSIX idle close retains a same-key tombstone until the old shell exits', posixOnly, async (t) => {
  const userId = 'idle-tombstone-user'
  const first = await runShellSessionCommand({
    userId,
    rootPath: workspace,
    cwd: workspace,
    command: "trap '' TERM; printf 'armed\\n'",
    idleTimeoutMs: 40,
  })
  assert.equal(first.code, 0, JSON.stringify(first))

  const oldPid = _testing.getSessionSnapshot()[0]?.pid
  assert.ok(Number.isInteger(oldPid) && oldPid > 0)
  t.after(() => {
    try { process.kill(-oldPid, 'SIGKILL') } catch { /* already exited */ }
  })

  await delay(150)
  assert.equal(_testing.getSessionCount(), 1, 'closing record must remain addressable')
  await assert.rejects(
    runShellSessionCommand({
      userId,
      rootPath: workspace,
      cwd: workspace,
      command: "printf 'must-not-run\\n'",
    }),
    (error) => error?.code === 'SHELL_SESSION_CLOSED',
  )

  process.kill(-oldPid, 'SIGKILL')
  await waitUntil(() => _testing.getSessionCount() === 0, {
    timeoutMs: 2_000,
    description: 'old idle shell tombstone removal',
  })

  const replacement = await runShellSessionCommand({
    userId,
    rootPath: workspace,
    cwd: workspace,
    command: "printf 'replacement\\n'",
  })
  assert.equal(replacement.code, 0, JSON.stringify(replacement))
  assert.match(replacement.stdout, /replacement/u)
})

test('Windows close waits until an active command background descendant is dead', windowsOnly, async (t) => {
  const userId = 'close-background-descendant-user'
  const pidPath = path.join(workspace, 'close-background-descendant.pid')
  let backgroundPid = null
  t.after(() => terminateProcess(backgroundPid))

  const pending = runShellSessionCommand({
    userId,
    rootPath: workspace,
    cwd: workspace,
    command: [
      windowsBackgroundNodeCommand(pidPath),
      'node -e "setTimeout(() => {}, 30000)"',
    ].join('\r\n'),
    timeout: 40_000,
  })

  await waitUntil(() => fs.existsSync(pidPath), {
    description: 'active-command background descendant PID',
  })
  backgroundPid = readPid(pidPath)
  assert.equal(processIsAlive(backgroundPid), true)

  const closing = closeShellSession({ userId, rootPath: workspace })
  await assert.rejects(pending, (error) => error?.code === 'SHELL_SESSION_CLOSED')
  assert.equal(await closing, true)
  assert.equal(
    processIsAlive(backgroundPid),
    false,
    `close returned while background descendant ${backgroundPid} was still alive`,
  )
})

test('Windows normal command completion leaves no background descendant', windowsOnly, async (t) => {
  const pidPath = path.join(workspace, 'normal-background-descendant.pid')
  let backgroundPid = null
  t.after(() => terminateProcess(backgroundPid))

  const result = await runShellSessionCommand({
    userId: 'normal-background-descendant-user',
    rootPath: workspace,
    cwd: workspace,
    command: [
      windowsBackgroundNodeCommand(pidPath),
      'node -e "setTimeout(() => {}, 500)"',
    ].join('\r\n'),
    timeout: 20_000,
  })

  assert.equal(fs.existsSync(pidPath), true, 'background descendant did not start')
  backgroundPid = readPid(pidPath)
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.equal(
    processIsAlive(backgroundPid),
    false,
    `normal completion returned while background descendant ${backgroundPid} was still alive`,
  )
})

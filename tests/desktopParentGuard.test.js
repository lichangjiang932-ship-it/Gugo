import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  bindDesktopParentGuard,
  DESKTOP_PARENT_GUARD_MODE,
} from '../server/services/desktopParentGuard.js'

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

function createProcessTarget({ connected = true } = {}) {
  const target = new EventEmitter()
  target.connected = connected
  target.channel = { unref() {} }
  return target
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('desktop parent guard requests shutdown exactly once on IPC disconnect', async () => {
  const processTarget = createProcessTarget()
  const reasons = []
  const exits = []
  const guard = bindDesktopParentGuard({
    mode: DESKTOP_PARENT_GUARD_MODE,
    processTarget,
    requestShutdown: async (reason) => {
      reasons.push(reason)
      return 0
    },
    exitProcess: (code) => exits.push(code),
  })

  assert.equal(guard.active, true)
  processTarget.emit('disconnect')
  processTarget.emit('disconnect')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(reasons, ['desktop_parent_disconnected'])
  assert.deepEqual(exits, [0])
  assert.equal(guard.dispose(), false)
})

test('desktop parent guard closes the pre-listener parent-exit race', async () => {
  const processTarget = createProcessTarget({ connected: false })
  const reasons = []
  const exits = []
  bindDesktopParentGuard({
    mode: DESKTOP_PARENT_GUARD_MODE,
    processTarget,
    requestShutdown: async (reason) => {
      reasons.push(reason)
      return 0
    },
    exitProcess: (code) => exits.push(code),
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(reasons, ['desktop_parent_disconnected'])
  assert.deepEqual(exits, [0])
})

test('desktop parent guard forces a failed exit when graceful shutdown stalls', async () => {
  const processTarget = createProcessTarget()
  const exits = []
  bindDesktopParentGuard({
    mode: DESKTOP_PARENT_GUARD_MODE,
    processTarget,
    requestShutdown: () => new Promise(() => {}),
    exitProcess: (code) => exits.push(code),
    timeoutMs: 20,
  })

  processTarget.emit('disconnect')
  assert.equal(await waitFor(() => exits.length === 1), true)
  assert.deepEqual(exits, [1])
})

test('parent guard stays inert for a standalone server without desktop mode', async () => {
  const processTarget = createProcessTarget({ connected: false })
  let shutdowns = 0
  const guard = bindDesktopParentGuard({
    mode: undefined,
    processTarget,
    requestShutdown: async () => { shutdowns += 1 },
  })

  processTarget.emit('disconnect')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(guard.active, false)
  assert.equal(shutdowns, 0)
})

function createRealParentGuardFixture(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-desktop-parent-'))
  const markerPath = path.join(tempDir, 'shutdown.json')
  const backendPath = path.join(tempDir, 'backend.mjs')
  const ownerPath = path.join(tempDir, 'owner.mjs')
  const guardUrl = pathToFileURL(
    path.resolve('server/services/desktopParentGuard.js'),
  ).href
  let owner = null
  let backendPid = null

  t.after(async () => {
    if (owner?.exitCode === null && owner?.signalCode === null) {
      owner.kill('SIGKILL')
      await waitFor(() => owner.exitCode !== null || owner.signalCode !== null, 2_000)
    }
    if (backendPid && isProcessAlive(backendPid)) {
      try { process.kill(backendPid, 'SIGKILL') } catch { /* already reaped */ }
      await waitFor(() => !isProcessAlive(backendPid), 2_000)
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  fs.writeFileSync(backendPath, `
import fs from 'node:fs'
import { bindDesktopParentGuard, DESKTOP_PARENT_GUARD_MODE } from ${JSON.stringify(guardUrl)}
bindDesktopParentGuard({
  mode: DESKTOP_PARENT_GUARD_MODE,
  requestShutdown: async (reason) => {
    fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ reason, pid: process.pid }))
    return 0
  },
})
process.stdout.write('ready\\n')
`, 'utf8')

  fs.writeFileSync(ownerPath, `
import { spawn } from 'node:child_process'
const backend = spawn(process.execPath, [${JSON.stringify(backendPath)}], {
  stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
  windowsHide: true,
})
backend.stdout.once('data', () => {
  process.stdout.write(String(backend.pid) + '\\n')
})
process.stdin.once('data', (command) => {
  if (String(command).trim() === 'disconnect') backend.disconnect()
})
process.stdin.resume()
`, 'utf8')

  return {
    markerPath,
    async start() {
      owner = spawn(process.execPath, [ownerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let output = ''
      let errors = ''
      owner.stdout.on('data', (chunk) => { output += String(chunk) })
      owner.stderr.on('data', (chunk) => { errors += String(chunk) })
      assert.equal(await waitFor(() => (
        output.includes('\n') || owner.exitCode !== null || owner.signalCode !== null
      )), true)
      assert.equal(owner.exitCode, null, errors)
      assert.equal(owner.signalCode, null, errors)
      backendPid = Number.parseInt(output.trim(), 10)
      assert.equal(Number.isSafeInteger(backendPid) && backendPid > 0, true, output)
      return { owner, backendPid }
    },
  }
}

function readShutdownMarker(markerPath, backendPid) {
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), {
    reason: 'desktop_parent_disconnected',
    pid: backendPid,
  })
}

test('a real Node IPC disconnect gracefully reaps the backend', async (t) => {
  const fixture = createRealParentGuardFixture(t)
  const { owner, backendPid } = await fixture.start()

  owner.stdin.end('disconnect')
  assert.equal(await waitFor(() => fs.existsSync(fixture.markerPath)), true)
  readShutdownMarker(fixture.markerPath, backendPid)
  assert.equal(await waitFor(() => !isProcessAlive(backendPid)), true)
})

test('forcibly terminating a real owner never leaves its backend orphaned', async (t) => {
  const fixture = createRealParentGuardFixture(t)
  const { owner, backendPid } = await fixture.start()

  const ownerExit = once(owner, 'exit')
  assert.equal(owner.kill('SIGKILL'), true)
  await ownerExit

  assert.equal(await waitFor(() => (
    fs.existsSync(fixture.markerPath) || !isProcessAlive(backendPid)
  )), true)
  if (fs.existsSync(fixture.markerPath)) {
    readShutdownMarker(fixture.markerPath, backendPid)
  }
  assert.equal(await waitFor(() => !isProcessAlive(backendPid)), true)
})

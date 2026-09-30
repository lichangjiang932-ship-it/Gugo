import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * The preview end to end: a real launch.json, a real child server, the real
 * routes. The fixture server is `node` itself running a two-line HTTP server, so
 * the test proves the parts that only a real process can prove — readiness from
 * stdout, the port actually being taken, and the port actually being released.
 */

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-preview-routes-'))
const configDir = path.join(workspace, '.gugo')
fs.mkdirSync(configDir)
fs.writeFileSync(path.join(workspace, 'preview-server.cjs'), [
  "const http = require('node:http')",
  'const port = Number(process.env.PORT)',
  "const server = http.createServer((req, res) => { res.writeHead(200); res.end('preview ok') })",
  "server.listen(port, '127.0.0.1', () => { console.log(`ready on ${port}`) })",
].join('\n'), 'utf8')

const savedEnv = {
  APP_DATA_DIR: process.env.APP_DATA_DIR,
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
}
process.env.APP_DATA_DIR = workspace
process.env.APP_DB_PATH = path.join(workspace, 'preview-test.db')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHELL_ENABLED = '1'

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, setUserToolPermission } = await import('../server/db.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { setWorkspaceTrust } = await import('../server/services/workspaceTrustService.js')
const { readPreviewConfig, writePreviewAutoVerify } = await import('../server/services/previewConfig.js')
const { readPreviewServerState, stopPreviewServer } = await import('../server/services/previewServerStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const { token, userId } = issueTestSession({ email: 'preview-routes@example.com' })

function writeWorkspaceConfig(permissions) {
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ permissions }, null, 2), 'utf8')
}

// The real path: the reader picked this folder as their project, which is a
// read-write directory grant, and the workspace itself is trusted with shell.
writeWorkspaceConfig({ fileSystem: true, fileSystemWrite: true, shell: true })
setWorkspaceTrust({ userId, rootPath: workspace, trusted: true, confirmation: 'TRUST_WORKSPACE_CONFIG' })
grantLocalPath({ userId, rootPath: workspace, accessMode: 'read_write' })

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Hold a port the way this test needs to.
 *
 * Reserving and releasing leaves a window where another file's preview server —
 * these tests run in parallel with each other — can take the port first, so the
 * listen is retried on a fresh one instead of failing the whole file.
 */
async function listenOnFreePort(server, attempts = 5) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await reservePort()
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host: '127.0.0.1', port }, resolve)
      })
      return port
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('no free port')
}

function isBusy(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (error) => resolve(error?.code === 'EADDRINUSE'))
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(false)))
  })
}

async function call(route, { body, method = 'POST' } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  })
  return { status: response.status, body: await response.json() }
}

function writeLaunch(configurations, extra = {}) {
  fs.writeFileSync(path.join(configDir, 'launch.json'), JSON.stringify({
    version: '0.0.1',
    autoVerify: true,
    configurations,
    ...extra,
  }, null, 2), 'utf8')
}

async function waitUntilReady(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = readPreviewServerState({ userId, workspaceRoot: workspace })
    if (state.status === 'ready') return state
    if (['failed', 'exited', 'killed'].includes(state.status)) {
      throw new Error(`preview server died: ${state.status} ${state.error || ''}`)
    }
    await new Promise((resolve) => { setTimeout(resolve, 120) })
  }
  throw new Error('preview server never became ready')
}

test.after(async () => {
  await stopPreviewServer({ userId, workspaceRoot: workspace })
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('the preview routes require a session and an authorized workspace', async () => {
  const anonymous = await fetch(`${origin}/api/preview/state?workspaceRoot=${encodeURIComponent(workspace)}`)
  assert.equal(anonymous.status, 401)

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-preview-outside-'))
  try {
    const denied = await call(`/api/preview/state?workspaceRoot=${encodeURIComponent(outside)}`, { method: 'GET' })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'PATH_NOT_AUTHORIZED')
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }

  const noWorkspace = await call('/api/preview/state', { method: 'GET' })
  assert.equal(noWorkspace.status, 400)
  assert.equal(noWorkspace.body.error.code, 'PREVIEW_WORKSPACE_REQUIRED')
})

test('a workspace without launch.json is offered a setup, not an error', async () => {
  const state = await call(`/api/preview/state?workspaceRoot=${encodeURIComponent(workspace)}`, { method: 'GET' })
  assert.equal(state.status, 200)
  assert.equal(state.body.missing, true)
  assert.deepEqual(state.body.problems, [])
  assert.deepEqual(state.body.configurations, [])
  assert.equal(state.body.autoVerify, true)
  assert.equal(state.body.server.status, 'stopped')
})

test('starting runs the configured command, waits for its readiness line, and stops it', async () => {
  // This configuration declares its port and no autoPort, so a port somebody else
  // took between reserving and listening is retried on a fresh one: the point of
  // the test is what happens after the server starts, not the reservation luck.
  let port = 0
  let started = null
  for (let attempt = 0; attempt < 5 && !started; attempt += 1) {
    port = await reservePort()
    writeLaunch([{ name: 'dev-server', program: 'node', args: ['preview-server.cjs'], port, readyPattern: 'ready on' }])
    const attemptStart = await call('/api/preview/start', { body: { workspaceRoot: workspace } })
    if (attemptStart.status === 200) started = attemptStart
    else if (attemptStart.body?.error?.code !== 'PREVIEW_PORT_BUSY') {
      throw new Error(`start refused: ${JSON.stringify(attemptStart.body)}`)
    }
  }
  assert.ok(started, 'a free port was found')

  const state = await call(`/api/preview/state?workspaceRoot=${encodeURIComponent(workspace)}`, { method: 'GET' })
  assert.deepEqual(state.body.configurations, [{
    name: 'dev-server',
    command: 'node preview-server.cjs',
    port,
    url: `http://localhost:${port}`,
    autoPort: false,
  }])

  assert.equal(started.status, 200)
  assert.equal(started.body.server.status, 'starting')
  assert.equal(started.body.server.port, port)
  assert.ok(started.body.server.pid > 0)

  const ready = await waitUntilReady()
  assert.equal(ready.url, `http://localhost:${port}`)
  assert.equal(await isBusy(port), true, 'the configured port is the one the server took')

  // The port really serves, not just "a process is alive".
  const served = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(await served.text(), 'preview ok')

  const reloaded = await call(`/api/preview/state?workspaceRoot=${encodeURIComponent(workspace)}`, { method: 'GET' })
  assert.equal(reloaded.body.server.status, 'ready')
  assert.match(reloaded.body.log, /ready on/)

  // Starting again reuses the running server instead of racing a second one.
  const again = await call('/api/preview/start', { body: { workspaceRoot: workspace } })
  assert.equal(again.body.reused, true)
  assert.equal(again.body.server.pid, started.body.server.pid)

  const stopped = await call('/api/preview/stop', { body: { workspaceRoot: workspace } })
  assert.equal(stopped.body.server.status, 'stopped')
  // The port is free again: stopping is a real tree kill, not a forgotten handle.
  const deadline = Date.now() + 5_000
  while (await isBusy(port) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
  assert.equal(await isBusy(port), false)
})

test('a busy port is moved only when the config allows it', async () => {
  const blocker = net.createServer()
  const port = await listenOnFreePort(blocker)
  try {
    // autoPort unset: the spec asks the reader rather than guessing.
    writeLaunch([{ name: 'ask', program: 'node', args: ['preview-server.cjs'], port }])
    const asked = await call('/api/preview/start', { body: { workspaceRoot: workspace } })
    assert.equal(asked.status, 400)
    assert.equal(asked.body.error.code, 'PREVIEW_PORT_BUSY')
    assert.match(asked.body.error.message, /autoPort/)

    // autoPort: false reports the conflict.
    writeLaunch([{ name: 'strict', program: 'node', args: ['preview-server.cjs'], port, autoPort: false }])
    const strict = await call('/api/preview/start', { body: { workspaceRoot: workspace } })
    assert.equal(strict.body.error.code, 'PREVIEW_PORT_BUSY')
    assert.match(strict.body.error.message, /直接报错/)

    // autoPort: true finds the next free port.
    writeLaunch([{ name: 'flexible', program: 'node', args: ['preview-server.cjs'], port, autoPort: true }])
    const flexible = await call('/api/preview/start', { body: { workspaceRoot: workspace } })
    assert.equal(flexible.body.server.movedPort, true)
    assert.ok(flexible.body.server.port > port)
    await waitUntilReady()
    assert.equal(await isBusy(flexible.body.server.port), true)
    await call('/api/preview/stop', { body: { workspaceRoot: workspace } })
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('the autoVerify switch is the one field the app writes, and it persists', async () => {
  const before = readPreviewConfig({ workspaceRoot: workspace })
  assert.equal(before.config.autoVerify, true)

  const written = await call('/api/preview/auto-verify', { body: { workspaceRoot: workspace, autoVerify: false } })
  assert.equal(written.status, 200)
  assert.equal(written.body.autoVerify, false)
  assert.equal(readPreviewConfig({ workspaceRoot: workspace }).config.autoVerify, false)

  // Everything else in the file is the reader's, so it is still there.
  const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'launch.json'), 'utf8'))
  assert.equal(raw.version, '0.0.1')
  assert.equal(raw.configurations[0].name, 'flexible')
  writePreviewAutoVerify({ workspaceRoot: workspace, autoVerify: true })
})

test('the two real switches turn starting a command off', async () => {
  const port = await reservePort()
  writeLaunch([{ name: 'dev-server', program: 'node', args: ['preview-server.cjs'], port }])
  // Whether anything started is the store's answer, not a port probe: these files
  // run in parallel, and a busy port could just as well be someone else's server.
  const nothingStarted = () => readPreviewServerState({ userId, workspaceRoot: workspace }).status === 'stopped'
  const savedLocalCode = process.env.LOCAL_CODE_EXECUTION_ENABLED
  try {
    // 1. The per-user tool switch, which is also in the permissions UI.
    setUserToolPermission({ userId, toolName: 'preview_start_server', enabled: false })
    const disabled = await call('/api/preview/start', { body: { workspaceRoot: workspace } })
    assert.equal(disabled.status, 403)
    assert.equal(disabled.body.error.code, 'TOOL_DISABLED')
    assert.match(disabled.body.error.message, /preview_start_server/)
    assert.equal(nothingStarted(), true, 'nothing was started')
    setUserToolPermission({ userId, toolName: 'preview_start_server', enabled: true })

    // 2. The server-wide switch for running local code at all.
    process.env.LOCAL_CODE_EXECUTION_ENABLED = '0'
    const blocked = await call('/api/preview/start', { body: { workspaceRoot: workspace } })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.error.code, 'LOCAL_CODE_EXECUTION_DISABLED')
    assert.equal(nothingStarted(), true, 'nothing was started')
    const state = await call(`/api/preview/state?workspaceRoot=${encodeURIComponent(workspace)}`, { method: 'GET' })
    assert.equal(state.body.server.status, 'stopped')
  } finally {
    if (savedLocalCode === undefined) delete process.env.LOCAL_CODE_EXECUTION_ENABLED
    else process.env.LOCAL_CODE_EXECUTION_ENABLED = savedLocalCode
  }
})

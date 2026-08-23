import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  bindAppProcessListeners,
  completeRuntimeStartup,
  createAppServer,
  createRuntimeReadinessController,
  withAppStartupRollback,
} from '../server/appServer.js'
import { createStartupAbortGuard } from '../server/core/startupAbortGuard.js'
import { closeDb } from '../server/db.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  if (!server.listening) return
  await new Promise((resolve) => server.close(resolve))
}

function requestRawPath(server, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: 'GET',
      path: requestPath,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body,
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

function requestUpgrade(server, requestPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(server.address().port, '127.0.0.1')
    let response = ''
    let socketError = null
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`upgrade request did not close: ${requestPath}`))
    }, 2_000)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { response += chunk })
    socket.once('error', (error) => { socketError = error })
    socket.once('close', () => {
      clearTimeout(timeout)
      if (socketError && !response) reject(socketError)
      else resolve(response)
    })
    socket.once('connect', () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      )
    })
  })
}

function testCapability() {
  return {
    id: 'test.runtime.turns',
    owner: 'test',
    priority: 100,
    apiPrefixes: ['/api/turns'],
    match: (req) => req.url?.startsWith('/api/turns'),
    handle: (_req, res) => {
      res.writeHead(204)
      res.end()
    },
  }
}

test('runtime readiness exposes only liveness and static assets until startup completes', async () => {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-readiness-'))
  fs.writeFileSync(
    path.join(staticDir, 'index.html'),
    '<!doctype html><html><body>gugo-starting-shell</body></html>',
  )
  const readiness = createRuntimeReadinessController({ initialState: 'starting' })
  const server = createAppServer({
    getEnv: () => ({
      AUTH_MODE: 'local',
      API_RATE_LIMIT_ANONYMOUS_PER_MINUTE: '1',
      API_RATE_LIMIT_ANONYMOUS_BURST: '1',
    }),
    includeBuiltinHttpCapabilities: false,
    staticDir,
    runtimeReadiness: readiness,
    configureHttpCapabilities: (registry) => registry.register(testCapability()),
  })
  const origin = await listen(server)

  try {
    const health = await fetch(`${origin}/api/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)

    const queriedHealth = await fetch(`${origin}/api/health?source=startup-probe`)
    assert.equal(queriedHealth.status, 200)
    assert.equal((await queriedHealth.json()).ok, true)

    const staticResponse = await fetch(`${origin}/settings/models`)
    assert.equal(staticResponse.status, 200)
    assert.match(await staticResponse.text(), /gugo-starting-shell/)

    for (const pathname of [
      '/api',
      '/api/turns/run',
      '/api/jobs',
      '/api/tools/specs',
      '/api/health/full',
      '/api/auth/local-session',
      '/api/account/profile',
      '/api/model/providers',
      '/api/model/status',
      '/api/model/test',
      '/api/system/runtime-config',
      '/api/system/user-data',
      '/api/system/diagnostics',
      '/api/plugins',
      '/api/audit',
      '/api/unknown-control-plane',
      '/mcp?transport=sse',
    ]) {
      const response = await fetch(`${origin}${pathname}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid-startup-token' },
      })
      assert.equal(response.status, 503, pathname)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('retry-after'), '1')
      assert.deepEqual(await response.json(), {
        ok: false,
        error: {
          code: 'RUNTIME_NOT_READY',
          message: 'Runtime is starting. Try again shortly.',
        },
      })
    }

    const encodedTraversal = await requestRawPath(
      server,
      '/api/turns/%2e%2e/%2e%2e/settings',
    )
    assert.equal(encodedTraversal.status, 503)
    assert.equal(JSON.parse(encodedTraversal.body).error.code, 'RUNTIME_NOT_READY')

    assert.equal(readiness.markReady(), true)
    assert.equal((await fetch(`${origin}/api/turns/run`)).status, 204)
    assert.equal(
      (await fetch(`${origin}/api/turns/run`)).status,
      429,
      'rate limiting must resume after the runtime becomes ready',
    )
  } finally {
    await close(server)
    fs.rmSync(staticDir, { recursive: true, force: true })
  }
})

test('failed runtime startup remains live and fails closed without leaking the startup error', async () => {
  const readiness = createRuntimeReadinessController({ initialState: 'starting' })
  const server = createAppServer({
    getEnv: () => ({ AUTH_MODE: 'local' }),
    includeBuiltinHttpCapabilities: false,
    runtimeReadiness: readiness,
    configureHttpCapabilities: (registry) => registry.register(testCapability()),
  })
  const origin = await listen(server)

  try {
    const startupError = new Error('secret plugin path D:\\private\\broken-plugin.js')
    assert.equal(readiness.markFailed(startupError), true)

    const health = await fetch(`${origin}/api/health`)
    assert.equal(health.status, 200)

    const blocked = await fetch(`${origin}/api/turns/run`)
    assert.equal(blocked.status, 503)
    const text = await blocked.text()
    assert.doesNotMatch(text, /private|broken-plugin|secret/i)
    assert.deepEqual(JSON.parse(text), {
      ok: false,
      error: {
        code: 'RUNTIME_NOT_READY',
        message: 'Runtime startup did not complete. Check local diagnostics and retry.',
      },
    })
    assert.equal(readiness.markReady(), false, 'failed startup must remain fail-closed')
  } finally {
    await close(server)
  }
})

test('startup liveness never initializes or migrates SQLite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-liveness-db-'))
  const dataDir = path.join(root, 'data')
  const dbPath = path.join(root, 'database', 'app.db')
  const previousDataDir = process.env.APP_DATA_DIR
  const previousDbPath = process.env.APP_DB_PATH
  closeDb()
  process.env.APP_DATA_DIR = dataDir
  process.env.APP_DB_PATH = dbPath

  const readiness = createRuntimeReadinessController({ initialState: 'starting' })
  const server = createAppServer({
    getEnv: () => ({ AUTH_MODE: 'local' }),
    includeBuiltinHttpCapabilities: false,
    runtimeReadiness: readiness,
  })
  const origin = await listen(server)

  try {
    assert.equal((await fetch(`${origin}/api/health`)).status, 200)
    assert.equal(readiness.markFailed(new Error('startup failed')), true)
    assert.equal((await fetch(`${origin}/api/health`)).status, 200)
    assert.equal(fs.existsSync(dataDir), false)
    assert.equal(fs.existsSync(dbPath), false)
  } finally {
    await close(server)
    closeDb()
    if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
    else process.env.APP_DATA_DIR = previousDataDir
    if (previousDbPath === undefined) delete process.env.APP_DB_PATH
    else process.env.APP_DB_PATH = previousDbPath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('startup readiness rejects and closes every upgrade with state-specific errors', async () => {
  const readiness = createRuntimeReadinessController({ initialState: 'starting' })
  const server = createAppServer({
    getEnv: () => ({ AUTH_MODE: 'local' }),
    includeBuiltinHttpCapabilities: false,
    runtimeReadiness: readiness,
  })
  await listen(server)

  try {
    const starting = await requestUpgrade(server, '/api/jobs')
    assert.match(starting, /^HTTP\/1\.1 503 Service Unavailable/m)
    assert.match(starting, /Cache-Control: no-store/i)
    assert.match(starting, /Runtime is starting\. Try again shortly\./)

    assert.equal(readiness.markFailed(new Error('startup failed')), true)
    const failedNonRealtime = await requestUpgrade(server, '/mcp')
    assert.match(failedNonRealtime, /^HTTP\/1\.1 503 Service Unavailable/m)
    assert.match(failedNonRealtime, /Runtime startup did not complete\./)

    const failedRealtime = await requestUpgrade(server, '/api/realtime')
    assert.match(failedRealtime, /^HTTP\/1\.1 503 Service Unavailable/m)
    assert.match(failedRealtime, /Runtime startup did not complete\./)
  } finally {
    await close(server)
  }
})

test('fatal startup waits for rollback and preserves the original startup rejection', async () => {
  const startup = deferred()
  const rollback = deferred()
  const expected = new Error('required capability failed')
  const readiness = createRuntimeReadinessController({ initialState: 'starting' })
  const guard = createStartupAbortGuard()
  const server = { id: 'startup-server' }
  const events = []
  let settled = false

  const barrier = withAppStartupRollback(startup.promise, {
    server,
    runtimeReadiness: readiness,
    startupAbortGuard: guard,
    shutdown: async (target) => {
      assert.strictEqual(target, server)
      events.push('rollback:start')
      await rollback.promise
      events.push('rollback:complete')
      return 0
    },
    onFatal: (error) => events.push(`fatal:${error.message}`),
    onRollbackError: (error) => events.push(`rollback:error:${error.message}`),
  })
  barrier.then(
    () => { settled = true },
    () => { settled = true },
  )

  startup.reject(expected)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(guard.isRequested(), true)
  assert.equal(readiness.getState(), 'failed')
  assert.deepEqual(events, [
    'fatal:required capability failed',
    'rollback:start',
  ])

  rollback.resolve()
  await assert.rejects(barrier, (error) => error === expected)
  assert.deepEqual(events, [
    'fatal:required capability failed',
    'rollback:start',
    'rollback:complete',
  ])
})

test('startup rollback failures are reported without replacing the startup error', async () => {
  const expected = new Error('listener failed')
  const rollbackErrors = []
  const readiness = createRuntimeReadinessController({ initialState: 'starting' })
  const guard = createStartupAbortGuard()

  await assert.rejects(withAppStartupRollback(Promise.reject(expected), {
    server: {},
    runtimeReadiness: readiness,
    startupAbortGuard: guard,
    shutdown: async () => 1,
    onFatal: () => {},
    onRollbackError: (error) => rollbackErrors.push(error),
  }), (error) => error === expected)

  assert.equal(rollbackErrors.length, 1)
  assert.equal(rollbackErrors[0].code, 'APP_STARTUP_ROLLBACK_FAILED')
  assert.equal(rollbackErrors[0].exitCode, 1)
})

test('background runtimes are the final readiness condition', async () => {
  const background = deferred()
  const readiness = createRuntimeReadinessController({ initialState: 'starting' })
  const guard = createStartupAbortGuard()
  const events = []
  const expected = Object.freeze({ ready: true })
  const completion = completeRuntimeStartup({
    result: expected,
    startupAbortGuard: guard,
    runtimeReadiness: readiness,
    startBackgroundRuntimes: async () => {
      events.push('background:start')
      await background.promise
      events.push('background:ready')
    },
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readiness.getState(), 'starting')
  assert.deepEqual(events, ['background:start'])

  background.resolve()
  assert.strictEqual(await completion, expected)
  assert.equal(readiness.getState(), 'ready')
  assert.deepEqual(events, ['background:start', 'background:ready'])
})

test('background runtime startup failure keeps readiness closed and enters rollback', async () => {
  const expected = new Error('cron failed to start')
  const readiness = createRuntimeReadinessController({ initialState: 'starting' })
  const guard = createStartupAbortGuard()
  let shutdownCalls = 0
  const completion = completeRuntimeStartup({
    result: {},
    startupAbortGuard: guard,
    runtimeReadiness: readiness,
    startBackgroundRuntimes: async () => { throw expected },
  })
  const startupReady = withAppStartupRollback(completion, {
    server: {},
    runtimeReadiness: readiness,
    startupAbortGuard: guard,
    shutdown: async () => {
      shutdownCalls += 1
      return 0
    },
    onFatal: () => {},
    onRollbackError: () => {},
  })

  await assert.rejects(startupReady, (error) => error === expected)
  assert.equal(readiness.getState(), 'failed')
  assert.equal(shutdownCalls, 1)
})

const APP_PROCESS_EVENTS = Object.freeze([
  'uncaughtException',
  'unhandledRejection',
  'SIGTERM',
  'SIGINT',
])

function processListenerCounts() {
  return Object.fromEntries(APP_PROCESS_EVENTS.map((event) => [
    event,
    process.listenerCount(event),
  ]))
}

function assertProcessListenerDelta(baseline, delta) {
  for (const event of APP_PROCESS_EVENTS) {
    assert.equal(process.listenerCount(event), baseline[event] + delta, event)
  }
}

test('app process listeners are instance-scoped and close cleanup is idempotent', () => {
  const baseline = processListenerCounts()
  const firstServer = new EventEmitter()
  const secondServer = new EventEmitter()
  const neverSettles = new Promise(() => {})
  const releaseFirst = bindAppProcessListeners({
    server: firstServer,
    startupReady: neverSettles,
    startupAbortGuard: createStartupAbortGuard(),
    shutdown: async () => 0,
  })
  const releaseSecond = bindAppProcessListeners({
    server: secondServer,
    startupReady: neverSettles,
    startupAbortGuard: createStartupAbortGuard(),
    shutdown: async () => 0,
  })

  try {
    assertProcessListenerDelta(baseline, 2)
    firstServer.emit('close')
    assertProcessListenerDelta(baseline, 1)
    assert.equal(releaseFirst(), false)
    assert.equal(releaseSecond(), true)
    assertProcessListenerDelta(baseline, 0)
    assert.equal(releaseSecond(), false)
  } finally {
    releaseFirst()
    releaseSecond()
  }
})

test('repeated startup rollback removes every app process listener without accumulation', async () => {
  const baseline = processListenerCounts()

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startup = deferred()
    const expected = new Error(`listener startup failed ${attempt}`)
    const readiness = createRuntimeReadinessController({ initialState: 'starting' })
    const guard = createStartupAbortGuard()
    const server = new EventEmitter()
    const startupReady = withAppStartupRollback(startup.promise, {
      server,
      runtimeReadiness: readiness,
      startupAbortGuard: guard,
      shutdown: async () => 0,
      onFatal: () => {},
      onRollbackError: () => {},
    })
    const release = bindAppProcessListeners({
      server,
      startupReady,
      startupAbortGuard: guard,
      shutdown: async () => 0,
    })

    try {
      assertProcessListenerDelta(baseline, 1)
      startup.reject(expected)
      await assert.rejects(startupReady, (error) => error === expected)
      await new Promise((resolve) => setImmediate(resolve))
      assertProcessListenerDelta(baseline, 0)
      assert.equal(release(), false)
    } finally {
      release()
    }
  }
})

test('createAppServer defaults to ready for embedded callers and direct route tests', async () => {
  const server = createAppServer({
    getEnv: () => ({ AUTH_MODE: 'local' }),
    includeBuiltinHttpCapabilities: false,
    configureHttpCapabilities: (registry) => registry.register(testCapability()),
  })
  const origin = await listen(server)

  try {
    assert.equal((await fetch(`${origin}/api/turns/run`)).status, 204)
  } finally {
    await close(server)
  }
})

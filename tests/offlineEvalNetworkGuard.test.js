import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import {
  OFFLINE_EVAL_NETWORK_ERROR_CODE,
  getOfflineEvalNetworkAttempts,
  installOfflineEvalNetworkGuard,
  resetOfflineEvalNetworkAttempts,
  restoreOfflineEvalNetworkGuard,
} from '../scripts/offlineEvalNetworkGuard.mjs'

function isForbidden(error) {
  return error?.code === OFFLINE_EVAL_NETWORK_ERROR_CODE
    && error?.retryable === false
}

test.beforeEach(() => {
  installOfflineEvalNetworkGuard()
  resetOfflineEvalNetworkAttempts()
})

test.after(() => {
  restoreOfflineEvalNetworkGuard()
})

test('offline eval network guard blocks global fetch and direct undici calls', async () => {
  await assert.rejects(
    globalThis.fetch('https://user:password@example.com/private?token=secret'),
    isForbidden,
  )

  const { Client, WebSocket, fetch: undiciFetch, request } = await import('undici')
  await assert.rejects(undiciFetch('https://example.org/private'), isForbidden)
  await assert.rejects(request('https://example.net/private'), isForbidden)

  const client = new Client('https://example.edu')
  try {
    await assert.rejects(
      Promise.resolve().then(() => client.request({ method: 'GET', path: '/' })),
      isForbidden,
    )
  } finally {
    await client.close()
  }
  assert.throws(() => new WebSocket('wss://example.info/socket'), isForbidden)

  const attempts = getOfflineEvalNetworkAttempts()
  assert.deepEqual(
    attempts.map((entry) => entry.transport),
    ['fetch', 'undici', 'undici', 'undici', 'undici'],
  )
  assert.equal(Object.isFrozen(attempts), true)
  assert.ok(attempts.every((entry) => Object.isFrozen(entry)))
  assert.doesNotMatch(JSON.stringify(attempts), /password|private|secret/)
})

test('offline eval network guard blocks HTTP, HTTPS, TCP, TLS, and UDP entry points', async () => {
  const [http, https, net, tls, dgram] = await Promise.all([
    import('node:http'),
    import('node:https'),
    import('node:net'),
    import('node:tls'),
    import('node:dgram'),
  ])

  assert.throws(() => http.request('http://example.com'), isForbidden)
  assert.throws(() => https.get('https://example.com'), isForbidden)
  assert.throws(() => net.createConnection(80, 'example.com'), isForbidden)
  assert.throws(() => tls.connect(443, 'example.com'), isForbidden)
  assert.throws(() => dgram.createSocket('udp4'), isForbidden)

  assert.deepEqual(
    getOfflineEvalNetworkAttempts().map((entry) => entry.transport),
    ['http', 'https', 'net', 'tls', 'dgram'],
  )
})

test('offline eval network guard blocks DNS callback, promise, and Resolver APIs', async () => {
  const [dns, dnsPromises] = await Promise.all([
    import('node:dns'),
    import('node:dns/promises'),
  ])

  assert.throws(() => dns.lookup('example.com', () => {}), isForbidden)
  await assert.rejects(dnsPromises.resolve4('example.com'), isForbidden)

  const callbackResolver = new dns.Resolver()
  assert.throws(() => callbackResolver.resolveTxt('example.com', () => {}), isForbidden)
  const promiseResolver = new dnsPromises.Resolver()
  await assert.rejects(promiseResolver.resolveMx('example.com'), isForbidden)

  assert.deepEqual(
    getOfflineEvalNetworkAttempts().map((entry) => entry.transport),
    ['dns', 'dns', 'dns', 'dns'],
  )
})

test('offline eval network guard blocks HTTP/2 and global WebSocket entry points', async () => {
  const http2 = await import('node:http2')
  assert.throws(() => http2.connect('https://example.com'), isForbidden)
  assert.throws(() => new globalThis.WebSocket('wss://example.com/socket'), isForbidden)
  assert.deepEqual(
    getOfflineEvalNetworkAttempts().map((entry) => entry.transport),
    ['http2', 'websocket'],
  )
})

test('offline eval network guard blocks child process async, sync, and prototype entry points', async () => {
  const childProcess = await import('node:child_process')
  const calls = [
    () => childProcess.exec('ignored'),
    () => childProcess.execFile('ignored'),
    () => childProcess.execFileSync('ignored'),
    () => childProcess.execSync('ignored'),
    () => childProcess.fork('ignored'),
    () => childProcess.spawn('ignored'),
    () => childProcess.spawnSync('ignored'),
    () => new childProcess.ChildProcess().spawn({ file: 'ignored', args: [] }),
  ]
  for (const call of calls) assert.throws(call, isForbidden)

  const attempts = getOfflineEvalNetworkAttempts()
  assert.equal(attempts.length, calls.length)
  assert.ok(attempts.every((entry) => entry.transport === 'child_process'))
  assert.ok(attempts.every((entry) => entry.target === '[external-process]'))
})

test('offline eval network guard forces Worker inheritance even with empty execArgv', async () => {
  const { Worker } = await import('node:worker_threads')
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads')
    fetch('https://example.com/private').then(
      () => parentPort.postMessage({ escaped: true }),
      (error) => parentPort.postMessage({
        escaped: false,
        code: error && error.code,
        retryable: error && error.retryable,
      }),
    )
  `, { eval: true, execArgv: [] })
  const [message] = await once(worker, 'message')
  await worker.terminate()
  assert.deepEqual(message, {
    escaped: false,
    code: OFFLINE_EVAL_NETWORK_ERROR_CODE,
    retryable: false,
  })
})

test('offline eval network guard keeps its stable error for hostile target metadata', async () => {
  const hostile = Object.create(null)
  Object.defineProperty(hostile, 'url', {
    get() {
      throw new Error('hostile URL getter escaped')
    },
  })
  Object.defineProperty(hostile, 'hostname', {
    get() {
      throw new Error('hostile hostname getter escaped')
    },
  })

  await assert.rejects(globalThis.fetch(hostile), isForbidden)
  const [attempt] = getOfflineEvalNetworkAttempts()
  assert.equal(attempt.transport, 'fetch')
  assert.equal(attempt.target, '[unknown-target]')
})

test('offline eval network guard blocks sockets created before installation', async () => {
  restoreOfflineEvalNetworkGuard()
  const [net, dgram] = await Promise.all([
    import('node:net'),
    import('node:dgram'),
  ])
  const socket = new net.Socket()
  const udpSocket = dgram.createSocket('udp4')
  installOfflineEvalNetworkGuard()
  try {
    assert.throws(() => socket.connect(80, 'example.com'), isForbidden)
    assert.throws(() => udpSocket.send('blocked', 53, 'example.com'), isForbidden)
  } finally {
    socket.destroy()
    try {
      udpSocket.close()
    } catch {
      // The guard rejects before dgram allocates a running handle.
    }
  }
  assert.deepEqual(
    getOfflineEvalNetworkAttempts().map((entry) => entry.transport),
    ['net', 'dgram'],
  )
})

test('offline eval network guard is idempotent, bounded, resettable, and reversible', async () => {
  assert.equal(installOfflineEvalNetworkGuard(), false)
  for (let index = 0; index < 300; index += 1) {
    await assert.rejects(globalThis.fetch(`https://example.com/${index}`), isForbidden)
  }
  const boundedAttempts = getOfflineEvalNetworkAttempts()
  assert.equal(boundedAttempts.length, 256)
  assert.equal(boundedAttempts[0].sequence, 45)

  resetOfflineEvalNetworkAttempts()
  assert.deepEqual(getOfflineEvalNetworkAttempts(), [])

  const blockedFetch = globalThis.fetch
  const http = await import('node:http')
  const blockedRequest = http.request
  assert.equal(restoreOfflineEvalNetworkGuard(), true)
  assert.notEqual(globalThis.fetch, blockedFetch)
  assert.notEqual(http.request, blockedRequest)
  assert.equal(restoreOfflineEvalNetworkGuard(), false)
  assert.equal(installOfflineEvalNetworkGuard(), true)
})

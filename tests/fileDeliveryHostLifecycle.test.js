import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { startVerificationHostLifecycle } from '../scripts/file-delivery-verification/hostLifecycle.mjs'
import { serveFileDeliveryVerification } from '../scripts/file-delivery-verification/server.mjs'

function fixture(overrides = {}) {
  const events = []
  const processHost = new EventEmitter()
  processHost.connected = true
  processHost.disconnect = () => { events.push('disconnect'); processHost.connected = false }
  const policy = { stop: () => events.push('stop') }
  const lease = { release: () => events.push('release') }
  const server = {
    listen: async () => { events.push('listen') },
    close: async () => { events.push('close') },
  }
  const options = {
    processHost,
    acquirePolicy: async () => { events.push('acquire'); return { policy, lease } },
    createServer: async ({ registerRuntimeCleanup }) => {
      events.push('construct')
      registerRuntimeCleanup(async () => { events.push('runtime-drain') })
      return server
    },
    saveSummary: () => { events.push('summary') },
    onReady: () => { events.push('ready') },
    ...overrides,
  }
  return { events, processHost, policy, lease, server, options }
}

function assertDetached(processHost) {
  for (const event of ['SIGINT', 'SIGTERM', 'disconnect']) {
    assert.equal(processHost.listenerCount(event), 0, event)
  }
  assert.equal(processHost.connected, false)
}

test('offline server composition delegates to the injected lifecycle without importing or starting production HTTP', async () => {
  const f = fixture()
  const host = await serveFileDeliveryVerification({ modelBinding: null }, f.options)
  assert.equal(host.server, f.server)
  await host.close()
  assertDetached(f.processHost)
  const refused = fixture()
  await assert.rejects(serveFileDeliveryVerification({ modelBinding: {} }, refused.options), {
    code: 'FILE_DELIVERY_LIVE_UNAVAILABLE',
  })
  assert.deepEqual(refused.events, [])
})

test('close shares one completion promise, drains before release and removes only owned listeners', async () => {
  const f = fixture()
  const unrelated = () => {}
  f.processHost.on('SIGTERM', unrelated)
  const host = await startVerificationHostLifecycle(f.options)
  assert.equal(host.server, f.server)
  assert.equal(host.policy, f.policy)
  const first = host.close()
  assert.equal(host.close(), first)
  await first
  assert.equal(host.close(), first)
  assert.deepEqual(f.events, ['acquire', 'construct', 'listen', 'summary', 'ready',
    'stop', 'close', 'runtime-drain', 'summary', 'release', 'disconnect'])
  assert.deepEqual(f.processHost.listeners('SIGTERM'), [unrelated])
  f.processHost.removeListener('SIGTERM', unrelated)
  assertDetached(f.processHost)
})

test('a pending server drain retains the lease and IPC until it completes', async () => {
  const f = fixture()
  let finishClose
  let drained = false
  f.server.close = () => new Promise(resolve => { f.events.push('close'); finishClose = resolve })
  f.options.createServer = async ({ registerRuntimeCleanup }) => {
    registerRuntimeCleanup(async () => {
      assert.equal(f.events.includes('release'), false)
      assert.equal(f.processHost.connected, true)
      f.events.push('runtime-drain')
      drained = true
    })
    return f.server
  }
  f.lease.release = () => {
    assert.equal(drained, true)
    assert.equal(f.processHost.connected, true)
    f.events.push('release')
  }
  const host = await startVerificationHostLifecycle(f.options)
  const closing = host.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.events.includes('release'), false)
  assert.equal(f.processHost.connected, true)
  finishClose()
  await closing
  assert.equal(drained, true)
  assert.equal(f.events.filter(event => event === 'release').length, 1)
  assertDetached(f.processHost)
})

test('close failure still saves, releases and disconnects; repeat close never replays cleanup', async () => {
  const f = fixture()
  const failure = new Error('synthetic sensitive server close error')
  f.server.close = async () => { f.events.push('close'); throw failure }
  const host = await startVerificationHostLifecycle(f.options)
  const closing = host.close()
  await assert.rejects(closing, error => error === failure)
  assert.equal(host.close(), closing)
  assert.deepEqual(f.events.slice(-6), ['stop', 'close', 'runtime-drain', 'summary', 'release', 'disconnect'])
  assertDetached(f.processHost)
})

for (const failureStage of ['acquire', 'import', 'construct', 'listen', 'summary', 'ready']) {
  test(`startup ${failureStage} failure rolls back every acquired resource and disconnects`, async () => {
    const f = fixture()
    const failure = Object.assign(new Error('synthetic credential must not be printed'), { code: 'FIXTURE_STARTUP_FAILED' })
    if (failureStage === 'acquire') f.options.acquirePolicy = async () => { throw failure }
    if (failureStage === 'import' || failureStage === 'construct') {
      f.options.createServer = async ({ registerRuntimeCleanup }) => {
        if (failureStage === 'construct') registerRuntimeCleanup(async () => { f.events.push('runtime-drain') })
        throw failure
      }
    }
    if (failureStage === 'listen') f.server.listen = async () => { throw failure }
    if (failureStage === 'summary') f.options.saveSummary = () => { throw failure }
    if (failureStage === 'ready') f.options.onReady = () => { throw failure }
    await assert.rejects(startVerificationHostLifecycle(f.options), error => error === failure)
    assert.equal(f.events.filter(event => event === 'release').length, failureStage === 'acquire' ? 0 : 1)
    assert.equal(f.events.filter(event => event === 'close').length,
      ['listen', 'summary', 'ready'].includes(failureStage) ? 1 : 0)
    assert.equal(f.events.filter(event => event === 'runtime-drain').length,
      ['construct', 'listen', 'summary', 'ready'].includes(failureStage) ? 1 : 0)
    assertDetached(f.processHost)
  })
}

test('startup failure remains primary even when rollback itself fails', async () => {
  const f = fixture()
  const primary = new Error('synthetic startup failure')
  f.server.listen = async () => { throw primary }
  f.server.close = async () => { f.events.push('close'); throw new Error('cleanup failure') }
  await assert.rejects(startVerificationHostLifecycle(f.options), error => error === primary)
  assert.ok(f.events.includes('runtime-drain'))
  assert.ok(f.events.includes('release'))
  assertDetached(f.processHost)
})

for (const failureStage of ['stop', 'runtime-drain', 'summary', 'release', 'disconnect']) {
  test(`cleanup ${failureStage} failure cannot skip remaining lifecycle disposal`, async () => {
    const f = fixture()
    const failure = new Error('synthetic cleanup failure')
    const fail = () => { f.events.push(failureStage); throw failure }
    if (failureStage === 'stop') f.policy.stop = fail
    if (failureStage === 'runtime-drain') f.options.createServer = async ({ registerRuntimeCleanup }) => {
      registerRuntimeCleanup(fail)
      return f.server
    }
    if (failureStage === 'release') f.lease.release = fail
    if (failureStage === 'disconnect') f.processHost.disconnect = () => {
      f.processHost.connected = false
      fail()
    }
    let summaryCalls = 0
    if (failureStage === 'summary') f.options.saveSummary = () => {
      if (++summaryCalls > 1) fail()
    }
    const host = await startVerificationHostLifecycle(f.options)
    await assert.rejects(host.close(), error => error === failure)
    assert.ok(f.events.includes('close'))
    assert.ok(f.events.includes('release'))
    assert.ok(f.events.includes('disconnect'))
    assertDetached(f.processHost)
  })
}

for (const signal of ['SIGINT', 'SIGTERM', 'disconnect']) {
  test(`${signal} closes the fake host without unhandled rejection or raw error logging`, async () => {
    const f = fixture()
    f.server.close = async () => { f.events.push('close'); throw new Error('must not be printed') }
    const host = await startVerificationHostLifecycle(f.options)
    f.processHost.emit(signal)
    await assert.rejects(host.close())
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.processHost.exitCode, 1)
    assertDetached(f.processHost)
    assert.equal(f.events.filter(event => event === 'release').length, 1)
  })
}

test('a non-IPC process closes without attempting disconnect', async () => {
  const f = fixture()
  f.processHost.connected = false
  f.processHost.disconnect = () => assert.fail('No IPC channel to disconnect')
  const host = await startVerificationHostLifecycle(f.options)
  await host.close()
  assertDetached(f.processHost)
  assert.equal(f.events.filter(event => event === 'release').length, 1)
})

test('disconnect during asynchronous construction cancels listen and readiness, then rolls back', async () => {
  const f = fixture()
  let finishConstruct
  f.options.createServer = async ({ registerRuntimeCleanup }) => {
    registerRuntimeCleanup(async () => { f.events.push('runtime-drain') })
    return new Promise(resolve => { finishConstruct = () => resolve(f.server) })
  }
  const startup = startVerificationHostLifecycle(f.options)
  await new Promise(resolve => setImmediate(resolve))
  f.processHost.emit('disconnect')
  finishConstruct()
  await assert.rejects(startup, { code: 'FILE_DELIVERY_HOST_START_CANCELLED' })
  assert.equal(f.events.includes('listen'), false)
  assert.equal(f.events.includes('ready'), false)
  assert.ok(f.events.includes('close'))
  assert.ok(f.events.includes('release'))
  assertDetached(f.processHost)
})

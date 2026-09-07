import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpToolCatalogRefresh } from '../server/mcp/mcpToolCatalogRefresh.js'

const tools = (name) => ({ tools: [{ name, inputSchema: { type: 'object', properties: {} } }] })
const changed = { method: 'notifications/tools/list_changed' }

function fixture(overrides = {}) {
  const listeners = new Set()
  const applied = []
  const errors = []
  let successful = 0
  const refresh = createMcpToolCatalogRefresh({
    transport: { onNotification(fn) { listeners.add(fn); return () => listeners.delete(fn) } },
    isCurrent: () => true,
    getServer: () => ({ enabled: true }),
    readTools: async () => tools('current'),
    applyTools: (_server, value) => applied.push(value),
    onError: (error) => errors.push(error),
    onSuccess: () => { successful += 1 },
    debounceMs: 0,
    ...overrides,
  })
  return { refresh, listeners, applied, errors, successful: () => successful,
    notify(message = changed) { for (const listener of listeners) listener(message) } }
}

async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('catalog fixture did not settle')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

test('startup catalog notifications are coalesced and do not issue RPCs before activation', async (t) => {
  let calls = 0
  const f = fixture({ readTools: async () => { calls += 1; return tools('ready') } })
  t.after(() => f.refresh.dispose())
  for (let index = 0; index < 100; index += 1) f.notify()
  assert.equal(calls, 0)
  f.refresh.activate()
  await f.refresh.whenIdle()
  assert.equal(calls, 1)
  assert.equal(f.applied[0][0].name, 'ready')
})

test('an in-flight refresh has at most one coalesced successor and never overlaps another RPC', async (t) => {
  const pending = []
  let inFlight = 0
  let maximum = 0
  const f = fixture({ readTools: () => {
    inFlight += 1
    maximum = Math.max(maximum, inFlight)
    return new Promise((resolve) => pending.push((value) => { inFlight -= 1; resolve(value) }))
  } })
  t.after(() => f.refresh.dispose())
  f.refresh.activate()
  f.notify()
  await until(() => pending.length === 1)
  for (let index = 0; index < 100; index += 1) f.notify()
  assert.equal(pending.length, 1)
  pending[0](tools('first'))
  await until(() => pending.length === 2)
  pending[1](tools('latest'))
  await f.refresh.whenIdle()
  assert.equal(maximum, 1)
  assert.equal(pending.length, 2)
  assert.deepEqual(f.applied.map((value) => value[0].name), ['first', 'latest'])
})

test('failed or malformed refreshes retain the last catalog and can recover on a later notification', async (t) => {
  const results = [new Error('catalog temporarily unavailable'), {}, { tools: [] }]
  const f = fixture({ readTools: async () => {
    const next = results.shift()
    if (next instanceof Error) throw next
    return next
  } })
  t.after(() => f.refresh.dispose())
  f.refresh.activate()
  f.notify()
  await f.refresh.whenIdle()
  f.notify()
  await f.refresh.whenIdle()
  assert.equal(f.errors.length, 2)
  assert.equal(f.applied.length, 0)
  f.notify()
  await f.refresh.whenIdle()
  assert.deepEqual(f.applied, [[]], 'an authoritative empty catalog is a real removal')
  assert.equal(f.successful(), 1)
})

test('disposing a refresh detaches its listener, aborts work, and fences an uncooperative old result', async () => {
  let complete
  let signal
  const f = fixture({ readTools: (request) => {
    signal = request.signal
    return new Promise((resolve) => { complete = resolve })
  } })
  f.refresh.activate()
  f.notify()
  await until(() => typeof complete === 'function')
  f.refresh.dispose()
  assert.equal(f.listeners.size, 0)
  assert.equal(signal.aborted, true)
  complete(tools('obsolete'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.applied.length, 0)
  assert.equal(f.errors.length, 0)
  await f.refresh.whenIdle()
})

test('a replaced connection cannot publish a late catalog even before cleanup runs', async (t) => {
  let owned = true
  let complete
  const f = fixture({ isCurrent: () => owned, readTools: () => new Promise((resolve) => { complete = resolve }) })
  t.after(() => f.refresh.dispose())
  f.refresh.activate()
  f.notify()
  await until(() => typeof complete === 'function')
  owned = false
  complete(tools('old-connection'))
  await f.refresh.whenIdle()
  assert.equal(f.applied.length, 0)
})

test('non-catalog notifications do not refresh tools or create work', async (t) => {
  let calls = 0
  const f = fixture({ readTools: async () => { calls += 1; return tools('unchanged') } })
  t.after(() => f.refresh.dispose())
  f.refresh.activate()
  f.notify({ method: 'notifications/resources/list_changed' })
  await f.refresh.whenIdle()
  assert.equal(calls, 0)
})

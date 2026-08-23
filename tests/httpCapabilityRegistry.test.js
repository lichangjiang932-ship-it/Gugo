import assert from 'node:assert/strict'
import test from 'node:test'

import { createAppServer } from '../server/appServer.js'
import { createHttpCapabilityRegistry } from '../server/core/httpCapabilityRegistry.js'

function route(id, {
  priority,
  replaces,
  match = () => true,
  handle = () => id,
} = {}) {
  return {
    id,
    priority,
    ...(replaces ? { replaces } : {}),
    match,
    handle,
  }
}

test('HTTP capabilities require explicit priorities and dispatch deterministically', async () => {
  const registry = createHttpCapabilityRegistry()
  assert.throws(
    () => registry.register(route('test.missing-priority')),
    (error) => error?.code === 'HTTP_CAPABILITY_INVALID',
  )

  registry.register(route('test.low', { priority: 10 }))
  const expected = Promise.resolve('high')
  registry.register(route('test.high', { priority: 20, handle: () => expected }))

  const dispatched = registry.dispatch({ url: '/anything' }, {})
  assert.equal(dispatched.handled, true)
  assert.equal(dispatched.capability.id, 'test.high')
  assert.equal(dispatched.result, expected)
  assert.equal(await dispatched.result, 'high')
})

test('HTTP replacements are explicit, reversible, and audit every lifecycle transition', () => {
  let clock = 100
  const deliveredAudit = []
  const registry = createHttpCapabilityRegistry({
    audit: (entry) => deliveredAudit.push(entry),
    now: () => clock += 1,
  })
  const disposeBase = registry.register(route('builtin.route', { priority: 10 }))

  assert.throws(
    () => registry.register(route('builtin.route', { priority: 20 })),
    (error) => error?.code === 'HTTP_CAPABILITY_DUPLICATE',
  )
  assert.throws(
    () => registry.register(route('plugin.low-priority', {
      priority: 10,
      replaces: 'builtin.route',
    })),
    (error) => error?.code === 'HTTP_CAPABILITY_PRIORITY_CONFLICT'
      && error?.retryable === false,
  )

  const disposeReplacement = registry.register(route('plugin.route', {
    priority: 20,
    replaces: 'builtin.route',
  }))
  assert.equal(registry.has('builtin.route'), false)
  assert.equal(registry.has('plugin.route'), true)
  assert.throws(
    () => disposeBase(),
    (error) => error?.code === 'HTTP_CAPABILITY_REPLACEMENT_ACTIVE',
  )

  assert.equal(disposeReplacement(), true)
  assert.equal(disposeReplacement(), false)
  assert.equal(registry.has('plugin.route'), false)
  assert.equal(registry.has('builtin.route'), true)
  assert.equal(disposeBase(), true)

  const eventNames = registry.listAuditEvents().map((entry) => entry.event)
  assert.deepEqual(eventNames, [
    'http_capability.registered',
    'http_capability.replaced',
    'http_capability.unregistered',
    'http_capability.restored',
    'http_capability.unregistered',
  ])
  assert.deepEqual(deliveredAudit.map((entry) => entry.event), eventNames)
  assert.ok(deliveredAudit.every(Object.isFrozen))
})

test('HTTP capability batches roll back atomically on registration failure', () => {
  const registry = createHttpCapabilityRegistry()
  assert.throws(
    () => registry.registerAll([
      route('test.atomic', { priority: 1 }),
      route('test.atomic', { priority: 2 }),
    ]),
    (error) => error?.code === 'HTTP_CAPABILITY_DUPLICATE',
  )
  assert.deepEqual(registry.list(), [])
  assert.deepEqual(
    registry.listAuditEvents().map((entry) => entry.event),
    ['http_capability.registered', 'http_capability.unregistered'],
  )
})

test('HTTP capability batch registration exhausts rollback and preserves every failure', () => {
  const registry = createHttpCapabilityRegistry()
  let disposeReplacementA = null
  let disposeReplacementB = null
  const failingDefinition = {}
  Object.defineProperty(failingDefinition, 'id', {
    enumerable: true,
    get() {
      disposeReplacementA = registry.register(route('test.rollback-a-replacement', {
        priority: 20,
        replaces: 'test.rollback-a',
      }))
      disposeReplacementB = registry.register(route('test.rollback-b-replacement', {
        priority: 20,
        replaces: 'test.rollback-b',
      }))
      return 'invalid id'
    },
  })

  let observedError = null
  assert.throws(
    () => registry.registerAll([
      route('test.rollback-a', { priority: 10 }),
      route('test.rollback-b', { priority: 10 }),
      failingDefinition,
    ]),
    (error) => {
      observedError = error
      return error instanceof AggregateError
        && error?.code === 'HTTP_CAPABILITY_ROLLBACK_FAILED'
        && error?.retryable === false
    },
  )

  assert.equal(observedError.errors.length, 3)
  assert.equal(observedError.errors[0], observedError.cause)
  assert.equal(observedError.cause?.code, 'HTTP_CAPABILITY_INVALID')
  assert.deepEqual(
    observedError.errors.slice(1).map((error) => error?.code),
    [
      'HTTP_CAPABILITY_REPLACEMENT_ACTIVE',
      'HTTP_CAPABILITY_REPLACEMENT_ACTIVE',
    ],
  )
  assert.deepEqual(
    registry.list().map((entry) => entry.id).sort(),
    ['test.rollback-a-replacement', 'test.rollback-b-replacement'],
  )

  assert.equal(disposeReplacementB(), true)
  assert.equal(disposeReplacementA(), true)
  assert.equal(registry.disposeAll(), 2)
  assert.deepEqual(registry.list(), [])
})

test('HTTP capability batches retain only blocked members and retry them without replaying revoked members', async () => {
  const registry = createHttpCapabilityRegistry()
  const disposeBatch = registry.registerAll([
    route('test.batch-a', { priority: 10 }),
    route('test.batch-b', { priority: 10 }),
  ])
  const disposeReplacement = registry.register(route('test.batch-a-replacement', {
    priority: 20,
    replaces: 'test.batch-a',
  }))

  const first = disposeBatch.beginRevoke()
  assert.equal(first.visibility, 'retained')
  await first.cleanup
  assert.equal(registry.has('test.batch-a-replacement'), true)
  assert.equal(registry.has('test.batch-b'), false)
  assert.equal(
    registry.listAuditEvents().filter((entry) => (
      entry.event === 'http_capability.unregistered'
      && entry.capabilityId === 'test.batch-b'
    )).length,
    1,
  )

  assert.equal(disposeReplacement(), true)
  const second = disposeBatch.beginRevoke()
  assert.equal(second.visibility, 'revoked')
  await second.cleanup
  assert.deepEqual(registry.list(), [])
  assert.equal(
    registry.listAuditEvents().filter((entry) => (
      entry.event === 'http_capability.unregistered'
      && entry.capabilityId === 'test.batch-b'
    )).length,
    1,
  )
  assert.equal(disposeBatch(), false)
})

test('app server exposes a reversible hook that can replace a builtin HTTP capability', async (t) => {
  const auditEvents = []
  const server = createAppServer({
    getEnv: () => ({ AUTH_MODE: 'local' }),
    httpCapabilityAudit: (entry) => auditEvents.push(entry),
    configureHttpCapabilities: (registry) => registry.register({
      id: 'test.model-status',
      owner: 'test-plugin',
      priority: 20_000,
      replaces: 'builtin.model.status',
      apiPrefixes: ['/api/model/status'],
      match: (req) => req.url?.startsWith('/api/model/status'),
      handle: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ source: 'test-plugin' }))
      },
    }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  assert.equal(server.httpCapabilities.get('test.model-status')?.owner, 'test-plugin')
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/model/status`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { source: 'test-plugin' })
  assert.ok(auditEvents.some((entry) => (
    entry.event === 'http_capability.replaced'
    && entry.replacedCapabilityId === 'builtin.model.status'
  )))
})

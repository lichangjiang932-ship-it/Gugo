import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLifecycleCapabilityGraph,
  createLifecycleCapabilityRegistry,
} from '../server/core/lifecycleCapabilityGraph.js'

function capability(id, overrides = {}) {
  return {
    id,
    priority: 0,
    ...overrides,
  }
}

test('lifecycle graph starts in deterministic dependency order and stops in exact reverse order', async () => {
  const order = []
  let releaseFoundation
  const foundationReady = new Promise((resolve) => { releaseFoundation = resolve })
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll([
    capability('foundation', {
      priority: 10,
      start: () => {
        order.push('start:foundation')
        return foundationReady
      },
      stop: () => { order.push('stop:foundation') },
    }),
    capability('independent', {
      priority: 20,
      start: () => { order.push('start:independent') },
      stop: () => { order.push('stop:independent') },
    }),
    capability('dependent', {
      priority: 100,
      dependsOn: ['foundation'],
      start: () => { order.push('start:dependent') },
      stop: () => { order.push('stop:dependent') },
    }),
  ])
  const graph = createLifecycleCapabilityGraph({ registry })

  const run = graph.startAll()
  assert.deepEqual(order, [
    'start:independent',
    'start:foundation',
  ], 'dependency-free hooks start concurrently before startAll returns')
  assert.deepEqual(run.order, ['independent', 'foundation', 'dependent'])
  releaseFoundation()
  assert.equal((await run.ready).failures.length, 0)
  assert.deepEqual(order, [
    'start:independent',
    'start:foundation',
    'start:dependent',
  ], 'dependent hook waits for its asynchronous dependency readiness')

  const stopped = await graph.stopAll()
  assert.deepEqual(stopped.order, ['dependent', 'foundation', 'independent'])
  assert.deepEqual(order, [
    'start:independent',
    'start:foundation',
    'start:dependent',
    'stop:dependent',
    'stop:foundation',
    'stop:independent',
  ])
  assert.equal(stopped.exitCode, 0)
})

test('explicit replacement keeps the logical slot, inherits dependencies, and is fully audited', async () => {
  const order = []
  let tick = 0
  const registry = createLifecycleCapabilityRegistry({ now: () => tick += 1 })
  registry.registerAll([
    capability('foundation', {
      start: () => { order.push('foundation') },
    }),
    capability('builtin.worker', {
      priority: 5,
      dependsOn: ['foundation'],
      start: () => { order.push('builtin') },
    }),
    capability('consumer', {
      dependsOn: ['builtin.worker'],
      start: () => { order.push('consumer') },
    }),
  ])
  registry.register(capability('adapter.worker', {
    priority: 10,
    replaces: 'builtin.worker',
    start: () => { order.push('adapter') },
  }))

  assert.equal(registry.get('builtin.worker').id, 'adapter.worker')
  assert.equal(registry.get('builtin.worker').slotId, 'builtin.worker')
  assert.deepEqual(registry.get('builtin.worker').dependsOn, ['foundation'])

  const graph = createLifecycleCapabilityGraph({ registry })
  await graph.startAll().ready
  assert.deepEqual(order, ['foundation', 'adapter', 'consumer'])
  const replacementAudit = registry.listAuditEvents().find((entry) => (
    entry.event === 'lifecycle_capability.replaced'
  ))
  assert.equal(replacementAudit.capabilityId, 'adapter.worker')
  assert.equal(replacementAudit.replacedCapabilityId, 'builtin.worker')
})

test('failed batch registration rolls back every earlier item and restores replaced capabilities', () => {
  const registry = createLifecycleCapabilityRegistry()
  registry.register(capability('builtin.worker', { priority: 5 }))

  assert.throws(
    () => registry.registerAll([
      capability('adapter.worker', {
        priority: 10,
        replaces: 'builtin.worker',
      }),
      capability('broken.adapter', {
        priority: 20,
        replaces: 'missing.worker',
      }),
    ]),
    (error) => error?.code === 'LIFECYCLE_REPLACEMENT_TARGET_MISSING',
  )

  assert.equal(registry.get('builtin.worker').id, 'builtin.worker')
  assert.equal(registry.has('adapter.worker'), false)
  assert.deepEqual(registry.list().map((entry) => entry.id), ['builtin.worker'])
  assert.ok(registry.listAuditEvents().some((entry) => (
    entry.event === 'lifecycle_capability.restored'
    && entry.capabilityId === 'builtin.worker'
  )))
})

test('start and stop failures are isolated while unresolved timeouts stay bounded and block dependencies', async () => {
  const order = []
  const observed = []
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll([
    capability('first', {
      start: () => {
        order.push('start:first')
        throw new Error('start failed')
      },
      stop: () => {
        order.push('stop:first')
        throw new Error('stop failed')
      },
      stopFailure: 'fail',
    }),
    capability('second', {
      dependsOn: ['first'],
      dependencyFailure: 'continue',
      start: () => { order.push('start:second') },
      stop: () => new Promise(() => {}),
      stopTimeoutMs: 10,
      stopFailure: 'ignore',
    }),
    capability('third', {
      dependsOn: ['second'],
      start: () => { order.push('start:third') },
      stop: () => { order.push('stop:third') },
    }),
  ])
  const graph = createLifecycleCapabilityGraph({
    registry,
    onError: (failure) => observed.push(failure),
  })

  const started = await graph.startAll().ready
  assert.deepEqual(order, ['start:first', 'start:second', 'start:third'])
  assert.equal(started.failures.length, 1)
  assert.equal(started.failures[0].capability.id, 'first')

  const stopped = await graph.stopAll()
  assert.deepEqual(order, [
    'start:first',
    'start:second',
    'start:third',
    'stop:third',
  ])
  assert.equal(stopped.failures.length, 1)
  assert.deepEqual(stopped.skipped.map((entry) => entry.capability.id), ['first'])
  assert.equal(stopped.exitCode, 1)
  assert.deepEqual(observed.map((failure) => [
    failure.phase,
    failure.capability.id,
    failure.timedOut,
  ]), [
    ['start', 'first', false],
    ['stop', 'second', true],
  ])
  assert.ok(registry.listAuditEvents().some((entry) => (
    entry.event === 'lifecycle_capability.stop_timed_out'
    && entry.capabilityId === 'second'
  )))
})

test('timed-out stop stays authoritative across retries and protects dependencies until it settles', async () => {
  const events = []
  let workerStopCalls = 0
  let releaseWorkerStop
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll([
    capability('foundation', {
      stop: () => { events.push('stop:foundation') },
    }),
    capability('worker', {
      dependsOn: ['foundation'],
      stopFailure: 'ignore',
      stopTimeoutMs: 10,
      stop: () => {
        workerStopCalls += 1
        events.push('stop:worker')
        return new Promise((resolve) => { releaseWorkerStop = resolve })
      },
    }),
  ])
  const graph = createLifecycleCapabilityGraph({ registry })
  await graph.startAll().ready

  const first = await graph.stopAll()
  assert.equal(first.exitCode, 1)
  assert.equal(workerStopCalls, 1)
  assert.deepEqual(events, ['stop:worker'])
  assert.deepEqual(first.skipped.map((entry) => entry.capability.id), ['foundation'])

  let retrySettled = false
  const retry = graph.stopAll().then((result) => {
    retrySettled = true
    return result
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(retrySettled, false)
  assert.equal(workerStopCalls, 1, 'retry must reuse the still-running stop hook')
  assert.deepEqual(events, ['stop:worker'], 'dependency must remain alive while stop is unresolved')

  releaseWorkerStop()
  const second = await retry
  assert.equal(second.exitCode, 0)
  assert.equal(workerStopCalls, 1)
  assert.deepEqual(events, ['stop:worker', 'stop:foundation'])
})

test('startup rollback waits for a timed-out start before stopping the capability', async () => {
  const events = []
  let releaseStart
  let resourceActive = false
  const registry = createLifecycleCapabilityRegistry()
  registry.register(capability('late-resource', {
    startFailure: 'fail',
    startTimeoutMs: 10,
    start: () => new Promise((resolve) => {
      releaseStart = () => {
        resourceActive = true
        events.push('start:settled')
        resolve()
      }
    }),
    stop: () => {
      events.push('stop')
      resourceActive = false
    },
  }))
  const graph = createLifecycleCapabilityGraph({ registry })

  const started = await graph.startAll().ready
  assert.equal(started.failures[0]?.status, 'timed_out')
  const rollback = graph.stopAll()
  let rollbackSettled = false
  void rollback.then(() => { rollbackSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(rollbackSettled, false)
  assert.deepEqual(events, [])

  releaseStart()
  const stopped = await rollback
  assert.equal(stopped.exitCode, 0)
  assert.deepEqual(events, ['start:settled', 'stop'])
  assert.equal(resourceActive, false)
})

test('fatal stop failures preserve dependencies and retry only the unresolved shutdown branch', async () => {
  const events = []
  let allowWorkerStop = false
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll([
    capability('foundation', {
      stop: () => { events.push('stop:foundation') },
    }),
    capability('independent', {
      stop: () => { events.push('stop:independent') },
    }),
    capability('worker', {
      dependsOn: ['foundation'],
      stopFailure: 'fail',
      stop: () => {
        events.push('stop:worker')
        if (!allowWorkerStop) throw new Error('worker still owns a foundation lease')
      },
    }),
    capability('leaf', {
      dependsOn: ['worker'],
      stop: () => { events.push('stop:leaf') },
    }),
  ])
  const graph = createLifecycleCapabilityGraph({ registry })
  await graph.startAll().ready

  const first = await graph.stopAll()
  assert.equal(first.exitCode, 1)
  assert.deepEqual(events, [
    'stop:leaf',
    'stop:worker',
    'stop:independent',
  ])
  assert.deepEqual(first.skipped.map((entry) => ({
    status: entry.status,
    skipReason: entry.skipReason,
    id: entry.capability.id,
    blockedBy: entry.blockingCapabilityIds,
  })), [{
    status: 'skipped',
    skipReason: 'dependent_stop_failure',
    id: 'foundation',
    blockedBy: ['worker'],
  }])

  allowWorkerStop = true
  const second = await graph.stopAll()
  assert.equal(second.exitCode, 0)
  assert.equal(second.skipped.length, 0)
  assert.deepEqual(events, [
    'stop:leaf',
    'stop:worker',
    'stop:independent',
    'stop:worker',
    'stop:foundation',
  ])
  assert.ok(registry.listAuditEvents().some((entry) => (
    entry.event === 'lifecycle_capability.stop_skipped'
    && entry.capabilityId === 'foundation'
    && entry.skipReason === 'dependent_stop_failure'
    && entry.blockingCapabilityIds.includes('worker')
  )))
})

test('dependency failures skip strict dependents while fail-soft dependents continue', async () => {
  const order = []
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll([
    capability('failing-root', {
      start: async () => {
        order.push('start:failing-root')
        throw new Error('unavailable')
      },
    }),
    capability('independent-root', {
      start: () => { order.push('start:independent-root') },
    }),
    capability('strict-dependent', {
      dependsOn: ['failing-root'],
      start: () => { order.push('start:strict-dependent') },
    }),
    capability('strict-grandchild', {
      dependsOn: ['strict-dependent'],
      start: () => { order.push('start:strict-grandchild') },
    }),
    capability('fail-soft-dependent', {
      dependsOn: ['failing-root'],
      dependencyFailure: 'continue',
      start: () => { order.push('start:fail-soft-dependent') },
    }),
  ])

  const result = await createLifecycleCapabilityGraph({ registry }).startAll().ready

  assert.deepEqual(order, [
    'start:failing-root',
    'start:independent-root',
    'start:fail-soft-dependent',
  ])
  assert.deepEqual(result.failures.map((entry) => entry.capability.id), ['failing-root'])
  assert.deepEqual(result.skipped.map((entry) => entry.capability.id), [
    'strict-dependent',
    'strict-grandchild',
  ])
  assert.ok(registry.listAuditEvents().some((entry) => (
    entry.event === 'lifecycle_capability.start_skipped'
    && entry.capabilityId === 'strict-dependent'
    && entry.dependencyCapabilityIds.includes('failing-root')
  )))
})

test('invalid dependency graphs fail before any hook runs and registry locks after execution begins', () => {
  let started = false
  const missingRegistry = createLifecycleCapabilityRegistry()
  missingRegistry.register(capability('dependent', {
    dependsOn: ['missing'],
    start: () => { started = true },
  }))
  const missingGraph = createLifecycleCapabilityGraph({ registry: missingRegistry })
  assert.throws(
    () => missingGraph.startAll(),
    (error) => error?.code === 'LIFECYCLE_DEPENDENCY_MISSING',
  )
  assert.equal(started, false)

  const cycleRegistry = createLifecycleCapabilityRegistry()
  cycleRegistry.registerAll([
    capability('left', { dependsOn: ['right'] }),
    capability('right', { dependsOn: ['left'] }),
  ])
  assert.throws(
    () => createLifecycleCapabilityGraph({ registry: cycleRegistry }).startAll(),
    (error) => error?.code === 'LIFECYCLE_DEPENDENCY_CYCLE',
  )

  const lockedRegistry = createLifecycleCapabilityRegistry()
  lockedRegistry.register(capability('ready'))
  createLifecycleCapabilityGraph({ registry: lockedRegistry }).startAll()
  assert.throws(
    () => lockedRegistry.register(capability('late')),
    (error) => error?.code === 'LIFECYCLE_REGISTRY_LOCKED',
  )
})

test('startup failure policy is validated and exposed to the host readiness barrier', async () => {
  const registry = createLifecycleCapabilityRegistry()
  registry.registerAll([
    capability('optional-startup', {
      start: () => { throw new Error('optional unavailable') },
    }),
    capability('required-startup', {
      startFailure: 'fail',
      start: () => { throw new Error('required unavailable') },
    }),
  ])

  const result = await createLifecycleCapabilityGraph({ registry }).startAll().ready
  assert.equal(result.failures.length, 2)
  assert.equal(result.failures.find((entry) => entry.capability.id === 'optional-startup').capability.startFailure, 'ignore')
  assert.equal(result.failures.find((entry) => entry.capability.id === 'required-startup').capability.startFailure, 'fail')

  assert.throws(
    () => createLifecycleCapabilityRegistry().register(capability('invalid-policy', {
      startFailure: 'sometimes',
    })),
    /startFailure must be "fail" or "ignore"/,
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configureRuntimePluginLifecycleCoordinatorForTests,
  isRuntimePluginLifecycleExclusive,
  resetRuntimePluginLifecycleCoordinatorForTests,
  runtimePluginIdsFromCheckpointState,
  runRuntimePluginCheckpointReferenceWrite,
  runRuntimePluginLifecycleOperation,
  runRuntimePluginReferenceWrite,
} from '../server/services/runtimePluginLifecycleCoordinator.js'

function installMemoryBarrierRuntime() {
  const barriers = new Map()
  const generations = new Map()
  const busy = (pluginId) => Object.assign(new Error('busy'), {
    code: 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE',
    statusCode: 409,
    retryable: true,
    pluginId,
  })
  const assertAvailable = (pluginIds) => {
    const ids = Array.isArray(pluginIds) ? pluginIds : [pluginIds]
    const blocked = ids.find((pluginId) => barriers.has(pluginId))
    if (blocked) throw busy(blocked)
    return true
  }
  configureRuntimePluginLifecycleCoordinatorForTests({
    getDb: () => Object.freeze({}),
    assertRuntimePluginMutationAvailable: assertAvailable,
    hasRuntimePluginMutationBarrier: (pluginId) => barriers.has(pluginId),
    acquireRuntimePluginMutationBarrier(pluginId, options = {}) {
      assertAvailable(pluginId)
      const generation = (generations.get(pluginId) || 0) + 1
      generations.set(pluginId, generation)
      const lease = Object.freeze({
        pluginId,
        token: `test-barrier-token-${generation}`,
        generation,
        operation: 'uninstall',
        phase: 'guarding',
        storeRevision: options.storeRevision || null,
        recoveryRequired: false,
      })
      barriers.set(pluginId, lease)
      return lease
    },
    heartbeatRuntimePluginMutationBarrier({ pluginId, token, generation, phase }) {
      const current = barriers.get(pluginId)
      if (!current || current.token !== token || current.generation !== generation) throw busy(pluginId)
      const next = Object.freeze({ ...current, phase })
      barriers.set(pluginId, next)
      return next
    },
    markRuntimePluginMutationBarrierRecoveryRequired({ pluginId, token, generation }) {
      const current = barriers.get(pluginId)
      if (!current || current.token !== token || current.generation !== generation) throw busy(pluginId)
      const next = Object.freeze({ ...current, phase: 'recovery_required', recoveryRequired: true })
      barriers.set(pluginId, next)
      return next
    },
    releaseRuntimePluginMutationBarrier({ pluginId, token, generation }) {
      const current = barriers.get(pluginId)
      if (!current || current.token !== token || current.generation !== generation) throw busy(pluginId)
      barriers.delete(pluginId)
      return true
    },
  })
  return barriers
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test.beforeEach(() => {
  resetRuntimePluginLifecycleCoordinatorForTests()
  installMemoryBarrierRuntime()
})
test.afterEach(() => resetRuntimePluginLifecycleCoordinatorForTests())

test('serializes lifecycle mutations per plugin without blocking another plugin', async () => {
  const gate = deferred()
  const entered = deferred()
  const order = []
  const first = runRuntimePluginLifecycleOperation('plugin-a', async () => {
    order.push('a:first:start')
    entered.resolve()
    await gate.promise
    order.push('a:first:end')
  })
  await entered.promise
  const second = runRuntimePluginLifecycleOperation('plugin-a', () => {
    order.push('a:second')
  })
  const other = runRuntimePluginLifecycleOperation('plugin-b', () => {
    order.push('b:first')
  })
  await other
  assert.deepEqual(order, ['a:first:start', 'b:first'])
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(order, ['a:first:start', 'b:first', 'a:first:end', 'a:second'])
})

test('exclusive lifecycle operation rejects synchronous release references until it exits', async () => {
  const gate = deferred()
  const entered = deferred()
  const operation = runRuntimePluginLifecycleOperation('plugin-a', async () => {
    entered.resolve()
    await gate.promise
  }, { exclusive: true })
  await entered.promise

  assert.equal(isRuntimePluginLifecycleExclusive('plugin-a'), true)
  assert.throws(
    () => runRuntimePluginReferenceWrite('plugin-a', () => 'written'),
    (error) => {
      assert.equal(error.code, 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE')
      assert.equal(error.statusCode, 409)
      assert.equal(error.retryable, true)
      return true
    },
  )
  assert.equal(runRuntimePluginReferenceWrite('plugin-b', () => 'other'), 'other')

  gate.resolve()
  await operation
  assert.equal(isRuntimePluginLifecycleExclusive('plugin-a'), false)
  assert.equal(runRuntimePluginReferenceWrite('plugin-a', () => 'written'), 'written')
})

test('a failed lifecycle mutation does not poison the per-plugin queue', async () => {
  const failed = runRuntimePluginLifecycleOperation('plugin-a', () => {
    throw new Error('expected failure')
  })
  const recovered = runRuntimePluginLifecycleOperation('plugin-a', () => 'recovered')
  await assert.rejects(failed, /expected failure/u)
  assert.equal(await recovered, 'recovered')
})

test('checkpoint reference scan finds nested runtime plugin identities deterministically', () => {
  const state = {
    nested: [{
      executionEnvironment: {
        runtimePlugins: [
          { id: 'plugin-b', releaseId: 'release-b' },
          { id: 'plugin-a', releaseId: 'release-a' },
          { id: 'plugin-b', releaseId: 'release-b' },
        ],
        unpinnedPluginIds: ['plugin-c', 'plugin-a'],
      },
    }],
  }
  assert.deepEqual(runtimePluginIdsFromCheckpointState(state), [
    'plugin-a',
    'plugin-b',
    'plugin-c',
  ])
})

test('checkpoint writes fail closed while a referenced plugin is exclusively retiring', async () => {
  const gate = deferred()
  const entered = deferred()
  const operation = runRuntimePluginLifecycleOperation('plugin-a', async () => {
    entered.resolve()
    await gate.promise
  }, { exclusive: true })
  await entered.promise
  let writes = 0
  assert.throws(() => runRuntimePluginCheckpointReferenceWrite({
    executionEnvironment: {
      runtimePlugins: [{ id: 'plugin-a', releaseId: 'release-a' }],
    },
  }, () => {
    writes += 1
  }), (error) => error?.code === 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE')
  assert.equal(writes, 0)
  assert.throws(() => runRuntimePluginCheckpointReferenceWrite({
    executionEnvironment: {
      runtimePlugins: [],
      unpinnedPluginIds: ['plugin-a'],
    },
  }, () => {
    writes += 1
  }), (error) => error?.code === 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE')
  assert.equal(writes, 0)
  gate.resolve()
  await operation
})

test('a retained recovery barrier keeps later lifecycle and reference writes blocked', async () => {
  resetRuntimePluginLifecycleCoordinatorForTests()
  const barriers = installMemoryBarrierRuntime()
  const result = await runRuntimePluginLifecycleOperation('plugin-a', (lifecycle) => {
    lifecycle.heartbeat('mutating')
    lifecycle.retainForRecovery()
    return 'committed-with-recovery'
  }, { exclusive: true })
  assert.equal(result, 'committed-with-recovery')
  assert.equal(barriers.get('plugin-a')?.recoveryRequired, true)
  assert.throws(
    () => runRuntimePluginReferenceWrite('plugin-a', () => 'written'),
    (error) => error?.code === 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE',
  )
  await assert.rejects(
    runRuntimePluginLifecycleOperation('plugin-a', () => 'mutated'),
    (error) => error?.code === 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE',
  )
})

test('an external durable barrier blocks a non-exclusive operation without an in-process marker', async () => {
  resetRuntimePluginLifecycleCoordinatorForTests()
  const barriers = installMemoryBarrierRuntime()
  barriers.set('plugin-a', Object.freeze({
    pluginId: 'plugin-a',
    token: 'external-barrier-token',
    generation: 7,
    phase: 'mutating',
  }))
  assert.equal(isRuntimePluginLifecycleExclusive('plugin-a'), true)
  await assert.rejects(
    runRuntimePluginLifecycleOperation('plugin-a', () => 'mutated'),
    (error) => error?.code === 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE',
  )
})

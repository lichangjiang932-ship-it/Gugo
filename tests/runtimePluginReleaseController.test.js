import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createRuntimePluginReleaseController } from '../server/plugins/runtimePluginReleaseController.js'

const registrySource = readFileSync(
  new URL('../server/plugins/runtimePluginRegistry.js', import.meta.url),
  'utf8',
)
const releaseControllerSource = readFileSync(
  new URL('../server/plugins/runtimePluginReleaseController.js', import.meta.url),
  'utf8',
)

function pluginRecord(id, sequence) {
  return { manifest: { id }, sequence }
}

function controllerOptions(overrides = {}) {
  return {
    activeCallbackInvocation: () => null,
    callbackDrainDeadlockError: (operation) => new Error(`${operation} would deadlock`),
    detachLoopEventBindings: async () => {},
    discardStagedRecord: async () => ({ errors: [], removed: true }),
    listActiveRecords: () => [],
    listPendingReloads: () => [],
    listStagedRecords: () => [],
    registryToken: Object.freeze({}),
    reloadPluginConfigUnchecked: async () => true,
    unregisterPluginUnchecked: async () => true,
    ...overrides,
  }
}

test('release controller coalesces shutdown and releases records in reverse activation order', async () => {
  const calls = []
  let settleReload
  const pendingReload = new Promise((resolve) => {
    settleReload = () => {
      calls.push('reload:settled')
      resolve()
    }
  })
  const controller = createRuntimePluginReleaseController(controllerOptions({
    detachLoopEventBindings: async () => calls.push('loop:detached'),
    discardStagedRecord: async (record) => {
      calls.push(`staged:${record.manifest.id}`)
      return { errors: [], removed: true }
    },
    listActiveRecords: () => [pluginRecord('active-old', 1), pluginRecord('active-new', 3)],
    listPendingReloads: () => [pendingReload],
    listStagedRecords: () => [pluginRecord('staged-old', 2), pluginRecord('staged-new', 4)],
    unregisterPluginUnchecked: async (id) => calls.push(`active:${id}`),
  }))

  const firstShutdown = controller.shutdown()
  const duplicateShutdown = controller.shutdown()
  assert.strictEqual(duplicateShutdown, firstShutdown)
  assert.equal(controller.isShuttingDown(), true)
  assert.deepEqual(calls, [])

  settleReload()
  await firstShutdown

  assert.equal(controller.isShuttingDown(), false)
  assert.deepEqual(calls, [
    'reload:settled',
    'staged:staged-new',
    'staged:staged-old',
    'active:active-new',
    'active:active-old',
    'loop:detached',
  ])
})

test('release controller aggregates staged, active, and loop cleanup failures and resets state', async () => {
  const stagedFailure = new Error('staged cleanup failed')
  const activeFailure = new Error('active cleanup failed')
  const loopFailure = new Error('loop cleanup failed')
  let cleanupShouldFail = true
  const controller = createRuntimePluginReleaseController(controllerOptions({
    detachLoopEventBindings: async () => {
      if (cleanupShouldFail) throw loopFailure
    },
    discardStagedRecord: async () => cleanupShouldFail
      ? { errors: [stagedFailure], removed: false }
      : { errors: [], removed: true },
    listActiveRecords: () => [pluginRecord('active-plugin', 1)],
    listStagedRecords: () => [pluginRecord('staged-plugin', 2)],
    unregisterPluginUnchecked: async () => {
      if (cleanupShouldFail) throw activeFailure
    },
  }))

  const failedShutdown = controller.shutdown()
  await assert.rejects(failedShutdown, (error) => {
    assert.equal(error instanceof AggregateError, true)
    assert.equal(error.message, 'runtime plugin shutdown failed')
    assert.equal(error.errors.length, 3)
    assert.equal(error.errors[0] instanceof AggregateError, true)
    assert.equal(error.errors[0].message, 'staged runtime plugin cleanup failed: staged-plugin')
    assert.deepEqual(error.errors[0].errors, [stagedFailure])
    assert.strictEqual(error.errors[1], activeFailure)
    assert.strictEqual(error.errors[2], loopFailure)
    return true
  })
  assert.equal(controller.isShuttingDown(), false)

  cleanupShouldFail = false
  const retryShutdown = controller.shutdown()
  assert.notStrictEqual(retryShutdown, failedShutdown)
  await retryShutdown
  assert.equal(controller.isShuttingDown(), false)
})

test('release controller fails callback-owned release operations before calling lifecycle ports', async () => {
  const calls = []
  const invocation = { record: pluginRecord('callback-owner', 1) }
  const controller = createRuntimePluginReleaseController(controllerOptions({
    activeCallbackInvocation: () => invocation,
    callbackDrainDeadlockError: (operation, active, pluginId, token) => {
      calls.push({ active, operation, pluginId, token })
      return Object.assign(new Error(`${operation} would deadlock`), {
        code: `BLOCKED_${operation.toUpperCase()}`,
      })
    },
    reloadPluginConfigUnchecked: async () => calls.push('reload:unchecked'),
    unregisterPluginUnchecked: async () => calls.push('unregister:unchecked'),
  }))

  await assert.rejects(
    controller.reloadPluginConfig('target-plugin'),
    (error) => error?.code === 'BLOCKED_RELOAD',
  )
  await assert.rejects(
    controller.unregisterPlugin('target-plugin'),
    (error) => error?.code === 'BLOCKED_UNREGISTER',
  )
  await assert.rejects(
    controller.shutdown(),
    (error) => error?.code === 'BLOCKED_SHUTDOWN',
  )

  assert.deepEqual(calls.map(({ operation }) => operation), [
    'reload',
    'unregister',
    'shutdown',
  ])
  assert.deepEqual(calls.map(({ pluginId }) => pluginId), [
    'target-plugin',
    'target-plugin',
    '',
  ])
})

test('runtime plugin registry delegates release state and orchestration to the focused controller', () => {
  assert.ok(
    registrySource.split(/\r?\n/u).length <= 360,
    'Keep the runtime plugin registry composition host below 360 lines',
  )
  assert.match(
    registrySource,
    /createRuntimePluginReleaseController\(\{/u,
  )
  assert.doesNotMatch(registrySource, /let shuttingDown\b|let shutdownPromise\b/u)
  assert.doesNotMatch(registrySource, /Promise\.allSettled\(pendingReloads\)/u)
  assert.doesNotMatch(
    releaseControllerSource,
    /from ['"]\.\/runtimePluginRegistry\.js['"]/u,
  )
})

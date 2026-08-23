import assert from 'node:assert/strict'
import test from 'node:test'

import { createEffectTracker } from '../server/plugins/pluginLifecycle.js'
import {
  createRuntimePluginContributionCoordinator,
} from '../server/plugins/runtimePluginContributionCoordinator.js'

function record(id, { deferVisibility = true } = {}) {
  return {
    manifest: { id },
    deferVisibility,
    effects: createEffectTracker(),
    managedContributions: [],
    visibleEffects: new Set(),
    revocationErrors: [],
    revocationPromise: null,
  }
}

test('managed activation rolls back earlier host contributions in reverse order', async () => {
  const events = []
  const plugin = record('activation-rollback')
  const coordinator = createRuntimePluginContributionCoordinator({
    invokePluginCleanup: async (_record, _phase, cleanup) => cleanup(),
  })

  coordinator.createManagedContribution(plugin, {
    activate() {
      events.push('activate:first')
      return 'first-host-value'
    },
    deactivate(value) {
      events.push(`deactivate:${value}`)
    },
  })
  coordinator.createManagedContribution(plugin, {
    activate() {
      events.push('activate:second')
      throw new Error('second activation failed')
    },
    deactivate() {
      events.push('deactivate:second')
    },
  })

  await assert.rejects(
    coordinator.activateManagedContributions(plugin),
    /second activation failed/,
  )
  assert.deepEqual(events, [
    'activate:first',
    'activate:second',
    'deactivate:first-host-value',
  ])
  assert.equal(plugin.managedContributions.length, 0)
  assert.equal(plugin.visibleEffects.size, 0)
  assert.equal(plugin.effects.size, 0)
})

test('empty activation recovery preserves the original registration error', async () => {
  const plugin = record('empty-activation-recovery')
  const coordinator = createRuntimePluginContributionCoordinator({
    invokePluginCleanup: async (_record, _phase, cleanup) => cleanup(),
  })
  const original = Object.assign(new Error('replacement declaration required'), {
    code: 'RUNTIME_CAPABILITY_REPLACEMENT_REQUIRED',
  })

  coordinator.createManagedContribution(plugin, {
    activate() { throw original },
    deactivate() {},
    activationFailureParts: () => [],
  })

  await assert.rejects(
    coordinator.activateManagedContributions(plugin),
    (error) => error === original,
  )
  assert.equal(plugin.managedContributions.length, 0)
  assert.equal(plugin.visibleEffects.size, 0)
  assert.equal(plugin.effects.size, 0)
})

test('concurrent visible-effect revocation shares one host cleanup transaction', async () => {
  let releaseCleanup
  const gate = new Promise((resolve) => { releaseCleanup = resolve })
  let cleanupTransactions = 0
  let disposerCalls = 0
  const plugin = record('shared-revocation', { deferVisibility: false })
  const coordinator = createRuntimePluginContributionCoordinator({
    invokePluginCleanup: async (_record, phase, cleanup) => {
      cleanupTransactions += 1
      assert.equal(phase, 'revoke')
      await gate
      await cleanup()
    },
  })

  coordinator.createManagedContribution(plugin, {
    activate: () => Object.freeze({ generation: 1 }),
    deactivate(value) {
      assert.equal(value.generation, 1)
      disposerCalls += 1
    },
  })

  const first = coordinator.revokeVisibleEffects(plugin)
  const duplicate = coordinator.revokeVisibleEffects(plugin)
  assert.equal(duplicate, first)
  assert.equal(cleanupTransactions, 1)

  releaseCleanup()
  await first
  assert.equal(disposerCalls, 1)
  assert.equal(plugin.managedContributions.length, 0)
  assert.equal(plugin.visibleEffects.size, 0)
  assert.equal(plugin.revocationErrors.length, 0)
})

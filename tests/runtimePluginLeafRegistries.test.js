import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimePluginEventBindings } from '../server/plugins/runtimePluginEventBindings.js'
import { createRuntimePluginContributionCoordinator } from '../server/plugins/runtimePluginContributionCoordinator.js'
import { createRuntimePluginEventRegistry } from '../server/plugins/runtimePluginEventRegistry.js'
import { createRuntimePluginPromptRegistry } from '../server/plugins/runtimePluginPromptRegistry.js'
import { createRuntimePluginToolRegistry } from '../server/plugins/runtimePluginToolRegistry.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from '../server/plugins/runtimePluginContributionLifecycle.js'

function assertMissingDependency(factory, dependencies, missing, code, label) {
  const input = { ...dependencies }
  delete input[missing]
  assert.throws(
    () => factory(input),
    (error) => error instanceof TypeError
      && error?.code === code
      && error?.retryable === false
      && error?.message === `${label} requires ${missing}`,
  )
}

test('runtime plugin event registry fails closed when a host dependency is missing', () => {
  const dependencies = {
    listActiveRecords: () => [],
    assertPluginWritable: () => {},
    assertContributionDeclared: () => {},
    createManagedContribution: () => {},
    invokePluginCallback: () => {},
    emitAudit: () => {},
  }
  for (const missing of Object.keys(dependencies)) {
    assertMissingDependency(
      createRuntimePluginEventRegistry,
      dependencies,
      missing,
      'PLUGIN_EVENT_REGISTRY_DEPENDENCY_INVALID',
      'runtime plugin event registry',
    )
  }
})

test('runtime plugin prompt registry fails closed when a host dependency is missing', () => {
  const dependencies = {
    assertPluginWritable: () => {},
    assertContributionDeclared: () => {},
    createManagedContribution: () => {},
    invokePluginCallbackSync: () => {},
    emitAudit: () => {},
  }
  for (const missing of Object.keys(dependencies)) {
    assertMissingDependency(
      createRuntimePluginPromptRegistry,
      dependencies,
      missing,
      'PLUGIN_PROMPT_REGISTRY_DEPENDENCY_INVALID',
      'runtime plugin prompt registry',
    )
  }
})

test('failed event-bus binding retains host ownership until detach-all retries the exact handle', async () => {
  const contributions = [
    { pluginId: 'leaf-events', event: 'request', listener: () => {} },
    { pluginId: 'leaf-events', event: 'pre-step', listener: () => {} },
  ]
  const listeners = new Set()
  let revokeAttempts = 0
  const bindings = createRuntimePluginEventBindings({
    listActiveContributions: () => contributions,
  })

  assert.throws(
    () => bindings.bindLoopEvents({
      on(event, listener) {
        if (event === 'pre-step') throw new Error('second attachment rejected')
        listeners.add(listener)
        const dispose = () => listeners.delete(listener)
        return attachRuntimePluginBeginRevoke(dispose, () => {
          revokeAttempts += 1
          if (revokeAttempts === 1) return createRuntimePluginRevokeReceipt('retained')
          dispose()
          return createRuntimePluginRevokeReceipt('revoked')
        })
      },
      off(event, listener) {
        return listeners.delete(listener)
      },
    }),
    (error) => error instanceof AggregateError
      && error?.code === 'PLUGIN_EVENT_BIND_ROLLBACK_INCOMPLETE'
      && error?.retryable === true,
  )
  assert.equal(revokeAttempts, 1)
  assert.equal(listeners.size, 1)

  assert.equal(await bindings.detachAllBindings(), true)
  assert.equal(revokeAttempts, 2)
  assert.equal(listeners.size, 0)
})

test('detach-all reports asynchronous event binding cleanup failures', async () => {
  const contribution = { pluginId: 'leaf-events', event: 'request', listener: () => {} }
  const bindings = createRuntimePluginEventBindings({
    listActiveContributions: () => [contribution],
  })
  bindings.bindLoopEvents({
    on() {
      const dispose = () => {}
      return attachRuntimePluginBeginRevoke(dispose, () => createRuntimePluginRevokeReceipt(
        'revoked',
        Promise.reject(new Error('event cleanup rejected')),
      ))
    },
    off() { return true },
  })

  await assert.rejects(
    bindings.detachAllBindings(),
    (error) => error instanceof AggregateError
      && error?.code === 'PLUGIN_EVENT_BINDING_CLEANUP_FAILED'
      && error?.retryable === true
      && error.errors.some((entry) => /event cleanup rejected/.test(entry?.message || '')),
  )
})

test('detach-all supersedes a retained cleanup error after exact-handle revocation', async () => {
  const contribution = { pluginId: 'leaf-events', event: 'request', listener: () => {} }
  const listeners = new Set()
  let revokeAttempts = 0
  const bindings = createRuntimePluginEventBindings({
    listActiveContributions: () => [contribution],
  })
  const unbind = bindings.bindLoopEvents({
    on(_event, listener) {
      listeners.add(listener)
      const dispose = () => listeners.delete(listener)
      return attachRuntimePluginBeginRevoke(dispose, () => {
        revokeAttempts += 1
        if (revokeAttempts === 1) {
          return createRuntimePluginRevokeReceipt(
            'retained',
            Promise.reject(new Error('retained cleanup rejected before retry')),
          )
        }
        dispose()
        return createRuntimePluginRevokeReceipt('revoked')
      })
    },
    off(_event, listener) { return listeners.delete(listener) },
  })

  assert.equal(unbind(), false)
  assert.equal(await bindings.detachAllBindings(), true)
  assert.equal(revokeAttempts, 2)
  assert.equal(listeners.size, 0)
})

test('tool activation failure retains the first host handle for lifecycle cleanup', () => {
  let managed = null
  let capabilityDisposeCalls = 0
  const disposeCapability = () => {
    capabilityDisposeCalls += 1
    throw new Error('capability visibility unknown')
  }
  const registry = createRuntimePluginToolRegistry({
    assertPluginWritable: () => {},
    assertContributionDeclared: () => {},
    createManagedContribution: (_record, definition) => {
      managed = definition
      return definition
    },
    invokePluginCallback: () => {},
    registerRuntimeCapability: () => disposeCapability,
    registerTool: () => { throw new Error('tool registration rejected') },
    supportsRuntimeCapabilityReplacement: false,
  })
  const record = {
    configRevision: 1,
    manifest: {
      id: 'leaf-tools',
      version: '1.0.0',
      contributes: ['tool:leaf_tool'],
    },
  }

  registry.registerToolContribution(record, {
    name: 'leaf_tool',
    spec: {
      type: 'function',
      function: {
        name: 'leaf_tool',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    exec: async () => ({ ok: true }),
  })

  assert.throws(() => managed.activate(), /tool registration rejected/)
  assert.equal(capabilityDisposeCalls, 0)
  const parts = managed.activationFailureParts()
  assert.equal(parts.length, 1)
  assert.equal(parts[0].id, 'tool:leaf_tool:capability')
  assert.equal(parts[0].handle, disposeCapability)
})

test('managed activation rethrows the original failure when no recovery handle exists', () => {
  const originalError = Object.assign(new Error('capability registration rejected'), {
    code: 'RUNTIME_CAPABILITY_REPLACEMENT_REQUIRED',
  })
  const tracked = { disposed: false }
  const record = {
    manifest: { id: 'empty-activation-recovery' },
    managedContributions: [],
    visibleEffects: new Set(),
    effects: {
      track: () => tracked,
      markDisposed: (effect) => { effect.disposed = true },
    },
  }
  const coordinator = createRuntimePluginContributionCoordinator({
    invokePluginCleanup: async (_record, _phase, cleanup) => cleanup(),
  })

  assert.throws(
    () => coordinator.createManagedContribution(record, {
      activate: () => { throw originalError },
      parts: () => [],
      activationFailureParts: () => [],
    }),
    (error) => error === originalError,
  )
  assert.equal(record.managedContributions.length, 0)
  assert.equal(record.visibleEffects.size, 0)
  assert.equal(tracked.disposed, true)
})

test('prompt rendering stays fail-open when its audit sink throws', () => {
  const registry = createRuntimePluginPromptRegistry({
    assertPluginWritable: () => {},
    assertContributionDeclared: () => {},
    createManagedContribution: (_record, definition) => {
      definition.activate()
      return definition
    },
    invokePluginCallbackSync: (_record, _kind, callback, args, { complete, isolateError }) => {
      try {
        return complete(callback(...args))
      } catch (error) {
        throw isolateError(error)
      }
    },
    emitAudit: () => { throw new Error('audit unavailable') },
  })
  const record = {
    state: 'active',
    manifest: { id: 'leaf-prompts' },
  }
  registry.registerPromptContribution(record, {
    id: 'broken-prompt',
    render: () => { throw new Error('render rejected') },
  })

  const result = registry.renderPromptBlocks()
  assert.deepEqual(result.blocks, [])
  assert.deepEqual(result.errors, [{
    id: 'broken-prompt',
    pluginId: 'leaf-prompts',
    code: 'PLUGIN_PROMPT_RENDER_FAILED',
  }])
})

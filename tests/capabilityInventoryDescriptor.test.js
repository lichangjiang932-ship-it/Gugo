import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCapabilityDescriptor,
  createCapabilityInventorySnapshot,
  stableCapabilityKey,
} from '../shared/capabilityInventory.js'

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child, seen)
}

function descriptor(id, extra = {}) {
  return {
    kind: 'skill',
    id,
    name: `Skill ${id}`,
    scope: 'user',
    state: { discovered: true, callable: true },
    contributes: ['prompt', 'prompt'],
    requirements: ['model'],
    permissions: ['read'],
    provenance: { pluginId: 'plugin-a', updatedAt: 123 },
    health: { status: 'ok' },
    ...extra,
  }
}

test('capability descriptors and every nested collection are immutable', () => {
  const output = createCapabilityDescriptor(descriptor('writer'))

  assert.equal(output.key, 'skill:writer')
  assert.deepEqual(output.contributes, ['prompt'])
  assertDeepFrozen(output)
  assert.throws(() => output.state.active = true, TypeError)
  assert.throws(() => output.permissions.push('write'), TypeError)
})

test('capability snapshots use stable keys and deterministic key ordering', () => {
  assert.equal(stableCapabilityKey('Runtime-Plugin', 'zeta'), 'runtime-plugin:zeta')

  const snapshot = createCapabilityInventorySnapshot([
    descriptor('zeta'),
    descriptor('alpha', { kind: 'mcp-server' }),
    descriptor('alpha'),
  ])

  assert.deepEqual(snapshot.map((entry) => entry.key), [
    'mcp-server:alpha',
    'skill:alpha',
    'skill:zeta',
  ])
  assertDeepFrozen(snapshot)
})

test('capability snapshots reject duplicate stable keys', () => {
  assert.throws(
    () => createCapabilityInventorySnapshot([descriptor('writer'), descriptor('writer')]),
    (error) => error?.code === 'CAPABILITY_INVENTORY_DUPLICATE'
      && /skill:writer/u.test(error.message),
  )
})

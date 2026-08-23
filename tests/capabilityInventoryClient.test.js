import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPABILITY_INVENTORY_SCHEMA_VERSION,
  createCapabilityDescriptor,
  stableCapabilityKey,
} from '../shared/capabilityInventory.js'
import {
  createClientCapabilitySnapshot,
  fetchEffectiveCapabilityInventoryApi,
  mergeEffectiveCapabilityInventory,
  normalizeEffectiveCapabilityResponse,
} from '../src/lib/capabilityInventoryClient.js'
import { createSlashCommandRegistry } from '../src/lib/slashCommandRegistry.js'

function descriptor(kind, id, overrides = {}) {
  return createCapabilityDescriptor({
    key: stableCapabilityKey(kind, id),
    kind,
    id,
    name: id,
    description: '',
    origin: 'test',
    scope: 'host',
    state: {
      discovered: true,
      configured: true,
      enabled: true,
      active: true,
      connected: false,
      selected: false,
      callable: false,
      status: 'active',
    },
    ...overrides,
  })
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child, seen)
}

function containsFunction(value, seen = new Set()) {
  if (typeof value === 'function') return true
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Object.values(value).some((child) => containsFunction(child, seen))
}

test('client inventory safely projects UI, palette and slash registries into stable descriptors', () => {
  const component = () => null
  const handler = () => 'not copied'
  const uiPlugin = {
    id: 'client-ui',
    name: 'Client UI',
    version: '1.2.3',
    state: 'active',
    installedAt: '2026-08-22T00:00:00.000Z',
    contributes: ['ui:route:client-route'],
    requires: ['base-ui'],
    permissions: ['ui.render'],
    activate: handler,
    privateToken: 'ui-secret-marker',
  }
  const contribution = {
    id: 'client-route',
    pluginId: 'client-ui',
    slot: 'route',
    label: 'Client route',
    path: '/private-route',
    component,
    icon: component,
  }
  const command = {
    id: 'inspect',
    name: 'inspect',
    description: 'Inspect locally',
    kind: 'skill',
    handler: null,
    skill: { apiKey: 'command-secret-marker' },
  }
  const shadowedCommand = {
    id: 'inspect',
    name: 'shadowed',
    description: 'Must lose deterministic first-wins de-duplication',
    kind: 'builtin',
    handler,
  }
  const slashRegistry = createSlashCommandRegistry({ storage: null })
  slashRegistry.register({
    name: 'render',
    description: 'Render output',
    kind: 'prompt-template',
    handler,
    meta: { pluginId: 'render-plugin', secret: 'slash-secret-marker' },
  }, 'plugin')

  const snapshot = createClientCapabilitySnapshot({
    uiPlugins: [uiPlugin],
    uiSlots: ['route'],
    uiContributionsForSlot: () => [contribution],
    commands: [command, shadowedCommand],
    slashRegistry,
  })

  assert.deepEqual(snapshot.map((entry) => entry.key), [...snapshot.map((entry) => entry.key)].sort())
  assert.deepEqual(snapshot.map((entry) => entry.key), [
    'command:inspect',
    'slash-command:render',
    'ui-contribution:client-ui:route:client-route',
    'ui-plugin:client-ui',
  ])
  assert.equal(snapshot.find((entry) => entry.key === 'command:inspect').name, 'inspect')
  assert.equal(snapshot.find((entry) => entry.key === 'command:inspect').state.callable, true)
  assert.equal(snapshot.find((entry) => entry.key === 'slash-command:render').provenance.pluginId, 'render-plugin')
  assert.equal(snapshot.find((entry) => entry.key === 'ui-contribution:client-ui:route:client-route').state.callable, false)
  assert.equal(containsFunction(snapshot), false)
  const serialized = JSON.stringify(snapshot)
  assert.doesNotMatch(serialized, /private-route|secret-marker|apiKey|"component"|"handler"|"skill"/)

  uiPlugin.name = 'mutated'
  contribution.label = 'mutated'
  command.name = 'mutated'
  assert.equal(snapshot.find((entry) => entry.key === 'ui-plugin:client-ui').name, 'Client UI')
  assert.equal(snapshot.find((entry) => entry.key === 'command:inspect').name, 'inspect')
  assertDeepFrozen(snapshot)
})

test('client inventory never invokes accessor fields while projecting registry entries', () => {
  let getterCalls = 0
  const command = {
    id: 'safe-command',
    name: 'safe-command',
    description: 'Safe command',
    kind: 'builtin',
  }
  Object.defineProperty(command, 'handler', {
    enumerable: true,
    get() {
      getterCalls += 1
      return () => 'forged'
    },
  })

  const snapshot = createClientCapabilitySnapshot({
    uiPlugins: [],
    uiSlots: [],
    commands: [command],
    slashRegistry: null,
  })

  assert.equal(getterCalls, 0)
  assert.equal(snapshot[0].state.callable, false)
  assert.equal(containsFunction(snapshot), false)
})

test('effective response accepts only the versioned capabilities shape and detaches it', () => {
  const source = {
    ...descriptor('skill', 'server-skill'),
    state: { ...descriptor('skill', 'server-skill').state },
  }
  const response = normalizeEffectiveCapabilityResponse({
    ok: true,
    schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    capabilities: [source],
  })

  assert.equal(response.schemaVersion, CAPABILITY_INVENTORY_SCHEMA_VERSION)
  assert.equal(response.capabilities[0].key, 'skill:server-skill')
  assert.notEqual(response.capabilities[0], source)
  source.name = 'mutated'
  source.state.active = false
  assert.equal(response.capabilities[0].name, 'server-skill')
  assert.equal(response.capabilities[0].state.active, true)
  assertDeepFrozen(response)

  for (const payload of [
    null,
    { ok: true, schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION, items: [] },
    { ok: true, schemaVersion: 999, capabilities: [] },
    { schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION, capabilities: [] },
    { ok: true, schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION, capabilities: {} },
  ]) {
    assert.throws(
      () => normalizeEffectiveCapabilityResponse(payload),
      (error) => error?.code === 'CAPABILITY_INVENTORY_INVALID' && error?.retryable === false,
    )
  }

  let getterCalls = 0
  const accessorPayload = { ok: true, schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION }
  Object.defineProperty(accessorPayload, 'capabilities', {
    enumerable: true,
    get() {
      getterCalls += 1
      return []
    },
  })
  assert.throws(() => normalizeEffectiveCapabilityResponse(accessorPayload), /capabilities/)
  assert.equal(getterCalls, 0)
})

test('effective inventory merge is sorted, frozen and server-first on a duplicate key', () => {
  const result = mergeEffectiveCapabilityInventory({
    schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    capabilities: [
      descriptor('skill', 'remote-skill'),
      descriptor('command', 'duplicate', { name: 'Server command' }),
    ],
  }, {
    uiPlugins: [],
    uiSlots: [],
    commands: [
      { id: 'z-local', name: 'Local Z', description: 'Z', kind: 'builtin', handler: () => {} },
      { id: 'duplicate', name: 'Client command', description: 'duplicate', kind: 'builtin', handler: () => {} },
    ],
    slashRegistry: null,
  })

  assert.deepEqual(result.capabilities.map((entry) => entry.key), [
    'command:duplicate',
    'command:z-local',
    'skill:remote-skill',
  ])
  assert.equal(result.capabilities[0].name, 'Server command')
  assertDeepFrozen(result)
})

test('effective inventory client reads the authenticated no-store endpoint shape', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, init = {}) => {
    request = { url, init }
    return new Response(JSON.stringify({
      ok: true,
      schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
      capabilities: [descriptor('mcp-server', 'filesystem')],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const result = await fetchEffectiveCapabilityInventoryApi()
    assert.equal(request.url, '/api/capabilities/effective')
    assert.deepEqual(request.init.headers, {})
    assert.equal(request.init.cache, 'no-store')
    assert.equal(request.init.method, undefined)
    assert.equal(result.capabilities[0].key, 'mcp-server:filesystem')
    assertDeepFrozen(result)
  } finally {
    globalThis.fetch = originalFetch
  }
})

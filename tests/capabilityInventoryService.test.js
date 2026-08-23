import assert from 'node:assert/strict'
import test from 'node:test'

import { listEffectiveCapabilityInventory } from '../server/services/capabilityInventoryService.js'

const DESCRIPTOR_FIELDS = [
  'key', 'kind', 'id', 'name', 'description', 'origin', 'scope', 'version',
  'state', 'executionName', 'contributes', 'requirements', 'permissions',
  'risk', 'provenance', 'health',
].sort()

test('effective inventory aggregates all server sources with stable public fields', () => {
  const calls = []
  const secret = 'inventory-secret-must-not-leak'
  const inventory = listEffectiveCapabilityInventory({
    userId: '  user-a  ',
    readRuntimePlugins: () => [{
      id: 'plugin-z',
      name: 'Plugin Z',
      source: 'disk',
      version: '1.2.3',
      enabled: true,
      active: true,
      available: true,
      runtimeState: 'active',
      toolName: 'plugin_tool',
      manifest: { contributes: ['tool'], requires: ['workspace'] },
      activeRelease: { contentDigest: 'digest-z' },
      command: secret,
      env: { TOKEN: secret },
      headers: { Authorization: secret },
    }],
    readRuntimeCapabilities: () => [{
      id: 'cap-b',
      owner: 'plugin-z',
      type: 'http',
      slot: 'chat',
      version: '2',
      replaces: 'builtin.chat',
    }],
    readRuntimeBindings: () => [
      { id: 'cap-b', owner: 'plugin-z', type: 'http', slot: 'chat' },
      { id: 'cap-a', owner: 'builtin', type: 'policy', slot: 'approval' },
    ],
    readSkills: (scope) => {
      calls.push(['skills', scope])
      return [{
        id: 'skill-z',
        name: 'Skill Z',
        description: 'Local skill',
        loadable: true,
        loadHint: 'skill-z',
        apiKey: secret,
      }]
    },
    readMcpServers: (userId) => {
      calls.push(['mcp', userId])
      return [{
        id: 'mcp-z',
        name: 'MCP Z',
        transport: 'stdio',
        enabled: true,
        updatedAt: 456,
        userId,
        command: secret,
        args: [secret],
        url: `https://${secret}.example`,
        env: { TOKEN: secret },
        headers: { Authorization: secret },
      }]
    },
  })

  assert.deepEqual(calls, [
    ['skills', { userId: 'user-a' }],
    ['mcp', 'user-a'],
  ])
  assert.deepEqual(inventory.map((entry) => entry.key), [
    'mcp-server:mcp-z',
    'runtime-capability:cap-a',
    'runtime-capability:cap-b',
    'runtime-plugin:plugin-z',
    'skill:skill-z',
  ])
  for (const entry of inventory) {
    assert.deepEqual(Object.keys(entry).sort(), DESCRIPTOR_FIELDS)
    assert.deepEqual(Object.keys(entry.state).sort(), [
      'active', 'callable', 'configured', 'connected', 'discovered', 'enabled', 'selected', 'status',
    ])
    assert.deepEqual(Object.keys(entry.provenance).sort(), [
      'pluginId', 'releaseDigest', 'serverId', 'updatedAt',
    ])
    assert.deepEqual(Object.keys(entry.health).sort(), ['errorCode', 'status'])
  }
  const serialized = JSON.stringify(inventory)
  assert.doesNotMatch(serialized, new RegExp(secret, 'u'))
  for (const forbidden of ['apiKey', 'args', 'command', 'env', 'headers', 'url', 'userId']) {
    assert.equal(inventory.some((entry) => Object.hasOwn(entry, forbidden)), false)
  }
})

test('effective inventory requires an explicit tenant id before reading sources', () => {
  let reads = 0
  assert.throws(
    () => listEffectiveCapabilityInventory({
      userId: ' ',
      readRuntimePlugins: () => { reads += 1; return [] },
    }),
    (error) => error?.code === 'CAPABILITY_INVENTORY_USER_REQUIRED',
  )
  assert.equal(reads, 0)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createRuntimeCapabilityRegistry,
  RUNTIME_CAPABILITY_TYPES,
} from '../server/core/runtimeCapabilityRegistry.js'
import {
  normalizeRuntimeCapabilityBindings,
  readRuntimeCapabilityBindings,
} from '../server/core/runtimeCapabilityBindings.js'

function contribution(type, id, overrides = {}) {
  return {
    id,
    type,
    owner: id.startsWith('builtin.') ? 'builtin' : 'fixture-plugin',
    version: '1.0.0',
    priority: id.startsWith('builtin.') ? 0 : 10,
    implementation: type === 'policy'
      ? Object.freeze({
          contractVersion: 1,
          classify: () => Object.freeze({ decision: 'deny', risk: 'high', reason: 'fixture' }),
        })
      : Object.freeze({ id }),
    ...overrides,
  }
}

test('policy capabilities reject objects that cannot execute the versioned contract', () => {
  const registry = createRuntimeCapabilityRegistry()
  assert.throws(
    () => registry.register(contribution('policy', 'builtin.policy', {
      implementation: Object.freeze({ classify: () => ({ decision: 'allow' }) }),
    })),
    (error) => error?.code === 'RUNTIME_POLICY_ADAPTER_INVALID',
  )
  assert.throws(
    () => registry.register(contribution('policy', 'builtin.policy', {
      implementation: Object.freeze({ contractVersion: 2, classify: () => ({ decision: 'allow' }) }),
    })),
    (error) => error?.code === 'RUNTIME_POLICY_CONTRACT_UNSUPPORTED',
  )
})

test('authoritative registry supports all five fixed capability types and immutable snapshots', async () => {
  assert.deepEqual(RUNTIME_CAPABILITY_TYPES, ['loop', 'persistence', 'policy', 'tool', 'provider'])
  const registry = createRuntimeCapabilityRegistry()
  registry.registerAll([
    contribution('loop', 'builtin.loop'),
    contribution('persistence', 'builtin.persistence'),
    contribution('policy', 'builtin.policy'),
    contribution('tool', 'builtin.tool.read', { slot: 'read_file' }),
    contribution('provider', 'builtin.provider.openai', { slot: 'openai' }),
  ])

  const snapshot = await registry.resolve()
  assert.equal(snapshot.effectiveBindings.length, 5)
  assert.equal(snapshot.get('loop').id, 'builtin.loop')
  assert.equal(snapshot.get('tool', 'read_file').id, 'builtin.tool.read')
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.effectiveBindings), true)
})

test('tool slots preserve case without relaxing lowercase capability identities', async () => {
  const registry = createRuntimeCapabilityRegistry()
  registry.register(contribution('tool', 'builtin.tool.agent', { slot: 'Agent' }))

  const snapshot = await registry.resolve()
  assert.equal(snapshot.get('tool', 'Agent').id, 'builtin.tool.agent')
  assert.equal(snapshot.get('tool', 'agent'), null)
  assert.throws(
    () => registry.register(contribution('tool', 'builtin.tool.Agent', { slot: 'Agent' })),
    (error) => error?.code === 'RUNTIME_CAPABILITY_INVALID',
  )
})

test('replacement is explicit, higher priority, reversible, and binding can select a registered predecessor', async () => {
  const audit = []
  const registry = createRuntimeCapabilityRegistry({ audit: (entry) => audit.push(entry) })
  registry.register(contribution('loop', 'builtin.loop'))
  assert.throws(
    () => registry.register(contribution('loop', 'plugin.implicit')),
    (error) => error?.code === 'RUNTIME_CAPABILITY_REPLACEMENT_REQUIRED',
  )
  assert.throws(
    () => registry.register(contribution('loop', 'plugin.low', {
      priority: 0,
      replaces: 'builtin.loop',
    })),
    (error) => error?.code === 'RUNTIME_CAPABILITY_PRIORITY_CONFLICT',
  )
  const dispose = registry.register(contribution('loop', 'plugin.loop', {
    replaces: 'builtin.loop',
  }))

  assert.equal((await registry.resolve()).get('loop').id, 'plugin.loop')
  const builtin = await registry.resolve({ loop: 'builtin.loop' })
  assert.equal(builtin.get('loop').id, 'builtin.loop')
  assert.equal(builtin.effectiveBindings[0].source, 'runtime_config')
  assert.equal(dispose(), true)
  assert.equal((await registry.resolve()).get('loop').id, 'builtin.loop')
  assert.ok(audit.some((entry) => entry.event === 'runtime_capability.replaced'))
  assert.ok(audit.some((entry) => entry.event === 'runtime_capability.unregistered'))
})

test('unhealthy selected contribution cannot become an effective snapshot', async () => {
  const registry = createRuntimeCapabilityRegistry()
  registry.register(contribution('policy', 'builtin.policy', {
    healthCheck: () => ({ ok: false, code: 'POLICY_BROKEN' }),
  }))
  await assert.rejects(
    registry.resolve(),
    (error) => error?.code === 'RUNTIME_CAPABILITY_UNHEALTHY'
      && error?.capabilityId === 'builtin.policy',
  )
})

test('runtime config bindings merge user, project and explicit sources with provenance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-capability-bindings-'))
  const dataDir = path.join(root, 'data')
  const projectDir = path.join(root, 'project')
  const explicitPath = path.join(root, 'explicit.json')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(projectDir, '.gugo'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({
    env: {},
    capabilityBindings: {
      loop: 'plugin.loop.user',
      tool: { read_file: 'plugin.tool.user' },
    },
  }))
  fs.writeFileSync(path.join(projectDir, '.gugo', 'runtime.json'), JSON.stringify({
    env: {},
    capabilityBindings: {
      loop: 'plugin.loop.project',
      persistence: 'plugin.persistence.project',
    },
  }))
  fs.writeFileSync(explicitPath, JSON.stringify({
    env: {},
    capabilityBindings: {
      provider: { openai: 'plugin.provider.explicit' },
    },
  }))

  const result = readRuntimeCapabilityBindings({
    cwd: projectDir,
    env: { APP_DATA_DIR: dataDir, APP_CONFIG_PATH: explicitPath, GUGO_LOAD_DOTENV: '0' },
  })
  assert.equal(result.bindings.loop, 'plugin.loop.project')
  assert.equal(result.bindings.persistence, 'plugin.persistence.project')
  assert.equal(result.bindings.tool.read_file, 'plugin.tool.user')
  assert.equal(result.bindings.provider.openai, 'plugin.provider.explicit')
  assert.equal(result.provenance['loop:loop'], 'project_config')
  assert.equal(result.provenance['provider:openai'], 'explicit_config')
  assert.match(result.fingerprint, /^sha256-[a-f0-9]{64}$/)

  fs.rmSync(root, { recursive: true, force: true })
})

test('binding normalization fails closed on unknown types and malformed ids', () => {
  assert.throws(
    () => normalizeRuntimeCapabilityBindings({ memory: 'plugin.memory' }),
    (error) => error?.code === 'RUNTIME_CAPABILITY_BINDINGS_INVALID',
  )
  assert.throws(
    () => normalizeRuntimeCapabilityBindings({ tool: { read_file: '../escape' } }),
    (error) => error?.code === 'RUNTIME_CAPABILITY_BINDINGS_INVALID',
  )
})

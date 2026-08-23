import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePluginManifest } from '../shared/pluginManifest.js'
import { normalizeRuntimePluginManifest } from '../server/plugins/pluginLifecycle.js'

test('runtime and trusted UI plugins share one immutable manifest envelope', () => {
  const input = {
    id: 'shared-envelope',
    name: 'Shared envelope',
    version: '1.2.3',
    requires: ['base-plugin'],
    contributes: ['tool:example', 'ui:route:example-route'],
  }
  const shared = normalizePluginManifest(input)
  const runtime = normalizeRuntimePluginManifest(input)

  assert.deepEqual(runtime, shared)
  assert.equal(Object.isFrozen(shared), true)
  assert.equal(Object.isFrozen(shared.requires), true)
  assert.equal(Object.isFrozen(shared.contributes), true)
  assert.throws(() => shared.requires.push('forged-plugin'), TypeError)
  assert.throws(() => shared.contributes.splice(0), TypeError)
})

test('shared plugin manifests fail closed for invalid identity, version, dependencies, and declarations', () => {
  const valid = { id: 'valid-plugin', name: 'Valid plugin', version: '1.0.0' }
  assert.throws(() => normalizePluginManifest({ ...valid, id: 'Invalid ID' }), /plugin id/)
  assert.throws(() => normalizePluginManifest({ ...valid, version: 'latest' }), /valid semver/)
  assert.throws(() => normalizePluginManifest({ ...valid, requires: ['valid-plugin'] }), /cannot require itself/)
  assert.throws(() => normalizePluginManifest({ ...valid, requires: ['base', 'base'] }), /must not contain duplicates/)
  assert.throws(() => normalizePluginManifest({ ...valid, contributes: [''] }), /non-empty strings/)
})

test('shared plugin manifests snapshot versioned permissions, config, state, integrity, and dependency contracts', () => {
  const configSchema = {
    type: 'object',
    properties: {
      endpoint: { type: 'string' },
    },
    additionalProperties: false,
  }
  const normalized = normalizePluginManifest({
    id: 'contract-plugin',
    name: 'Contract plugin',
    version: '2.3.4',
    apiVersion: '1.0.0',
    hostVersion: '>=0.11.0 <1.0.0',
    requires: ['base-plugin'],
    dependencyVersions: { 'base-plugin': '^2.0.0' },
    permissions: ['storage.read', 'network:model-provider'],
    configSchema,
    stateSchemaVersion: 3,
    integrity: `sha256-${'a'.repeat(64)}`,
  })

  configSchema.properties.endpoint.type = 'number'
  assert.deepEqual(normalized.permissions, ['storage.read', 'network:model-provider'])
  assert.equal(normalized.configSchema.properties.endpoint.type, 'string')
  assert.deepEqual(normalized.dependencyVersions, { 'base-plugin': '^2.0.0' })
  assert.equal(normalized.stateSchemaVersion, 3)
  assert.equal(Object.isFrozen(normalized.configSchema), true)
  assert.equal(Object.isFrozen(normalized.configSchema.properties), true)
  assert.equal(Object.isFrozen(normalized.dependencyVersions), true)
})

test('shared plugin manifests reject unsafe or inconsistent contract metadata', () => {
  const valid = { id: 'contract-plugin', name: 'Contract plugin', version: '1.0.0' }
  assert.throws(() => normalizePluginManifest({ ...valid, apiVersion: 'v1' }), /apiVersion/)
  assert.throws(() => normalizePluginManifest({ ...valid, hostVersion: 'latest' }), /hostVersion/)
  assert.throws(() => normalizePluginManifest({ ...valid, permissions: ['File System'] }), /permissions/)
  assert.throws(() => normalizePluginManifest({ ...valid, stateSchemaVersion: 0 }), /stateSchemaVersion/)
  assert.throws(() => normalizePluginManifest({ ...valid, integrity: 'sha256-not-a-digest' }), /integrity/)
  assert.throws(() => normalizePluginManifest({
    ...valid,
    dependencyVersions: { undeclared: '^1.0.0' },
  }), /undeclared dependency/)

  let getterCalls = 0
  const configSchema = {}
  Object.defineProperty(configSchema, 'type', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'object'
    },
  })
  assert.throws(
    () => normalizePluginManifest({ ...valid, configSchema }),
    (error) => error?.code === 'PLUGIN_MANIFEST_DEFINITION_INVALID',
  )
  assert.equal(getterCalls, 0)
})

test('shared plugin manifests reject own accessors without invoking them', () => {
  const fields = ['id', 'name', 'version', 'requires', 'contributes']
  for (const field of fields) {
    let getterCalls = 0
    const input = {
      id: 'accessor-manifest',
      name: 'Accessor manifest',
      version: '1.0.0',
    }
    Object.defineProperty(input, field, {
      enumerable: true,
      get() {
        getterCalls += 1
        return field === 'id'
          ? 'accessor-manifest'
          : field === 'name'
            ? 'Accessor manifest'
            : field === 'version'
              ? '1.0.0'
              : []
      },
    })
    assert.throws(
      () => normalizePluginManifest(input),
      (error) => error?.code === 'PLUGIN_MANIFEST_DEFINITION_INVALID'
        && error?.retryable === false
        && new RegExp(`manifest\\.${field}`).test(error?.message || ''),
    )
    assert.equal(getterCalls, 0)
  }
})

test('shared plugin manifests reject inherited required fields and ignore inherited optional fields', () => {
  const inheritedRequired = Object.create({
    id: 'inherited-manifest',
    name: 'Inherited manifest',
    version: '1.0.0',
  })
  assert.throws(
    () => normalizePluginManifest(inheritedRequired),
    (error) => error?.code === 'PLUGIN_MANIFEST_DEFINITION_INVALID'
      && /manifest\.id/.test(error?.message || ''),
  )

  const inheritedOptional = Object.create({
    requires: ['forged-dependency'],
    contributes: ['tool:forged'],
  })
  Object.assign(inheritedOptional, {
    id: 'own-manifest',
    name: 'Own manifest',
    version: '1.0.0',
  })
  assert.deepEqual(normalizePluginManifest(inheritedOptional), {
    id: 'own-manifest',
    name: 'Own manifest',
    version: '1.0.0',
    requires: [],
    contributes: [],
  })
})

test('shared plugin manifest arrays reject accessors and sparse prototype values without invoking them', () => {
  let getterCalls = 0
  const accessorRequires = []
  Object.defineProperty(accessorRequires, 0, {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'base-plugin'
    },
  })
  assert.throws(
    () => normalizePluginManifest({
      id: 'array-accessor-manifest',
      name: 'Array accessor manifest',
      version: '1.0.0',
      requires: accessorRequires,
    }),
    (error) => error?.code === 'PLUGIN_MANIFEST_DEFINITION_INVALID'
      && /requires\[0\]/.test(error?.message || ''),
  )
  assert.equal(getterCalls, 0)

  const sparseContributes = []
  sparseContributes.length = 1
  const inherited = Object.create(Array.prototype)
  inherited[0] = 'tool:forged'
  Object.setPrototypeOf(sparseContributes, inherited)
  assert.throws(
    () => normalizePluginManifest({
      id: 'sparse-manifest',
      name: 'Sparse manifest',
      version: '1.0.0',
      contributes: sparseContributes,
    }),
    (error) => error?.code === 'PLUGIN_MANIFEST_DEFINITION_INVALID'
      && /contributes\[0\]/.test(error?.message || ''),
  )
})

test('shared plugin manifests are descriptor snapshots independent of later input mutation', () => {
  let propertyReads = 0
  let descriptorReads = 0
  const requires = ['base-plugin']
  const contributes = ['tool:example']
  const target = {
    id: 'descriptor-snapshot',
    name: 'Descriptor snapshot',
    version: '1.2.3',
    requires,
    contributes,
  }
  const input = new Proxy(target, {
    get(object, key, receiver) {
      propertyReads += 1
      return Reflect.get(object, key, receiver)
    },
    getOwnPropertyDescriptor(object, key) {
      descriptorReads += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })

  const normalized = normalizePluginManifest(input)
  const readsAfterNormalization = descriptorReads
  target.id = 'mutated-manifest'
  requires[0] = 'mutated-base'
  contributes[0] = 'tool:mutated'

  assert.equal(propertyReads, 0)
  assert.ok(readsAfterNormalization >= 5)
  assert.deepEqual(normalized, {
    id: 'descriptor-snapshot',
    name: 'Descriptor snapshot',
    version: '1.2.3',
    requires: ['base-plugin'],
    contributes: ['tool:example'],
  })
  assert.equal(descriptorReads, readsAfterNormalization)
})

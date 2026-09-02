import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRuntimePluginAuditRuntime,
  createRuntimePluginRecordFactory,
  normalizeRuntimePluginId,
} from '../server/plugins/runtimePluginRegistrySupport.js'

test('runtime plugin IDs normalize without executing object coercion', () => {
  assert.equal(normalizeRuntimePluginId('  example  '), 'example')
  assert.equal(normalizeRuntimePluginId(null), '')
  assert.equal(normalizeRuntimePluginId({
    toString() {
      throw new Error('must not execute')
    },
  }), '')
})

test('runtime plugin records keep monotonic registry-local sequence and isolated effects', () => {
  const createRecord = createRuntimePluginRecordFactory()
  const input = {
    manifest: Object.freeze({ id: 'example' }),
    setup() {},
    configResolver: Object.freeze({}),
    configResolution: Object.freeze({ config: Object.freeze({}) }),
    configRevision: 1,
    state: 'installing',
    deferVisibility: false,
  }
  const first = createRecord(input)
  const second = createRecord(input)

  assert.equal(first.sequence, 1)
  assert.equal(second.sequence, 2)
  assert.notEqual(first.effects, second.effects)
  assert.notEqual(first.configHealthChecks, second.configHealthChecks)
  assert.equal(first.installedAt, null)
})

test('runtime plugin config audit stays bounded, immutable, and observer-safe', () => {
  let observed = 0
  const audit = createRuntimePluginAuditRuntime(() => {
    observed += 1
    if (observed === 1) throw new Error('observer failure')
  })

  for (let index = 0; index < 260; index += 1) {
    audit.emitConfigReloadAudit('plugin.config_reload', { index })
  }

  const snapshot = audit.listConfigReloadAudit()
  assert.equal(observed, 260)
  assert.equal(snapshot.length, 256)
  assert.equal(snapshot[0].index, 4)
  assert.equal(snapshot.at(-1).index, 259)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot[0]), true)
  assert.notEqual(snapshot, audit.listConfigReloadAudit())
})

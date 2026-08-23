import assert from 'node:assert/strict'
import test from 'node:test'

import { planRuntimePluginRestore } from '../server/plugins/runtimePluginRestorePlanner.js'

function state(pluginId) {
  return Object.freeze({ pluginId, enabled: true })
}

function resolver(manifests) {
  return (pluginId) => manifests[pluginId] || null
}

test('runtime plugin restore plan places transitive providers before consumers', () => {
  const states = [state('a-consumer'), state('m-middle'), state('z-provider')]
  const ordered = planRuntimePluginRestore(states, resolver({
    'a-consumer': { requires: ['m-middle'] },
    'm-middle': { requires: ['z-provider'] },
    'z-provider': { requires: [] },
  }))

  assert.deepEqual(ordered.map((entry) => entry.pluginId), [
    'z-provider',
    'm-middle',
    'a-consumer',
  ])
})

test('runtime plugin restore plan preserves deterministic order for unrelated and missing plugins', () => {
  const states = [
    state('a-consumer'),
    state('b-unrelated'),
    state('missing-plugin'),
    state('z-provider'),
  ]
  const ordered = planRuntimePluginRestore(states, resolver({
    'a-consumer': { requires: ['z-provider'] },
    'b-unrelated': { requires: [] },
    'z-provider': { requires: [] },
  }))

  assert.deepEqual(ordered.map((entry) => entry.pluginId), [
    'b-unrelated',
    'missing-plugin',
    'z-provider',
    'a-consumer',
  ])
})

test('runtime plugin restore plan terminates cycles without blocking independent plugins', () => {
  const states = [state('a-cycle'), state('b-cycle'), state('c-independent')]
  const ordered = planRuntimePluginRestore(states, resolver({
    'a-cycle': { requires: ['b-cycle'] },
    'b-cycle': { requires: ['a-cycle'] },
    'c-independent': { requires: [] },
  }))

  assert.deepEqual(ordered.map((entry) => entry.pluginId), [
    'c-independent',
    'a-cycle',
    'b-cycle',
  ])
})

test('runtime plugin restore plan does not mutate state snapshots', () => {
  const states = Object.freeze([state('a-consumer'), state('z-provider')])
  const ordered = planRuntimePluginRestore(states, resolver({
    'a-consumer': { requires: ['z-provider'] },
    'z-provider': { requires: [] },
  }))

  assert.notEqual(ordered, states)
  assert.deepEqual(states.map((entry) => entry.pluginId), ['a-consumer', 'z-provider'])
})

test('runtime plugin restore plan rejects empty and duplicate plugin ids', () => {
  assert.throws(
    () => planRuntimePluginRestore([{ pluginId: '' }], () => null),
    /invalid pluginId/,
  )
  assert.throws(
    () => planRuntimePluginRestore([state('same'), state('same')], () => null),
    /duplicate pluginId/,
  )
})

test('runtime plugin restore plan isolates resolver and malformed dependency failures', () => {
  const states = [state('resolver-fails'), state('malformed'), state('independent')]
  const ordered = planRuntimePluginRestore(states, (pluginId) => {
    if (pluginId === 'resolver-fails') {
      const error = new Error('release snapshot is corrupt')
      error.code = 'PLUGIN_RELEASE_CORRUPT'
      throw error
    }
    if (pluginId === 'malformed') return { requires: 'not-an-array' }
    return { requires: [] }
  })

  assert.deepEqual(ordered.map((entry) => entry.pluginId), [
    'resolver-fails',
    'malformed',
    'independent',
  ])
  assert.equal(ordered[0].resolutionError.code, 'PLUGIN_RELEASE_CORRUPT')
  assert.equal(ordered[1].resolutionError.code, 'PLUGIN_RESTORE_DEPENDENCIES_INVALID')
  assert.equal(ordered[2].resolutionError, null)
  assert.deepEqual(ordered.map((entry) => entry.state), states)
})

test('runtime plugin restore plan identifies cycles and their blocked downstream consumers', () => {
  const ordered = planRuntimePluginRestore([
    state('downstream'),
    state('cycle-a'),
    state('cycle-b'),
    state('independent'),
  ], resolver({
    downstream: { requires: ['cycle-a'] },
    'cycle-a': { requires: ['cycle-b'] },
    'cycle-b': { requires: ['cycle-a'] },
    independent: { requires: [] },
  }))
  const byId = new Map(ordered.map((entry) => [entry.pluginId, entry]))

  assert.deepEqual(byId.get('cycle-a').cycleMembers, ['cycle-a', 'cycle-b'])
  assert.deepEqual(byId.get('cycle-b').cycleMembers, ['cycle-a', 'cycle-b'])
  assert.deepEqual(byId.get('downstream').cycleMembers, [])
  assert.deepEqual(byId.get('downstream').blockedByCycle, ['cycle-a', 'cycle-b'])
  assert.deepEqual(byId.get('independent').blockedByCycle, [])
})

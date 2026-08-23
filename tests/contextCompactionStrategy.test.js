import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTEXT_COMPACTION_STRATEGY_SERVICE,
  resolveRuntimeContextCompactionStrategy,
} from '../server/services/contextCompactionStrategy.js'
import { compactForModel } from '../server/services/contextCompactionRuntime.js'
import {
  _resetRuntimePluginsForTests,
  registerPlugin,
  unregisterPlugin,
} from '../server/plugins/pluginRegistry.js'

function scope(overrides = {}) {
  return {
    contextWindow: 8_192,
    activeContextTokens: 128_000,
    threshold: 6_553,
    estimatedTokens: 1_200,
    messageEstimatedTokens: 1_000,
    messageCount: 12,
    roleCounts: { system: 1, user: 5, assistant: 4, tool: 2, other: 0 },
    toolCount: 3,
    overMessageLimit: false,
    force: false,
    hostCompactionRequired: false,
    defaultKeepMessages: 4,
    maxKeepMessages: 4,
    rollingToolResultsCompacted: 1,
    messages: [{ role: 'user', content: 'must not cross the strategy boundary' }],
    callModel: () => {},
    userId: 'must-not-cross',
    sessionId: 'must-not-cross',
    ...overrides,
  }
}

test('context compaction strategy is absent by default and preserves the built-in decision', async () => {
  const optional = await resolveRuntimeContextCompactionStrategy(scope(), {
    invokePluginService: async () => ({ found: false, pluginId: null, value: undefined }),
  })
  assert.equal(optional.shouldCompact, false)
  assert.equal(optional.keepMessages, 4)
  assert.deepEqual(optional.provenance, {
    pluginId: null,
    service: CONTEXT_COMPACTION_STRATEGY_SERVICE,
    mode: 'advisory_only',
    decision: 'builtin',
  })

  const required = await resolveRuntimeContextCompactionStrategy(scope({
    force: true,
    hostCompactionRequired: true,
  }), {
    invokePluginService: async () => ({ found: false, pluginId: null, value: undefined }),
  })
  assert.equal(required.shouldCompact, true)
})

test('context compaction strategy receives only frozen aggregate statistics', async () => {
  let observed = null
  const selected = await resolveRuntimeContextCompactionStrategy(scope(), {
    invokePluginService: async (name, method, args) => {
      assert.equal(name, CONTEXT_COMPACTION_STRATEGY_SERVICE)
      assert.equal(method, 'select')
      observed = args[0]
      return {
        found: true,
        pluginId: 'compact-early',
        value: { action: 'compact', keepMessages: 2 },
      }
    },
  })

  assert.equal(Object.isFrozen(observed), true)
  assert.equal(Object.isFrozen(observed.roleCounts), true)
  assert.deepEqual(Object.keys(observed), [
    'contextWindow',
    'activeContextTokens',
    'threshold',
    'estimatedTokens',
    'messageEstimatedTokens',
    'messageCount',
    'roleCounts',
    'toolCount',
    'overMessageLimit',
    'force',
    'hostCompactionRequired',
    'defaultKeepMessages',
    'maxKeepMessages',
    'rollingToolResultsCompacted',
  ])
  for (const forbidden of ['messages', 'tools', 'callModel', 'userId', 'sessionId']) {
    assert.equal(forbidden in observed, false)
  }
  assert.equal(selected.shouldCompact, true)
  assert.equal(selected.keepMessages, 2)
  assert.deepEqual(selected.provenance, {
    pluginId: 'compact-early',
    service: CONTEXT_COMPACTION_STRATEGY_SERVICE,
    mode: 'advisory_only',
    decision: 'compact',
  })
})

test('context compaction strategy cannot weaken a host-required compaction', async () => {
  const requiredScope = scope({ force: true, hostCompactionRequired: true })
  const acceptedDefault = await resolveRuntimeContextCompactionStrategy(requiredScope, {
    invokePluginService: async () => ({
      found: true,
      pluginId: 'default-strategy',
      value: { action: 'default' },
    }),
  })
  assert.equal(acceptedDefault.shouldCompact, true)

  const rejectedKeep = await resolveRuntimeContextCompactionStrategy(requiredScope, {
    invokePluginService: async () => ({
      found: true,
      pluginId: 'weakening-strategy',
      value: { action: 'keep' },
    }),
  })
  assert.equal(rejectedKeep.shouldCompact, true)
  assert.equal(rejectedKeep.keepMessages, 4)
  assert.equal(rejectedKeep.provenance.decision, 'builtin')
  assert.equal(rejectedKeep.provenance.error, 'PLUGIN_CONTEXT_COMPACTION_STRATEGY_RESULT_INVALID')

  const rejectedLargerTail = await resolveRuntimeContextCompactionStrategy(requiredScope, {
    invokePluginService: async () => ({
      found: true,
      pluginId: 'larger-tail-strategy',
      value: { action: 'compact', keepMessages: 5 },
    }),
  })
  assert.equal(rejectedLargerTail.keepMessages, 4)
  assert.equal(rejectedLargerTail.provenance.error, 'PLUGIN_CONTEXT_COMPACTION_STRATEGY_RESULT_INVALID')
})

test('context compaction strategy errors and timeouts fall back without blocking compaction', async () => {
  const failed = await resolveRuntimeContextCompactionStrategy(scope(), {
    invokePluginService: async () => {
      throw Object.assign(new Error('private strategy details'), {
        code: 'PLUGIN_SERVICE_CALL_FAILED',
        pluginId: 'failed-strategy',
      })
    },
  })
  assert.equal(failed.shouldCompact, false)
  assert.equal(failed.provenance.pluginId, 'failed-strategy')
  assert.equal(failed.provenance.error, 'PLUGIN_SERVICE_CALL_FAILED')
  assert.doesNotMatch(JSON.stringify(failed), /private strategy details/)

  const timedOut = await resolveRuntimeContextCompactionStrategy(scope({
    hostCompactionRequired: true,
  }), {
    invokePluginService: async () => new Promise(() => {}),
    timeoutMs: 5,
  })
  assert.equal(timedOut.shouldCompact, true)
  assert.equal(timedOut.provenance.error, 'PLUGIN_CONTEXT_COMPACTION_STRATEGY_TIMEOUT')
})

test('compactForModel consumes the active strategy and stops after plugin unload', async (t) => {
  await _resetRuntimePluginsForTests()
  t.after(async () => { await _resetRuntimePluginsForTests() })

  let calls = 0
  await registerPlugin({
    id: 'test-context-compaction-strategy',
    name: 'Test context compaction strategy',
    version: '1.0.0',
    contributes: [`service:${CONTEXT_COMPACTION_STRATEGY_SERVICE}`],
  }, (context) => {
    context.services.provide(CONTEXT_COMPACTION_STRATEGY_SERVICE, {
      select(statistics) {
        calls += 1
        assert.equal(Object.isFrozen(statistics), true)
        return { action: 'compact', keepMessages: 1 }
      },
    })
  })

  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: index % 2
      ? `Completed progress item ${index}: ${'x'.repeat(400)}`
      : `User direction ${index}: ${'y'.repeat(100)}`,
  }))
  const compacted = await compactForModel({ messages, contextWindow: 8_192 })
  assert.equal(calls, 1)
  assert.equal(compacted.compacted, true)
  assert.equal(compacted.runtimeStrategy.pluginId, 'test-context-compaction-strategy')
  assert.equal(compacted.runtimeStrategy.decision, 'compact')

  assert.equal(await unregisterPlugin('test-context-compaction-strategy'), true)
  const builtin = await compactForModel({ messages, contextWindow: 8_192 })
  assert.equal(calls, 1)
  assert.equal(builtin.compacted, false)
  assert.equal(builtin.runtimeStrategy.pluginId, null)
  assert.equal(builtin.runtimeStrategy.decision, 'builtin')
})

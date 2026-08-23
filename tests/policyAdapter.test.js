import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyWithPolicyAdapter,
  createBuiltinApprovalPolicyAdapter,
  POLICY_ADAPTER_CONTRACT_VERSION,
  POLICY_DECISIONS,
  validatePolicyAdapter,
} from '../server/core/policyAdapter.js'
import { createRuntimeCapabilityRegistry } from '../server/core/runtimeCapabilityRegistry.js'
import {
  acquireRuntimePolicy,
  activateRuntimePolicy,
  getActiveRuntimePolicyProvenance,
  releaseRuntimePolicy,
  replaceRuntimeCapabilitySnapshot,
} from '../server/core/runtimeCapabilityState.js'

function adapter(classify) {
  return Object.freeze({ contractVersion: POLICY_ADAPTER_CONTRACT_VERSION, classify })
}

function classifyRequest(toolName = 'read_file') {
  return { toolName, args: { path: 'README.md' }, options: { origin: 'job' } }
}

test('policy adapter contract captures an own synchronous classifier and uses closed decisions', () => {
  assert.deepEqual(POLICY_DECISIONS, ['allow', 'ask', 'deny'])
  const source = {
    contractVersion: POLICY_ADAPTER_CONTRACT_VERSION,
    classify: () => ({ decision: 'ask', risk: 'medium', reason: 'review' }),
  }
  const captured = validatePolicyAdapter(source)
  source.classify = () => ({ decision: 'allow' })
  assert.deepEqual(classifyWithPolicyAdapter(captured, classifyRequest()), {
    decision: 'ask',
    risk: 'medium',
    reason: 'review',
  })
  assert.throws(
    () => validatePolicyAdapter({ classify: () => ({ decision: 'allow' }) }),
    (error) => error?.code === 'RUNTIME_POLICY_ADAPTER_INVALID',
  )
  assert.throws(
    () => validatePolicyAdapter({
      contractVersion: POLICY_ADAPTER_CONTRACT_VERSION + 1,
      classify: () => ({ decision: 'allow' }),
    }),
    (error) => error?.code === 'RUNTIME_POLICY_CONTRACT_UNSUPPORTED',
  )
})

test('missing, thrown, async, timed out, and invalid policy evaluations all fail closed', () => {
  const cases = [
    [null, {}, 'RUNTIME_POLICY_BINDING_MISSING'],
    [adapter(() => { throw new Error('secret plugin failure') }), {}, 'RUNTIME_POLICY_EXECUTION_FAILED'],
    [adapter(() => Promise.resolve({ decision: 'allow' })), {}, 'RUNTIME_POLICY_ASYNC_UNSUPPORTED'],
    [adapter(() => ({ decision: 'pass' })), {}, 'RUNTIME_POLICY_RESULT_INVALID'],
    [adapter(() => ({ decision: 'allow', extraAuthority: true })), {}, 'RUNTIME_POLICY_RESULT_INVALID'],
    [adapter(() => ({ decision: 'allow' })), {
      timeoutMs: 5_000,
      now: (() => {
        const values = [0, 5_001]
        return () => values.shift()
      })(),
    }, 'RUNTIME_POLICY_TIMEOUT'],
  ]
  for (const [candidate, options, code] of cases) {
    const result = classifyWithPolicyAdapter(candidate, classifyRequest(), options)
    assert.equal(result.decision, 'deny')
    assert.equal(result.risk, 'high')
    assert.equal(result.failure.code, code)
    assert.doesNotMatch(result.reason, /secret plugin failure/u)
  }
})

test('builtin approval policy maps legacy verdicts to the versioned vocabulary', () => {
  const builtin = createBuiltinApprovalPolicyAdapter((toolName) => {
    if (toolName === 'deny') return { denied: true, risk: 'high', reason: 'blocked' }
    if (toolName === 'ask') return { needsApproval: true, risk: 'medium', reason: 'review' }
    return { needsApproval: false, risk: 'low', reason: null, authorization: { kind: 'fixture' } }
  })
  assert.equal(classifyWithPolicyAdapter(builtin, classifyRequest('allow')).decision, 'allow')
  assert.equal(classifyWithPolicyAdapter(builtin, classifyRequest('ask')).decision, 'ask')
  assert.equal(classifyWithPolicyAdapter(builtin, classifyRequest('deny')).decision, 'deny')
  assert.equal(
    classifyWithPolicyAdapter(builtin, classifyRequest('allow')).authorization.kind,
    'fixture',
  )
})

test('runtime policy leases expose provenance and fence replacement, release, and host deactivation', () => {
  const registry = createRuntimeCapabilityRegistry()
  registry.register({
    id: 'builtin.policy',
    type: 'policy',
    owner: 'builtin',
    version: '1.0.0',
    revision: 1,
    priority: 0,
    implementation: adapter(() => ({ decision: 'allow', risk: 'low', reason: null })),
  })
  replaceRuntimeCapabilitySnapshot(registry.snapshot())
  const builtinLease = acquireRuntimePolicy()
  assert.deepEqual(builtinLease.provenance, {
    id: 'builtin.policy',
    owner: 'builtin',
    version: '1.0.0',
    revision: 1,
    releaseDigest: null,
    generation: 1,
    source: 'registry_default',
  })
  assert.equal(builtinLease.classify(classifyRequest()).decision, 'allow')

  const disposePlugin = registry.register({
    id: 'plugin.fixture.policy',
    type: 'policy',
    owner: 'fixture-plugin',
    version: '2.0.0',
    revision: 7,
    priority: 10,
    replaces: 'builtin.policy',
    releaseDigest: `sha256-${'a'.repeat(64)}`,
    implementation: adapter(() => ({ decision: 'ask', risk: 'medium', reason: 'fixture' })),
  })
  replaceRuntimeCapabilitySnapshot(registry.snapshot())
  assert.equal(builtinLease.classify(classifyRequest()).failure.code, 'RUNTIME_POLICY_BINDING_STALE')
  const pluginLease = acquireRuntimePolicy()
  assert.equal(pluginLease.provenance.id, 'plugin.fixture.policy')
  assert.equal(pluginLease.provenance.revision, 7)
  assert.equal(pluginLease.provenance.releaseDigest, `sha256-${'a'.repeat(64)}`)
  assert.equal(getActiveRuntimePolicyProvenance().owner, 'fixture-plugin')
  assert.equal(pluginLease.classify(classifyRequest()).decision, 'ask')
  assert.equal(pluginLease.release(), true)
  assert.equal(pluginLease.release(), false)
  assert.equal(pluginLease.classify(classifyRequest()).failure.code, 'RUNTIME_POLICY_LEASE_RELEASED')

  disposePlugin()
  replaceRuntimeCapabilitySnapshot(registry.snapshot())
  assert.equal(acquireRuntimePolicy().classify(classifyRequest()).decision, 'allow')
  assert.equal(releaseRuntimePolicy(), true)
  assert.equal(acquireRuntimePolicy().classify(classifyRequest()).failure.code, 'RUNTIME_POLICY_BINDING_MISSING')
  assert.equal(activateRuntimePolicy()?.id, 'builtin.policy')
  replaceRuntimeCapabilitySnapshot(null)
})

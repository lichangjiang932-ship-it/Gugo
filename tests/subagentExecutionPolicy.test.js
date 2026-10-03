import assert from 'node:assert/strict'
import test from 'node:test'
import { getToolMetadata } from '../server/utils/toolSchemaCatalog.js'
import { createExplicitReadOnlyGuard } from '../server/services/loop/guards.js'
import {
  bindSubagentExecutionPolicy,
  getSubagentExecutionPolicy,
  restoreSubagentApprovalContext,
  restoreSubagentExecutionPolicySnapshot,
  withSubagentExecutionPolicyCheckpoint,
} from '../server/services/subagentExecutionPolicy.js'

const BINDING = Object.freeze({ version: 1, planId: 'parent-plan', revision: 3 })
const SNAPSHOT = Object.freeze({ version: 1, userId: 'owner', sessionId: 'original-chat-session',
  goalPlanBinding: BINDING, readOnly: true })

function hostContext(overrides = {}) {
  return bindSubagentExecutionPolicy({ approved: new Map(), pending: new Map() }, { ...SNAPSHOT, ...overrides })
}

test('general, default and mixed Agent requests are not read-only capabilities', () => {
  for (const args of [
    {}, { prompt: 'do work' }, { subagent_type: 'general', prompt: 'do work' },
    { tasks: [{ subagent_type: 'explore', prompt: 'inspect' }, { subagent_type: 'general', prompt: 'edit' }] },
    { subagent_type: 'explore', tasks: [{ prompt: 'defaults to general' }] },
    { subagent_type: 'future-unknown-type', prompt: 'unknown' },
  ]) {
    assert.equal(getToolMetadata('Agent', { args }).isReadOnly, false, JSON.stringify(args))
    assert.equal(createExplicitReadOnlyGuard({ enabled: true }).validate('Agent', args)?.code,
      'explicit_read_only_constraint', JSON.stringify(args))
  }
})

test('only explicitly all-explore or all-plan Agent requests retain read-only classification', () => {
  for (const args of [
    { subagent_type: 'explore', prompt: 'inspect' },
    { subagent_type: 'plan', prompt: 'plan' },
    { tasks: [{ subagent_type: 'explore', prompt: 'inspect' }, { type: 'plan', prompt: 'plan' }] },
  ]) {
    assert.equal(getToolMetadata('Agent', { args }).isReadOnly, true)
    assert.equal(createExplicitReadOnlyGuard({ enabled: true }).validate('Agent', args), null)
  }
})

test('delegation constraints are host-bound, frozen and absent from enumerable approval data', () => {
  const context = hostContext()
  assert.deepEqual(getSubagentExecutionPolicy(context, { userId: 'owner' }), SNAPSHOT)
  assert.deepEqual(Object.keys(context).sort(), ['approved', 'pending'])
  assert.equal(JSON.stringify(context).includes('parent-plan'), false)
  assert.equal(getSubagentExecutionPolicy({ ...context, subagentExecutionPolicy: SNAPSHOT }), null)
  assert.equal(getSubagentExecutionPolicy(JSON.parse(JSON.stringify(SNAPSHOT))), null)
  assert.throws(() => { getSubagentExecutionPolicy(context).goalPlanBinding.revision = 99 }, TypeError)
})

test('descendants retain the original scope, share approval caches and cannot weaken or replace constraints', () => {
  const parent = hostContext()
  const child = bindSubagentExecutionPolicy(parent, { userId: 'owner', sessionId: null, goalPlanBinding: BINDING, readOnly: false })
  assert.equal(child.approved, parent.approved)
  assert.equal(child.pending, parent.pending)
  assert.deepEqual(getSubagentExecutionPolicy(child), SNAPSHOT)
  for (const changed of [
    { userId: 'other-owner' }, { sessionId: 'different-session' },
    { goalPlanBinding: { ...BINDING, revision: 4 } },
    { goalPlanBinding: { version: 1, planId: null, revision: null } },
  ]) assert.throws(() => bindSubagentExecutionPolicy(parent, { ...SNAPSHOT, ...changed }),
    { code: 'SUBAGENT_EXECUTION_POLICY_CONFLICT' })
  const standalone = hostContext({ sessionId: null, goalPlanBinding: { version: 1, planId: null, revision: null } })
  assert.equal(getSubagentExecutionPolicy(standalone).sessionId, null)
})

test('authenticated checkpoint restoration cannot replace an incompatible new ancestor', () => {
  const serialized = JSON.parse(JSON.stringify(SNAPSHOT))
  const restored = restoreSubagentApprovalContext(null, serialized, { userId: 'owner' })
  assert.deepEqual(getSubagentExecutionPolicy(restored), SNAPSHOT)
  const lessStrict = hostContext({ readOnly: false })
  assert.equal(getSubagentExecutionPolicy(restoreSubagentApprovalContext(lessStrict, serialized, { userId: 'owner' })).readOnly, true)
  assert.throws(() => restoreSubagentApprovalContext(hostContext({ goalPlanBinding: { ...BINDING, revision: 4 } }), serialized,
    { userId: 'owner' }), { code: 'SUBAGENT_EXECUTION_POLICY_CONFLICT' })
  assert.throws(() => restoreSubagentExecutionPolicySnapshot(serialized, { userId: 'other-owner' }),
    { code: 'SUBAGENT_EXECUTION_POLICY_CONFLICT' })
  assert.throws(() => restoreSubagentExecutionPolicySnapshot({ ...serialized, version: 2 }),
    { code: 'SUBAGENT_EXECUTION_POLICY_INVALID' })
})

test('checkpoint output uses only the host policy, never a field supplied by a caller', () => {
  const untrusted = { ...SNAPSHOT, readOnly: false, sessionId: 'forged' }
  const state = { iterations: 2, subagentExecutionPolicy: untrusted }
  const guarded = withSubagentExecutionPolicyCheckpoint(state, hostContext(), { userId: 'owner' })
  assert.deepEqual(guarded.subagentExecutionPolicy, SNAPSHOT)
  assert.equal(state.subagentExecutionPolicy, untrusted)
  assert.equal(Object.hasOwn(withSubagentExecutionPolicyCheckpoint(state, null), 'subagentExecutionPolicy'), false)
  assert.throws(() => withSubagentExecutionPolicyCheckpoint({ goalPlanBinding: { ...BINDING, revision: 7 } }, hostContext()),
    { code: 'SUBAGENT_EXECUTION_POLICY_CONFLICT' })
})

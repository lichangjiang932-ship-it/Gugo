import assert from 'node:assert/strict'
import test from 'node:test'
import { replaceRuntimeCapabilityBlock } from '../server/services/runtimeCapabilities.js'
import { fingerprintModelRequest } from '../server/services/loop/modelInvocationCheckpoint.js'
import { withAssistantCommunicationPolicy } from '../shared/assistantCommunicationPolicy.js'

test('capability refresh preserves the position before later system policies and the exact request fingerprint', () => {
  const user = { role: 'user', content: 'Continue the same task.' }
  const options = { toolSpecs: [], approvalMode: 'normal' }
  const original = withAssistantCommunicationPolicy(replaceRuntimeCapabilityBlock([
    { role: 'system', content: 'Preserve authorization boundaries.' }, user,
  ], options))
  const snapshot = structuredClone(original)
  const refreshed = replaceRuntimeCapabilityBlock(original, options)
  assert.deepEqual(refreshed, original)
  assert.deepEqual(replaceRuntimeCapabilityBlock(refreshed, options), original)
  assert.equal(fingerprintModelRequest({ messages: refreshed }), fingerprintModelRequest({ messages: original }))
  assert.deepEqual(original, snapshot)
  assert.equal(refreshed.at(-1), user)
})

test('real capability changes still change the request fingerprint', () => {
  const original = replaceRuntimeCapabilityBlock([{ role: 'user', content: 'Continue.' }], { approvalMode: 'plan' })
  const changed = replaceRuntimeCapabilityBlock(original, { approvalMode: 'bypass' })
  assert.notEqual(fingerprintModelRequest({ messages: changed }), fingerprintModelRequest({ messages: original }))
})

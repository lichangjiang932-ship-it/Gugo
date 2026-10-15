import assert from 'node:assert/strict'
import test from 'node:test'
import { compareModelWireDiagnostics } from '../shared/modelWireDiagnostics.js'
import { cachedBuild, clearPromptCompilerCache } from '../server/services/promptCompilerCache.js'
import { compilerReuse } from '../shared/promptCompilerDiagnostics.js'
const wire = (changes = {}) => ({ version: 1, stage: 'wire', comparisonScope: 'same_owner_endpoint_model_config', prefixKind: 'leading_instructions',
  available: true, truncated: false, bodyBytes: 100, identityComparable: true, prefixBlocks: 1, messageCount: 2, toolCount: 0,
  ownerScopeFingerprint: 'a'.repeat(64), endpointFingerprint: 'b'.repeat(64), modelFingerprint: 'c'.repeat(64), configFingerprint: 'd'.repeat(64),
  bodyFingerprint: 'e'.repeat(64), prefixFingerprint: 'f'.repeat(64), toolsFingerprint: '0'.repeat(64), ...changes })
test('cross-turn comparison requires complete matching identity and never mistakes missing tool hashes for equal tools', () => {
  assert.equal(compareModelWireDiagnostics(wire(), wire()).prefixChanged, false)
  for (const key of ['ownerScopeFingerprint', 'endpointFingerprint', 'modelFingerprint', 'configFingerprint']) {
    assert.equal(compareModelWireDiagnostics(wire(), wire({ [key]: '9'.repeat(64) })).prefixComparable, false)
  }
  assert.equal(compareModelWireDiagnostics(wire(), wire({ toolsFingerprint: null })).toolsChanged, null)
  assert.equal(compareModelWireDiagnostics(wire(), wire({ truncated: true })).prefixComparable, false)
  assert.equal(compareModelWireDiagnostics(wire(), {}).prefixComparable, false)
})
test('compiler observations belong to each returned block, not global counter differences', async () => {
  clearPromptCompilerCache()
  const outputs = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => cachedBuild('identity', { owner: index % 2 }, {}, () => 'PRIVATE_TEXT'))))
  assert.equal(outputs.filter(output => output.cacheObservation === 'miss').length, 2)
  assert.equal(outputs.filter(output => output.cacheObservation === 'hit').length, 18)
  assert.ok(Object.values(compilerReuse('checkpoint_reuse').blocks).every(value => value === 'not_observed'))
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROMPT_PREFIX_SCHEMA_VERSION,
  comparePromptPrefixes,
  describeRuntimePrompt,
  fingerprintPromptBlocks,
} from '../server/services/promptPrefixFingerprint.js'

const STABLE = [
  { role: 'system', content: 'identity' },
  { role: 'system', content: 'ishiki' },
  { role: 'system', content: 'skills' },
  { role: 'system', content: 'instructions' },
]
const VOLATILE = [{ role: 'system', content: 'memory for this turn' }]

test('runtime diagnostics only fingerprint the contiguous explicitly stable system prefix', () => {
  const stable = STABLE.map((block) => ({ ...block, __gugoPromptStability: 'stable' }))
  for (const __gugoPromptStability of [undefined, 'volatile', 'unknown']) {
    const tail = { role: 'system', content: 'volatile context', __gugoPromptStability }
    const first = describeRuntimePrompt({ messages: [...stable, tail, ...stable] })
    const next = describeRuntimePrompt({ messages: [...stable, { ...tail, content: 'changed' }], previous: first.snapshot })
    assert.equal(first.diagnostics.stableBlockCount, 4)
    assert.equal(next.diagnostics.stablePrefixChanged, false)
    assert.notEqual(next.diagnostics.contextFingerprint, first.diagnostics.contextFingerprint)
    assert.equal(describeRuntimePrompt({ messages: [tail, ...stable] }).diagnostics.stablePrefixFingerprint, null)
  }
})

test('runtime comparison has a versioned within-turn boundary', () => {
  const first = describeRuntimePrompt({ messages: [{ ...STABLE[0], __gugoPromptStability: 'stable' }] })
  assert.equal(first.snapshot.version, 2)
  assert.equal(first.diagnostics.comparisonScope, 'within_turn')
  const next = describeRuntimePrompt({ previous: { ...first.snapshot, version: 1 } })
  assert.equal(next.diagnostics.prefixComparable, false)
  assert.equal(next.diagnostics.toolsChanged, null)
})

test('the stable prefix fingerprint ignores volatile tail changes', () => {
  const first = fingerprintPromptBlocks({ blocks: [...STABLE, ...VOLATILE], stableBlocks: STABLE })
  const second = fingerprintPromptBlocks({
    blocks: [...STABLE, { role: 'system', content: 'different memory entirely' }],
    stableBlocks: STABLE,
  })
  assert.equal(first.stablePrefixFingerprint, second.stablePrefixFingerprint)
  assert.notEqual(first.fullFingerprint, second.fullFingerprint)
  assert.equal(first.stableBlockCount, 4)
  assert.equal(first.blockCount, 5)
  assert.equal(first.version, PROMPT_PREFIX_SCHEMA_VERSION)
  assert.match(first.stablePrefixFingerprint, /^[a-f0-9]{64}$/u)

  const verdict = comparePromptPrefixes(first, second)
  assert.equal(verdict.comparable, true)
  assert.equal(verdict.stable, true)
  assert.equal(verdict.changed, true)
})

test('a stable block change is reported as an unstable prefix', () => {
  const before = fingerprintPromptBlocks({ blocks: [...STABLE], stableBlocks: STABLE })
  const after = fingerprintPromptBlocks({
    blocks: [...STABLE.slice(0, 3), { role: 'system', content: 'instructions v2' }],
    stableBlocks: STABLE,
  })
  const verdict = comparePromptPrefixes(before, after)
  assert.equal(verdict.stable, false)
  assert.equal(verdict.changed, true)
})

test('an unrendered stable block lowers the count instead of being ignored', () => {
  const full = fingerprintPromptBlocks({ blocks: [...STABLE, ...VOLATILE], stableBlocks: [...STABLE, null] })
  const missing = fingerprintPromptBlocks({
    blocks: [...STABLE.slice(0, 3), ...VOLATILE],
    stableBlocks: [...STABLE.slice(0, 3), null],
  })
  assert.equal(full.stableBlockCount, 4)
  assert.equal(missing.stableBlockCount, 3)
  // Different stable-block counts are not comparable: the prefix boundary moved.
  assert.equal(comparePromptPrefixes(full, missing).comparable, false)
  assert.equal(comparePromptPrefixes(full, missing).stable, null)
})

test('a prompt with no stable prefix is never reported as stable', () => {
  const noPrefix = fingerprintPromptBlocks({ blocks: [...VOLATILE], stableBlocks: [null] })
  assert.equal(noPrefix.stablePrefixFingerprint, null)
  assert.equal(noPrefix.stableBlockCount, 0)
  const verdict = comparePromptPrefixes(noPrefix, fingerprintPromptBlocks({ blocks: [...VOLATILE], stableBlocks: [null] }))
  assert.equal(verdict.comparable, false)
  assert.equal(verdict.stable, null)
  assert.equal(comparePromptPrefixes(null, noPrefix).comparable, false)
})

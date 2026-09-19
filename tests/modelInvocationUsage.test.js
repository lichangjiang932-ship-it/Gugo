import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeModelInvocationUsage } from '../server/services/loop/modelInvocationUsage.js'

test('completed usage receipts preserve explicit and legacy manual accounting semantics', () => {
  assert.deepEqual(normalizeModelInvocationUsage({}, 'completed'), { usageApplied: true })
  const manuallyRecovered = { reconciliation: { source: 'manual', outcome: 'completed' } }
  assert.deepEqual(normalizeModelInvocationUsage(manuallyRecovered, 'completed'), { usageApplied: false })
  for (const usageApplied of [true, false]) {
    assert.deepEqual(normalizeModelInvocationUsage({ ...manuallyRecovered, usageApplied }, 'completed'), { usageApplied })
  }
  for (const usageApplied of [undefined, null, 0, 'false']) {
    assert.equal(normalizeModelInvocationUsage({ usageApplied }, 'completed'), null)
  }
})

test('failed usage receipts require an atomic accounting stamp and never invent missing counts', () => {
  assert.deepEqual(normalizeModelInvocationUsage({}, 'failed'), {})
  const receipt = { failureUsage: { promptTokens: 17 }, failureUsageApplied: true }
  assert.deepEqual(normalizeModelInvocationUsage(receipt, 'failed'), receipt)
  assert.deepEqual(receipt.failureUsage, { promptTokens: 17 })
  for (const invalid of [
    { failureUsage: { promptTokens: 17 } },
    { failureUsageApplied: true },
    { ...receipt, failureUsageApplied: false },
    { ...receipt, failureUsage: {} },
    { ...receipt, failureUsage: { promptTokens: '' } },
  ]) assert.equal(normalizeModelInvocationUsage(invalid, 'failed'), null)
})

test('nonterminal and unsent usage fields cannot be promoted to a completed receipt', () => {
  for (const status of ['in_flight', 'not_sent']) {
    assert.deepEqual(normalizeModelInvocationUsage({ usageApplied: true, failureUsageApplied: true,
      failureUsage: { promptTokens: 99 } }, status), {})
  }
})

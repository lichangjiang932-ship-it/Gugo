import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MODEL_PROVIDER_NUMERIC_LIMITS,
  parseOptionalModelProviderInteger,
} from '../shared/modelProviderNumericConfig.js'

test('model Provider numeric fields preserve blank auto-detection and valid boundaries', () => {
  assert.deepEqual(parseOptionalModelProviderInteger('', 'contextWindow'), {
    valid: true,
    empty: true,
    value: null,
    reason: '',
    ...MODEL_PROVIDER_NUMERIC_LIMITS.contextWindow,
  })
  assert.equal(parseOptionalModelProviderInteger('1024', 'contextWindow').value, 1024)
  assert.equal(parseOptionalModelProviderInteger(1000, 'firstTokenTimeoutMs').value, 1000)
  assert.equal(parseOptionalModelProviderInteger('9007199254740991', 'idleTimeoutMs').value, Number.MAX_SAFE_INTEGER)
})

test('model Provider numeric fields reject coercion, fractions, unsafe integers, and low values', () => {
  for (const value of [true, {}, [], '1e3', '1024.5', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(parseOptionalModelProviderInteger(value, 'contextWindow').valid, false)
  }
  assert.equal(parseOptionalModelProviderInteger('1023', 'contextWindow').reason, 'min')
  assert.equal(parseOptionalModelProviderInteger(999, 'idleTimeoutMs').reason, 'min')
  assert.equal(parseOptionalModelProviderInteger('9007199254740992', 'firstTokenTimeoutMs').reason, 'safeInteger')
})

test('model Provider numeric parser rejects unknown fields instead of guessing limits', () => {
  assert.throws(
    () => parseOptionalModelProviderInteger(1, 'unknownField'),
    /Unknown model Provider numeric field/,
  )
})

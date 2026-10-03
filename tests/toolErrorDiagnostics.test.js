import assert from 'node:assert/strict'
import test from 'node:test'
import { executeToolWithRetry, normalizeToolError, normalizeToolResult } from '../server/utils/toolCallErrors.js'

test('legacy failure without a message retains failure metadata and uses a useful fallback', () => {
  const normalized = normalizeToolResult({ ok: false, exitCode: 129, path: 'file.txt' })
  assert.equal(normalized.ok, false)
  assert.equal(normalized.code, 'tool_execution_failed')
  assert.equal(normalized.error, 'Tool execution failed.')
  assert.equal(normalized.exitCode, 129)
  assert.equal(normalized.path, 'file.txt')
})

test('returned failures remove private diagnostics while preserving recovery and business fields', () => {
  const result = {
    ok: false, error: 'request failed', stack: 'private stack',
    diagnostic: { nested: 'private response' },
    requiresUserVerification: true, toolCallId: 'call-1', exitCode: 2,
    path: '/workspace/report.txt', requiredAccessMode: 'read_only',
    recovery: { state: 'unknown', receipts: [{ path: '/workspace/report.txt', sha256: 'abc' }],
      stack: 'nested private stack', apiKey: 'synthetic-private-value' },
    details: { reason: 'Bearer syntheticcredential0123456789' },
  }
  const normalized = normalizeToolResult(result)
  assert.equal(normalized.stack, undefined)
  assert.equal(normalized.diagnostic, undefined)
  assert.equal(normalized.recovery.stack, undefined)
  assert.equal(normalized.recovery.apiKey, '[REDACTED]')
  assert.equal(normalized.requiresUserVerification, true)
  assert.equal(normalized.retryable, false)
  assert.equal(normalized.toolCallId, 'call-1')
  assert.equal(normalized.exitCode, 2)
  assert.deepEqual(normalized.recovery.receipts, result.recovery.receipts)
  assert.doesNotMatch(normalized.details.reason, /syntheticcredential/)
  assert.equal(result.recovery.apiKey, 'synthetic-private-value')
})

test('returned failure cleaning handles cycles and ignores getters', () => {
  const result = { ok: false, error: 'failed', details: {} }
  result.details.self = result
  Object.defineProperty(result.details, 'privateValue', { enumerable: true, get() { throw new Error('getter must not execute') } })
  assert.doesNotThrow(() => JSON.stringify(normalizeToolResult(result)))
})

test('tool execution preserves returned failure without evaluating contract getters', async () => {
  for (const field of ['ok', 'requiresUserVerification']) {
    let reads = 0
    const result = { ok: false, error: 'original failure', code: 'original_code' }
    Object.defineProperty(result, field, { enumerable: true, get() { reads += 1; throw new Error('getter failure') } })
    const normalized = await executeToolWithRetry({ execute: async () => result, metadata: {} })
    assert.equal(reads, 0)
    assert.equal(normalized.error, 'original failure')
    assert.equal(normalized.code, 'original_code')
    assert.equal(normalized.ok, false)
  }
})

test('structured or empty thrown values are not stringified into misleading object diagnostics', () => {
  for (const error of [{}, { message: {} }, { message: ' ' }, Object.create(null), null, undefined]) {
    assert.equal(normalizeToolError(error, { fallbackMessage: 'Operation could not finish.' }).error,
      'Operation could not finish.')
  }
  assert.equal(normalizeToolError({ toString: () => { throw new Error('must not stringify arbitrary objects') } }).error,
    'Tool execution failed.')
})

test('real exception and string diagnostics still preserve redacted actionable text', () => {
  assert.equal(normalizeToolError(new Error('Choose an authorized directory.')).error, 'Choose an authorized directory.')
  assert.equal(normalizeToolError('Connection refused.').error, 'Connection refused.')
  const token = 'ghp_' + 'FixtureSecret1234567890'.repeat(2)
  assert.doesNotMatch(normalizeToolError(new Error(`Failed with token ${token}`)).error, /FixtureSecret/)
})

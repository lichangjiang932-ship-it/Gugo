import assert from 'node:assert/strict'
import test from 'node:test'
import { toolFailureFacts, toolFailureSummary } from '../src/lib/toolFailurePresentation.js'

test('tool failures reveal an observed actionable reason without dumping arguments', () => {
  assert.equal(toolFailureSummary({ status: 'error', result: JSON.stringify({
    ok: false, code: 'PPTX_CONTENT_OVERFLOW', error: 'slides[0].elements[4]: increase the text box height.',
  }), arguments: '{"private":"arguments"}' }), 'slides[0].elements[4]: increase the text box height.')
  assert.equal(toolFailureSummary({ status: 'error', error: 'Failed', errorHint: 'Use a taller frame.' }), 'Use a taller frame.')
  assert.equal(toolFailureSummary({ status: 'error', result: { error: { message: 'Invalid slide geometry.' } } }), 'Invalid slide geometry.')
  assert.equal(toolFailureSummary({ status: 'error', result: { stderr: 'SyntaxError: unexpected token\n    at internal.js:10' } }), 'SyntaxError: unexpected token')
})

test('failure summary is bounded and does not invent a diagnosis for successful or unknown calls', () => {
  for (const status of ['success', 'running', 'cancelled', undefined]) {
    assert.equal(toolFailureSummary({ status, error: 'Old error' }), '')
  }
  assert.equal(toolFailureSummary({ status: 'error', arguments: 'secret arguments' }), '')
  assert.equal(toolFailureSummary({ status: 'error', result: { ok: false, extra: 'unrelated' } }), '')
  assert.equal(toolFailureSummary({ status: 'error', error: 'x'.repeat(1000) }).length, 220)
  assert.equal(toolFailureSummary({ status: 'error', error: '\u001b[31mBad input\u001b[0m\nstack trace' }), 'Bad input')
})

test('error facts never manufacture HTTP 0 from missing status', () => {
  const t = () => 'Retryable'
  for (const value of [undefined, null, '', 0, 99, 600, 'NaN']) {
    assert.deepEqual(toolFailureFacts({ status: 'error', errorStatus: value }, t), [])
  }
  assert.deepEqual(toolFailureFacts({ status: 'error', errorCode: 'RATE_LIMIT', errorStatus: 429, attempts: 2, retryable: true }, t), [
    'RATE_LIMIT', 'HTTP 429', '2x', 'Retryable',
  ])
  assert.deepEqual(toolFailureFacts({ status: 'success', errorStatus: 500 }, t), [])
})

test('summary preserves bracketed diagnoses and redacts echoed credentials before truncation', () => {
  assert.equal(toolFailureSummary({ status: 'error', error: '[PPTX_CONTENT_OVERFLOW] Text does not fit.' }), '[PPTX_CONTENT_OVERFLOW] Text does not fit.')
  for (const error of [
    'Command failed: curl -H Authorization:Bearer_TEST_SECRET https://example.invalid',
    'Request failed: Bearer abcdefghijklmno',
    'Request failed: https://username:passwordvalue@example.invalid',
    'Request failed: api_key=private_value123',
    'Request failed: {"password":"private_value123"}',
    'Request failed: {"Authorization":"Basic private_value123"}',
    'Request failed: {"Proxy-Authorization":"Bearer private_value123"}',
  ]) {
    const summary = toolFailureSummary({ status: 'error', error })
    assert.match(summary, /REDACTED/)
    assert.doesNotMatch(summary, /Bearer_TEST_SECRET|abcdefghijklmno|passwordvalue|private_value123/)
  }
})

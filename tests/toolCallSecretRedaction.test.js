import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeToolError, redactSensitiveText } from '../server/utils/toolCallErrors.js'

test('explicit credential prefixes remain redacted in tool errors', () => {
  for (const token of [
    'sk-supersecret123456789',
    'ghp_abcdefghijklmnopqrstuv',
    'github_pat_abcdefghijklmnopqrstuv_123456',
    'github_pat_this-secret-must-never-persist',
    ['sk', 'live', 'abcdefghijklmnopqrstuv'].join('_'),
    ['sk', 'test', 'abcdefghijklmnopqrstuv'].join('_'),
  ]) {
    assert.equal(redactSensitiveText(token), '[REDACTED]')
    assert.equal(normalizeToolError(new Error('request failed: ' + token)).error, 'request failed: [REDACTED]')
  }
  assert.equal(redactSensitiveText('Bearer audit-token-123456'), 'Bearer [REDACTED]')
  for (const key of ['api_key', 'access_token', 'refresh_token', 'password', 'secret']) {
    assert.equal(redactSensitiveText(key + '=sensitive-fixture-value'), key + '=[REDACTED]')
  }
  assert.doesNotMatch(redactSensitiveText('https://example.test/?token=sensitive-fixture-value'), /sensitive-fixture-value/)
})

test('credential prefixes crossing the public diagnostic limit are redacted before truncation', () => {
  const prefix = 'x'.repeat(1983) + ' '
  const token = 'github_' + 'pat_' + 'a'.repeat(80)
  const error = normalizeToolError(new Error(prefix + token))
  assert.equal(error.error, prefix + '[REDACTED]')
  assert.equal(error.error.includes('github_'), false)
  assert.ok(error.error.length <= 2000)
})

test('legitimate skill codes, logical resource identifiers, and ordinary words are not credential prefixes', () => {
  for (const text of [
    'SKILL_RESOURCE_NOT_AUTHORIZED',
    'SKILL_RESOURCE_PATH_INVALID',
    'skill-resource:v1:resource-loop-fixture',
    'skills_with_documented_resources',
    'sketchbook_documentation',
  ]) assert.equal(redactSensitiveText(text), text)
  const error = normalizeToolError({
    code: 'SKILL_RESOURCE_NOT_AUTHORIZED',
    message: 'Cannot read skill-resource:v1:resource-loop-fixture.',
  })
  assert.equal(error.code, 'SKILL_RESOURCE_NOT_AUTHORIZED')
  assert.equal(error.error, 'Cannot read skill-resource:v1:resource-loop-fixture.')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseKeyValueLines, serializeKeyValueLines } from '../src/lib/mcpKeyValue.js'

test('MCP key-value text supports comments, equals in values, and stable serialization', () => {
  assert.deepEqual(parseKeyValueLines('# auth\nAuthorization=Bearer abc=123\nX_API_KEY = secret\n'), {
    Authorization: 'Bearer abc=123',
    X_API_KEY: 'secret',
  })
  assert.equal(serializeKeyValueLines({ X_API_KEY: 'secret', Authorization: 'Bearer abc=123' }), 'Authorization=Bearer abc=123\nX_API_KEY=secret')
})

test('MCP key-value text reports the invalid line', () => {
  assert.throws(
    () => parseKeyValueLines('GOOD=yes\nmissing-separator'),
    (error) => error.message === 'MCP_KEY_VALUE_LINE_INVALID' && error.line === 2,
  )
  assert.throws(
    () => parseKeyValueLines('bad key=value'),
    (error) => error.message === 'MCP_KEY_VALUE_KEY_INVALID' && error.line === 1,
  )
})

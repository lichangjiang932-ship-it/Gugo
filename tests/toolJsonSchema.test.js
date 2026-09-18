import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeToolCalls, parseToolArguments, validateToolCall } from '../server/utils/toolCallArguments.js'
import { validateToolSchemaDefinition } from '../server/utils/toolJsonSchema.js'

const spec = (schema) => [{ type: 'function', function: { name: 'schema_fixture', parameters: schema } }]
const check = (schema, args) => validateToolCall({ name: 'schema_fixture', args }, spec(schema))

test('JSON Schema union, const and allOf constraints fail closed', () => {
  const schema = { type: 'object', properties: {
    value: { type: ['integer', 'null'] }, mode: { const: 'read' }, count: { allOf: [{ type: 'integer' }, { minimum: 1 }] },
  }, required: ['value', 'mode', 'count'], additionalProperties: false }
  assert.equal(check(schema, { value: null, mode: 'read', count: 1 }), null)
  for (const args of [
    { value: 'unsafe', mode: 'read', count: 1 },
    { value: 1, mode: 'write', count: 1 },
    { value: 1, mode: 'read', count: 0 },
  ]) assert.equal(check(schema, args)?.code, 'tool_arguments_validation_failed')
})

test('local $ref enforces nested contracts in draft7 and draft2020-12', () => {
  for (const $schema of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
    const schema = { $schema, type: 'object', $defs: { choice: { type: 'integer', minimum: 1 } },
      properties: { value: { $ref: '#/$defs/choice' } }, required: ['value'] }
    assert.equal(check(schema, { value: 1 }), null)
    assert.equal(check(schema, { value: 0 })?.code, 'tool_arguments_validation_failed')
  }
})

test('array items after the old 200-item prefix are validated', () => {
  const schema = { type: 'object', properties: { values: { type: 'array', items: { type: 'integer', minimum: 0 } } } }
  const values = Array.from({ length: 201 }, () => 1)
  assert.equal(check(schema, { values }), null)
  values[200] = 'bad-last-item'
  assert.equal(check(schema, { values })?.code, 'tool_arguments_validation_failed')
})

test('deep schemas and values no longer silently skip validation after depth 12', () => {
  let schema = { type: 'integer', minimum: 1 }
  let value = 0
  for (let index = 0; index < 16; index += 1) {
    schema = { type: 'object', properties: { next: schema }, required: ['next'] }
    value = { next: value }
  }
  assert.equal(check(schema, value)?.code, 'tool_arguments_validation_failed')
})

test('schema-defined object enums compare structurally and uniqueItems rejects duplicates', () => {
  const schema = { type: 'object', properties: {
    mode: { enum: [{ kind: 'safe', enabled: true }] },
    values: { type: 'array', uniqueItems: true, items: { type: 'object' } },
  } }
  assert.equal(check(schema, { mode: { enabled: true, kind: 'safe' }, values: [{ a: 1 }, { a: 2 }] }), null)
  assert.equal(check(schema, { mode: { kind: 'safe', enabled: true }, values: [{ a: 1 }, { a: 1 }] })?.code, 'tool_arguments_validation_failed')
})

test('remote references, unknown validation keywords and recursive reference graphs are not ignored', () => {
  assert.equal(check({ type: 'object', properties: { value: { $ref: 'https://schema.invalid/private-schema' } } }, { value: 1 })?.code, 'tool_schema_unsupported')
  assert.equal(check({ type: 'object', minumum: 1 }, {})?.code, 'tool_schema_unsupported')
  assert.equal(check({ type: 'object', allOf: [{ $ref: '#' }] }, {})?.code, 'tool_schema_unsupported')
})

test('annotation metadata and x-extensions are accepted without weakening known constraints', () => {
  const schema = { type: 'object', 'x-owner-label': 'fixture', _meta: { source: 'mcp' },
    properties: { value: { type: 'integer', minimum: 1, examples: [1], description: 'value', 'x-widget': 'count' } } }
  assert.equal(check(schema, { value: 1 }), null)
  assert.equal(check(schema, { value: 0 })?.code, 'tool_arguments_validation_failed')
})

test('unsafe patterns are refused before applying them and diagnostics do not include values', () => {
  const schema = { type: 'object', properties: { token: { type: 'string', pattern: '(a+)+$' } } }
  const result = check(schema, { token: 'PRIVATE_ARGUMENT_SENTINEL' })
  assert.equal(result?.code, 'tool_schema_unsupported')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ARGUMENT_SENTINEL/u)
})

test('resource budgets reject large/deep/cyclic inputs instead of returning success', () => {
  const schema = { type: 'object' }
  let next = {}
  for (let index = 0; index < 100; index += 1) next = { next }
  assert.equal(check(schema, next)?.code, 'tool_arguments_budget_exceeded')
  assert.equal(check(schema, { rows: Array.from({ length: 10001 }, () => 1) })?.code, 'tool_arguments_budget_exceeded')
  const cycle = {}
  cycle.self = cycle
  assert.equal(check(schema, cycle)?.code, 'invalid_tool_arguments')
})

test('defaults remain explicit and non-mutating, without guessing branches', () => {
  const schema = { type: 'object', properties: {
    count: { type: 'integer', default: 2 },
    value: { anyOf: [{ type: 'string', default: 'left' }, { type: 'integer', default: 1 }] },
  }, required: ['count'] }
  const raw = { name: 'schema_fixture', arguments: '{}' }
  const [call] = normalizeToolCalls([raw], { toolSpecs: spec(schema) })
  assert.deepEqual(call.args, { count: 2 })
  assert.deepEqual(call.argumentDefaults, ['$.count'])
  assert.equal(raw.arguments, '{}')
  assert.equal(check(schema, call.args), null)
})

test('schema cache rechecks a changed definition rather than trusting object identity', () => {
  const schema = { type: 'object', properties: { value: { const: 'first' } } }
  assert.equal(check(schema, { value: 'first' }), null)
  schema.properties.value.const = 'second'
  assert.equal(check(schema, { value: 'first' })?.code, 'tool_arguments_validation_failed')
})

test('draft2020 prefixItems, unevaluatedProperties and dependentRequired are enforced', () => {
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { values: { type: 'array', prefixItems: [{ type: 'integer' }, { const: 'safe' }], items: false }, flag: { type: 'boolean' }, detail: { type: 'string' } },
    dependentRequired: { flag: ['detail'] }, unevaluatedProperties: false }
  assert.equal(check(schema, { values: [1, 'safe'], flag: true, detail: 'provided' }), null)
  for (const value of [
    { values: ['bad', 'safe'] }, { values: [1, 'bad'] }, { values: [1, 'safe', 3] },
    { values: [1, 'safe'], extra: true }, { flag: true },
  ]) assert.equal(check(schema, value)?.code, 'tool_arguments_validation_failed')
})

test('standard MCP formats validate and unknown formats fail closed', () => {
  for (const [format, good, bad] of [
    ['email', 'fixture@example.test', 'not an email'],
    ['uri', 'https://example.test/path', 'not a uri'],
    ['date-time', '2026-09-18T12:00:00Z', 'not a datetime'],
  ]) {
    const schema = { type: 'object', properties: { value: { type: 'string', format } } }
    assert.equal(check(schema, { value: good }), null)
    assert.equal(check(schema, { value: bad })?.code, 'tool_arguments_validation_failed')
  }
  assert.equal(validateToolSchemaDefinition({ type: 'object', properties: { value: { format: 'unregistered-format' } } })?.code, 'tool_schema_unsupported')
})

test('regex matching inputs and schema definitions have explicit resource failures', () => {
  const schema = { type: 'object', properties: { value: { pattern: '^[a-z]+$' } } }
  assert.equal(check(schema, { value: 'a'.repeat(4097) })?.code, 'tool_arguments_budget_exceeded')
  assert.equal(validateToolSchemaDefinition({ type: 'object', description: 'x'.repeat(300000) })?.code, 'tool_schema_budget_exceeded')
  for (const pattern of ['(a|aa)+$', 'a+a+$', 'a{0,100}a{0,100}a{0,100}', '(?=a)a+', '(a)\\1']) {
    assert.equal(validateToolSchemaDefinition({ pattern })?.code, 'tool_schema_unsupported')
  }
})

test('oversized JSON, invalid accessors and cyclic objects stop before default expansion', () => {
  assert.equal(parseToolArguments(JSON.stringify({ value: 'x'.repeat(4 * 1024 * 1024) })).error?.code, 'tool_arguments_budget_exceeded')
  let accessed = 0
  const args = Object.defineProperty({}, 'value', { enumerable: true, get() { accessed += 1; return 'not JSON' } })
  assert.equal(parseToolArguments(args).error?.code, 'invalid_tool_arguments')
  assert.equal(accessed, 0)
  const shared = { value: 1 }
  assert.equal(check({ type: 'object' }, { first: shared, second: shared }), null, 'shared immutable references are not cycles')
})

test('schema defaults cannot mutate prototypes or retain shared mutable definitions', () => {
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"default":{"polluted":true}},"options":{"default":{"nested":{"safe":true}}}}}')
  const [call] = normalizeToolCalls([{ name: 'schema_fixture', arguments: '{}' }], { toolSpecs: spec(schema) })
  assert.equal(Object.getPrototypeOf(call.args), Object.prototype)
  assert.equal(Object.hasOwn(call.args, '__proto__'), true)
  call.args.options.nested.safe = false
  assert.equal(schema.properties.options.default.nested.safe, true)
  assert.equal({}.polluted, undefined)
})

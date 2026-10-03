import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_TOOL_SCHEMA_CATALOG } from '../server/utils/toolSchemaCatalog.js'
import { validateToolSchemaArguments, validateToolSchemaDefinition } from '../server/utils/toolJsonSchema.js'
import {
  getDynamicTool, getDynamicToolSpecRegistrationId, registerDynamicTool,
} from '../server/utils/toolSchemaDynamicRegistry.js'

const name = 'isolated_schema_registry_tool'
const spec = (parameters) => ({ type: 'function', function: { name, parameters } })

test('every current builtin compiles without changing the published schema', () => {
  for (const [toolName, tool] of Object.entries(BUILTIN_TOOL_SCHEMA_CATALOG)) {
    const original = structuredClone(tool.function.parameters)
    assert.equal(validateToolSchemaDefinition(tool.function.parameters), null, toolName)
    assert.deepEqual(tool.function.parameters, original, toolName)
  }
})

test('invalid dynamic replacement preserves the old registration, identity and disposer', (t) => {
  const schema = { type: 'object', properties: { value: { type: 'integer' } } }
  const dispose = registerDynamicTool({ name, origin: 'test', spec: spec(schema) })
  t.after(dispose)
  const before = getDynamicTool(name)
  const id = getDynamicToolSpecRegistrationId(before.spec)
  assert.throws(() => registerDynamicTool({ name, origin: 'mcp', spec: spec({ $ref: 'https://untrusted.invalid/schema' }) }), { code: 'tool_schema_unsupported' })
  assert.equal(getDynamicTool(name), before)
  assert.equal(getDynamicToolSpecRegistrationId(getDynamicTool(name).spec), id)
  schema.properties.value.type = 'boolean'
  assert.equal(getDynamicTool(name).spec.function.parameters.properties.value.type, 'integer', 'caller mutation does not alter a bound schema')
  assert.equal(dispose(), true)
  assert.equal(getDynamicTool(name), null)
})

test('benign extension metadata survives registration and unsupported keywords are diagnosed', (t) => {
  const schema = { type: 'object', 'x-presentation': 'compact', _meta: { source: 'fixture' }, properties: {} }
  const dispose = registerDynamicTool({ name, origin: 'test', spec: spec(schema) })
  t.after(dispose)
  assert.deepEqual(getDynamicTool(name).spec.function.parameters, schema)
  assert.throws(() => registerDynamicTool({ name, origin: 'test', spec: spec({ type: 'object', minumum: 2 }) }), {
    code: 'tool_schema_unsupported', retryable: false,
  })
})

test('registered schema snapshots stay deeply immutable without freezing caller input', (t) => {
  const schema = {
    type: 'object', properties: { value: { type: 'string', enum: ['allowed'] } },
    required: ['value'], additionalProperties: false, _meta: { source: ['host snapshot'] },
  }
  const definition = spec(schema)
  const dispose = registerDynamicTool({ name, origin: 'test', spec: definition })
  t.after(dispose)
  const stored = getDynamicTool(name).spec
  const parameters = stored.function.parameters
  for (const node of [stored, stored.function, parameters, parameters.properties, parameters.properties.value,
    parameters.properties.value.enum, parameters.required, parameters._meta, parameters._meta.source]) {
    assert.equal(Object.isFrozen(node), true)
  }
  assert.throws(() => { parameters.properties.value.type = 'number' }, TypeError)
  assert.throws(() => { parameters.required.length = 0 }, TypeError)
  assert.throws(() => { stored.function.parameters = { type: 'object' } }, TypeError)
  assert.throws(() => { stored.function.name = 'different_tool' }, TypeError)
  assert.equal(validateToolSchemaArguments({ value: 42 }, parameters)?.code, 'tool_arguments_validation_failed')
  assert.equal(validateToolSchemaArguments({}, parameters)?.code, 'tool_arguments_validation_failed')
  assert.equal(validateToolSchemaArguments({ value: 'allowed' }, parameters), null)

  assert.equal(Object.isFrozen(schema), false)
  assert.equal(Object.isFrozen(schema.required), false)
  assert.equal(Object.isFrozen(definition.function), false)
  schema.required.length = 0
  schema.properties.value.enum.push('caller change')
  schema._meta.source.push('caller change')
  assert.deepEqual(parameters.required, ['value'])
  assert.deepEqual(parameters.properties.value.enum, ['allowed'])
  assert.deepEqual(parameters._meta.source, ['host snapshot'])
})

test('immutable dynamic schemas retain distinct registration identity across shadow and restoration', (t) => {
  const shared = spec({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] })
  const disposeFirst = registerDynamicTool({ name, origin: 'test', source: 'first', spec: shared })
  t.after(disposeFirst)
  const first = getDynamicTool(name).spec
  const firstId = getDynamicToolSpecRegistrationId(first)
  const disposeSecond = registerDynamicTool({ name, origin: 'test', source: 'second', spec: shared })
  t.after(disposeSecond)
  const second = getDynamicTool(name).spec
  assert.notEqual(second, first)
  assert.notEqual(second.function.parameters, first.function.parameters)
  assert.notEqual(getDynamicToolSpecRegistrationId(second), firstId)
  assert.throws(() => { second.function.parameters.required.push('forged') }, TypeError)
  assert.equal(disposeSecond(), true)
  assert.equal(getDynamicTool(name).spec, first)
  assert.equal(getDynamicToolSpecRegistrationId(first), firstId)
  assert.deepEqual(first.function.parameters.required, ['value'])
  assert.equal(disposeFirst(), true)
  assert.equal(getDynamicTool(name), null)
})

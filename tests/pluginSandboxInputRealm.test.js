import assert from 'node:assert/strict'
import test from 'node:test'
import { runTransformer } from '../server/plugins/pluginSandbox.js'

test('transformer input objects and arrays belong to the sandbox realm at every depth', async () => {
  const result = await runTransformer({
    plugin: {
      source: `function transform(input) {
        const inspect = (value) => {
          if (value === null || typeof value !== 'object') return true
          const expected = Array.isArray(value) ? Array.prototype : Object.prototype
          return Object.getPrototypeOf(value) === expected
            && Object.values(value).every(inspect)
        }
        return {
          localInput: inspect(input),
          localConstructor: input.constructor === Object,
          localArrayConstructor: input.items.constructor === Array,
          localMethod: input.items.map.constructor === Function,
        }
      }`,
    },
    input: { items: [{ nested: { value: 1 } }, [2, { value: 3 }]] },
    capabilities: [],
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.output, {
    localInput: true,
    localConstructor: true,
    localArrayConstructor: true,
    localMethod: true,
  })
})

test('identity transformers round-trip bounded plain data including undefined and negative zero', async () => {
  const input = {
    text: 'quotes " \\ newline\n and unicode \u2028 \u2029',
    empty: null,
    missing: undefined,
    negativeZero: -0,
    list: [undefined, -0, false, { nested: 'value' }],
  }
  Object.defineProperty(input, '__proto__', {
    value: { ownData: true },
    enumerable: true,
  })
  const result = await runTransformer({
    plugin: { source: 'function transform(input) { return input }' },
    input,
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.output, input)
  assert.equal(Object.hasOwn(result.output, 'missing'), true)
  assert.equal(Object.is(result.output.negativeZero, -0), true)
  assert.equal(Object.hasOwn(result.output, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(result.output), Object.prototype)
})

test('input transfer preserves primitive values and isolates mutable input', async () => {
  for (const input of [undefined, null, true, false, -0, 42, 'plain text']) {
    const result = await runTransformer({
      plugin: { source: 'function transform(input) { return input }' },
      input,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(Object.is(result.output, input), true)
  }
  const input = { nested: { value: 'original' }, items: [1] }
  const result = await runTransformer({
    plugin: {
      source: `function transform(input) {
        input.nested.value = 'changed'
        input.items.push(2)
        return input
      }`,
    },
    input,
  })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.output, { nested: { value: 'changed' }, items: [1, 2] })
  assert.deepEqual(input, { nested: { value: 'original' }, items: [1] })
})

test('transformer dynamic code generation stays disabled for realm-local inputs', async () => {
  const sources = [
    'function transform(input) { return input.constructor.constructor("return 1")() }',
    'function transform(input) { return input.items.map.constructor("return 1")() }',
    'function transform() { return (0, eval)("1 + 1") }',
  ]
  for (const source of sources) {
    const result = await runTransformer({
      plugin: { source },
      input: { items: [] },
      capabilities: [],
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /code generation.*disallowed/i)
  }
})

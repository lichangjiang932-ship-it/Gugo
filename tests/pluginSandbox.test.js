import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runTransformer, validateTransformer } from '../server/plugins/pluginSandbox.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const examplePlugin = {
  id: 'example-transformer-upper',
  entryPath: path.join(repoRoot, 'plugins/example-transformer-upper/entry.js'),
}

test('validateTransformer: validates loading without invoking transform', async () => {
  const valid = await validateTransformer({
    plugin: { source: "function transform() { throw new Error('must not run') }" },
  })
  assert.equal(valid.ok, true)
  assert.equal(Object.hasOwn(valid, 'output'), false)

  const invalid = await validateTransformer({
    plugin: { source: 'function transform( {' },
  })
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /Unexpected|SyntaxError|token/i)
})

test('plugin sandbox definitions reject accessors and Proxy containers without executing them', async () => {
  let getterCalls = 0
  const accessorPlugin = {}
  Object.defineProperty(accessorPlugin, 'source', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'function transform(input) { return input }'
    },
  })
  await assert.rejects(
    () => validateTransformer({ plugin: accessorPlugin }),
    (error) => error?.code === 'PLUGIN_SANDBOX_DEFINITION_INVALID'
      && error?.retryable === false
      && /plugin\.source/.test(error?.message || ''),
  )
  assert.equal(getterCalls, 0)

  let descriptorCalls = 0
  const proxyPlugin = new Proxy({
    source: 'function transform(input) { return input }',
  }, {
    getOwnPropertyDescriptor(target, key) {
      descriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  await assert.rejects(
    () => validateTransformer({ plugin: proxyPlugin }),
    (error) => error?.code === 'PLUGIN_SANDBOX_DEFINITION_INVALID'
      && error?.retryable === false
      && /definition at plugin$/.test(error?.message || ''),
  )
  assert.equal(descriptorCalls, 0)
})

test('plugin sandbox capabilities use bounded own descriptors without calling array methods', async () => {
  let filterCalls = 0
  const capabilities = ['log']
  Object.defineProperty(capabilities, 'filter', {
    value() {
      filterCalls += 1
      return []
    },
  })
  const allowed = await runTransformer({
    plugin: { source: "function transform() { console['log']('x'); return 'ok' }" },
    input: null,
    capabilities,
  })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.output, 'ok')
  assert.equal(filterCalls, 0)

  let proxyTrapCalls = 0
  const proxyCapabilities = new Proxy(['log'], {
    getOwnPropertyDescriptor(target, key) {
      proxyTrapCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    get(target, key, receiver) {
      proxyTrapCalls += 1
      return Reflect.get(target, key, receiver)
    },
  })
  const rejected = await runTransformer({
    plugin: { source: "function transform() { console['log']('x'); return 'ok' }" },
    input: null,
    capabilities: proxyCapabilities,
  })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /console|undefined|log/)
  assert.equal(proxyTrapCalls, 0)
})

test('plugin sandbox input is bounded plain data without getter or Proxy execution', async () => {
  const identityPlugin = { source: 'function transform(input) { return input }' }
  let getterCalls = 0
  const accessorInput = {}
  Object.defineProperty(accessorInput, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'forged'
    },
  })
  await assert.rejects(
    () => runTransformer({ plugin: identityPlugin, input: accessorInput }),
    (error) => error?.code === 'PLUGIN_SANDBOX_INPUT_INVALID'
      && error?.retryable === false
      && /getters and setters/.test(error?.message || ''),
  )
  assert.equal(getterCalls, 0)

  let proxyTrapCalls = 0
  const proxyInput = new Proxy({ secret: 'forged' }, {
    getOwnPropertyDescriptor(target, key) {
      proxyTrapCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    getPrototypeOf(target) {
      proxyTrapCalls += 1
      return Reflect.getPrototypeOf(target)
    },
  })
  for (const input of [proxyInput, { nested: proxyInput }]) {
    await assert.rejects(
      () => runTransformer({ plugin: identityPlugin, input }),
      (error) => error?.code === 'PLUGIN_SANDBOX_INPUT_INVALID'
        && error?.retryable === false
        && /Proxy values/.test(error?.message || ''),
    )
  }
  assert.equal(proxyTrapCalls, 0)

  await assert.rejects(
    () => runTransformer({ plugin: identityPlugin, input: 'x'.repeat((64 * 1024) + 1) }),
    (error) => error?.code === 'PLUGIN_SANDBOX_INPUT_INVALID'
      && error?.retryable === false
      && /too large/.test(error?.message || ''),
  )
})

test('runTransformer: 基本调用 string input 转大写', async () => {
  const result = await runTransformer({
    plugin: examplePlugin,
    input: 'hello',
    capabilities: ['log'],
  })

  assert.equal(result.ok, true)
  assert.equal(result.output, 'HELLO')
  assert.ok(result.durationMs > 0)
})

test('runTransformer: object input 转大写', async () => {
  const result = await runTransformer({
    plugin: examplePlugin,
    input: { text: 'hi' },
    capabilities: ['log'],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.output, { text: 'HI' })
})

test('runTransformer: 超时后终止 worker', async () => {
  const timeoutMs = 100
  const result = await runTransformer({
    plugin: { id: 'loop', source: 'function transform() { while (true) {} }' },
    input: 'x',
    timeoutMs,
  })

  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.error, 'timeout')
  assert.ok(result.durationMs >= timeoutMs - 20, `duration ${result.durationMs}ms should be near timeout`)
  assert.ok(result.durationMs <= timeoutMs + 200, `duration ${result.durationMs}ms should be near timeout`)
})

test('runTransformer: plugin 内抛异常返回错误信息', async () => {
  const result = await runTransformer({
    plugin: { id: 'boom', source: "function transform() { throw new Error('boom') }" },
    input: 'x',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /boom/)
})

test('runTransformer: process 不暴露且主进程不退出', async () => {
  const result = await runTransformer({
    plugin: { id: 'no-process', source: 'function transform() { process.exit(1) }' },
    input: 'x',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /process/)
})

test('runTransformer: require 不暴露且主进程不挂', async () => {
  const result = await runTransformer({
    plugin: { id: 'no-require', source: "function transform() { return require('fs') }" },
    input: 'x',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /require/)
})

test("runTransformer: capability 不含 'log' 时 console.log 抛错", async () => {
  const result = await runTransformer({
    plugin: { id: 'no-log', source: "function transform() { console.log('x'); return 'ok' }" },
    input: 'x',
    capabilities: [],
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /console|undefined|log/)
})

test("runTransformer: capability 含 'log' 时 console.log 可调用", async () => {
  const result = await runTransformer({
    plugin: { id: 'with-log', source: "function transform() { console.log('x'); return 'ok' }" },
    input: 'x',
    capabilities: ['log'],
  })

  assert.equal(result.ok, true)
  assert.equal(result.output, 'ok')
})

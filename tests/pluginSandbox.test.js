import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
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

test('plugin sandbox invocation options are own-data snapshots with host-owned modes', async () => {
  const plugin = { source: "function transform() { throw new Error('transform-ran') }" }
  let getterCalls = 0
  const accessorOptions = { input: null }
  Object.defineProperty(accessorOptions, 'plugin', {
    enumerable: true,
    get() {
      getterCalls += 1
      return plugin
    },
  })
  await assert.rejects(
    () => runTransformer(accessorOptions),
    (error) => error?.code === 'PLUGIN_SANDBOX_OPTIONS_INVALID'
      && error?.retryable === false
      && /options\.plugin/.test(error?.message || ''),
  )
  assert.equal(getterCalls, 0)

  let descriptorCalls = 0
  const proxyOptions = new Proxy({ plugin, input: null }, {
    getOwnPropertyDescriptor(target, key) {
      descriptorCalls += 1
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  await assert.rejects(
    () => runTransformer(proxyOptions),
    (error) => error?.code === 'PLUGIN_SANDBOX_OPTIONS_INVALID'
      && /options$/.test(error?.message || ''),
  )
  assert.equal(descriptorCalls, 0)

  const inheritedOptions = Object.create({ plugin })
  await assert.rejects(
    () => runTransformer(inheritedOptions),
    (error) => error?.code === 'PLUGIN_SANDBOX_OPTIONS_INVALID'
      && /options\.plugin/.test(error?.message || ''),
  )

  let coercionCalls = 0
  const coerciveNumber = {
    [Symbol.toPrimitive]() {
      coercionCalls += 1
      return 100
    },
  }
  for (const invalidOptions of [
    { plugin, timeoutMs: coerciveNumber },
    { plugin, timeoutMs: 0 },
    { plugin, timeoutMs: 60_001 },
    { plugin, memoryLimitMb: coerciveNumber },
    { plugin, memoryLimitMb: 7 },
    { plugin, memoryLimitMb: 257 },
  ]) {
    await assert.rejects(
      () => runTransformer(invalidOptions),
      (error) => error?.code === 'PLUGIN_SANDBOX_OPTIONS_INVALID'
        && error?.retryable === false,
    )
  }
  assert.equal(coercionCalls, 0)

  let modeGetterCalls = 0
  const runOptions = { plugin, input: null }
  Object.defineProperty(runOptions, 'validateOnly', {
    get() {
      modeGetterCalls += 1
      return true
    },
  })
  const run = await runTransformer(runOptions)
  assert.equal(run.ok, false)
  assert.match(run.error, /transform-ran/)
  assert.equal(modeGetterCalls, 0)

  const validation = await validateTransformer({
    plugin,
    input: null,
    validateOnly: false,
  })
  assert.equal(validation.ok, true)
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

test('plugin sandbox source is bounded for inline and entryPath definitions', async () => {
  const sourcePrefix = 'function transform(input) { return input }\n'
  const exactSource = sourcePrefix + ' '.repeat((512 * 1024) - Buffer.byteLength(sourcePrefix))
  const exact = await validateTransformer({ plugin: { source: exactSource } })
  assert.equal(exact.ok, true)

  await assert.rejects(
    () => validateTransformer({ plugin: { source: `${exactSource}x` } }),
    (error) => error?.code === 'PLUGIN_SANDBOX_SOURCE_INVALID'
      && error?.retryable === false
      && /512 KiB/.test(error?.message || ''),
  )

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gugo-plugin-source-'))
  try {
    const oversizedEntry = path.join(tempDir, 'entry.js')
    await fs.writeFile(oversizedEntry, `${exactSource}x`, 'utf8')
    await assert.rejects(
      () => validateTransformer({ plugin: { entryPath: oversizedEntry } }),
      (error) => error?.code === 'PLUGIN_SANDBOX_SOURCE_INVALID'
        && error?.retryable === false
        && /512 KiB/.test(error?.message || ''),
    )
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
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

test('plugin sandbox output is bounded plain data without getter, Proxy, or thenable execution', async () => {
  const invalidSources = [
    "function transform() { return Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('output-getter-ran') } }) }",
    "function transform() { return new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('output-proxy-trap-ran') }, getPrototypeOf() { throw new Error('output-proxy-trap-ran') } }) }",
    "async function transform() { return 'async-output' }",
    "function transform() { return { then() { throw new Error('output-then-ran') } } }",
    "function transform() { return 'x'.repeat((64 * 1024) + 1) }",
    "function transform() { return Object.create({ inherited: true }) }",
  ]
  for (const source of invalidSources) {
    const result = await runTransformer({ plugin: { source }, input: null })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PLUGIN_SANDBOX_OUTPUT_INVALID')
    assert.doesNotMatch(result.error, /output-(?:getter|proxy-trap|then)-ran/)
  }
})

test('plugin sandbox thrown-value projection does not execute message accessors or object coercion', async () => {
  const result = await runTransformer({
    plugin: {
      source: "function transform() { const error = {}; Object.defineProperty(error, 'message', { get() { throw new Error('message-getter-ran') } }); error.toString = function () { throw new Error('to-string-ran') }; throw error }",
    },
    input: null,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'plugin_error')
  assert.doesNotMatch(result.error, /message-getter-ran|to-string-ran/)
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

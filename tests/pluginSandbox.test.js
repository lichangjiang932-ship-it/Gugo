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

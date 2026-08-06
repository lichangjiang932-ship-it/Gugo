import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAssistantToolCallsMessage,
  createToolLoopGuard,
  mapWithConcurrency,
  normalizeToolCalls,
  parseToolArguments,
  resolveToolResultMaxChars,
  serializeToolResult,
  validateToolCall,
} from '../server/utils/toolCallHarness.js'

const SPECS = [{
  type: 'function',
  function: {
    name: 'read_file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, limit: { type: 'integer' } },
      required: ['path'],
    },
  },
}]

test('normalizeToolCalls 兼容 wire/简写形状并修复缺失、重复 id', () => {
  let id = 0
  const calls = normalizeToolCalls([
    { id: 'same', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    { id: 'same', name: 'read_file', arguments: { path: 'b' } },
    { name: 'read_file', arguments: '{}' },
  ], { idFactory: () => `generated-${++id}` })

  assert.deepEqual(calls.map((call) => call.id), ['same', 'generated-1', 'generated-2'])
  assert.deepEqual(calls.map((call) => call.args), [{ path: 'a' }, { path: 'b' }, {}])
  const message = buildAssistantToolCallsMessage(calls)
  assert.equal(message.tool_calls[1].id, 'generated-1')
  assert.deepEqual(JSON.parse(message.tool_calls[1].function.arguments), { path: 'b' })
})

test('损坏 JSON 不再静默降级成空参数', () => {
  const parsed = parseToolArguments('{"path":')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.args, null)
  assert.equal(parsed.error.code, 'invalid_tool_arguments')
  assert.match(parsed.error.error, /有效 JSON/)
})

test('validateToolCall 在执行前拦截未知工具、缺参和类型错误', () => {
  const [unknown] = normalizeToolCalls([{ name: 'delete_everything', arguments: '{}' }])
  assert.equal(validateToolCall(unknown, SPECS).code, 'unknown_tool')

  const [missing] = normalizeToolCalls([{ name: 'read_file', arguments: '{}' }])
  assert.equal(validateToolCall(missing, SPECS).code, 'tool_arguments_validation_failed')

  const [badType] = normalizeToolCalls([{ name: 'read_file', arguments: '{"path":3}' }])
  assert.match(validateToolCall(badType, SPECS).error, /应为 string/)

  const [valid] = normalizeToolCalls([{ name: 'read_file', arguments: '{"path":"a","limit":10}' }])
  assert.equal(validateToolCall(valid, SPECS), null)
})

test('serializeToolResult 对循环引用和超长结果始终输出合法 JSON', () => {
  const circular = { ok: true }
  circular.self = circular
  const circularJson = serializeToolResult(circular)
  assert.doesNotThrow(() => JSON.parse(circularJson))
  assert.match(circularJson, /Circular/)

  const clipped = serializeToolResult({ ok: true, content: 'x'.repeat(10_000) }, { maxChars: 800 })
  const parsed = JSON.parse(clipped)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.originalChars > 800, true)
  assert.equal(clipped.length <= 800, true)
})

test('createToolLoopGuard 熔断重复调用和连续失败', () => {
  const [call] = normalizeToolCalls([{ name: 'read_file', arguments: '{"path":"a"}' }])
  const repeated = createToolLoopGuard({ maxRepeatedCalls: 2 })
  assert.equal(repeated.before(call).ok, true)
  assert.equal(repeated.before(call).ok, true)
  assert.equal(repeated.before(call).result.code, 'repeated_tool_call')

  const failures = createToolLoopGuard({ maxConsecutiveErrors: 2 })
  assert.equal(failures.after({ ok: false, error: 'a' }).ok, true)
  assert.equal(failures.after({ ok: false, error: 'b' }).ok, false)
})

test('mapWithConcurrency 保持结果顺序并限制并发数', async () => {
  let active = 0
  let maxActive = 0
  const result = await mapWithConcurrency([30, 5, 20, 1], async (delay, index) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, delay))
    active -= 1
    return index
  }, { concurrency: 2 })

  assert.deepEqual(result, [0, 1, 2, 3])
  assert.equal(maxActive, 2)
})

test('tool result batch budget follows the context window without penalizing large-window models', () => {
  assert.equal(resolveToolResultMaxChars({ contextWindow: 8_192, resultCount: 4 }), 1_536)
  assert.equal(resolveToolResultMaxChars({ contextWindow: 32_768, resultCount: 4 }), 6_144)
  assert.equal(resolveToolResultMaxChars({ contextWindow: 128_000, resultCount: 4 }), 24_000)
  assert.equal(resolveToolResultMaxChars({ contextWindow: undefined, resultCount: 4 }), 24_000)
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAssistantToolCallsMessage,
  createToolLoopGuard,
  executeToolWithRetry,
  isSubstantiveToolCall,
  mapWithConcurrency,
  normalizeToolCalls,
  normalizeToolError,
  normalizeToolResult,
  parseToolArguments,
  repairTruncatedJsonObject,
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

test('normalizeToolError preserves only safe directory-authorization metadata', () => {
  const normalized = normalizeToolError(Object.assign(new Error('directory grant required'), {
    code: 'PATH_NOT_AUTHORIZED',
    statusCode: 403,
    path: 'D:\\private\\note.txt',
    suggestGrantPath: 'D:\\private',
    requiredAccessMode: 'read_write',
  }))

  assert.equal(normalized.path, 'D:\\private\\note.txt')
  assert.equal(normalized.suggestGrantPath, 'D:\\private')
  assert.equal(normalized.requiredAccessMode, 'read_write')

  const invalidMode = normalizeToolError({
    message: 'invalid mode',
    requiredAccessMode: 'full_control',
  })
  assert.equal('requiredAccessMode' in invalidMode, false)
})

test('truncated tool JSON repair only appends safe structural closers', () => {
  assert.deepEqual(repairTruncatedJsonObject('{"path":"a.txt"'), {
    args: { path: 'a.txt' },
    argumentsText: '{"path":"a.txt"}',
    addedClosers: 1,
  })
  assert.deepEqual(repairTruncatedJsonObject('{"items":[{"path":"a.txt"}]'), {
    args: { items: [{ path: 'a.txt' }] },
    argumentsText: '{"items":[{"path":"a.txt"}]}',
    addedClosers: 1,
  })

  for (const unsafe of [
    '{"path":"unfinished',
    '{"path":',
    '{"path":"a.txt",',
    '{"path":tru',
    '[{"path":"a.txt"}',
  ]) {
    assert.equal(repairTruncatedJsonObject(unsafe), null, unsafe)
  }

  const parsed = parseToolArguments('{"path":"a.txt"')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.args, { path: 'a.txt' })
  assert.deepEqual(parsed.repair, { kind: 'closed_truncated_json', addedClosers: 1 })

  const [call] = normalizeToolCalls([{ name: 'read_file', arguments: '{"path":"a.txt"' }])
  assert.deepEqual(call.argumentRepair, { kind: 'closed_truncated_json', addedClosers: 1 })
  assert.equal(call.parseError, null)
})

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

test('normalizeToolCalls applies only explicit JSON Schema defaults', () => {
  const specs = [{
    type: 'function',
    function: {
      name: 'run_check',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'integer', default: 60_000 },
          options: {
            type: 'object',
            properties: { quiet: { type: 'boolean', default: false } },
          },
        },
        required: ['command'],
      },
    },
  }]

  const [missingBusinessValue] = normalizeToolCalls([
    { name: 'run_check', arguments: '{}' },
  ], { toolSpecs: specs })
  assert.deepEqual(missingBusinessValue.args, { timeout_ms: 60_000 })
  assert.deepEqual(missingBusinessValue.argumentDefaults, ['$.timeout_ms'])
  assert.equal(Object.hasOwn(missingBusinessValue.args, 'command'), false)
  assert.equal(Object.hasOwn(missingBusinessValue.args, 'options'), false)
  assert.equal(validateToolCall(missingBusinessValue, specs).code, 'tool_arguments_validation_failed')

  const [nested] = normalizeToolCalls([
    { name: 'run_check', arguments: '{"command":"npm test","options":{}}' },
  ], { toolSpecs: specs })
  assert.deepEqual(nested.args, {
    command: 'npm test',
    timeout_ms: 60_000,
    options: { quiet: false },
  })
  assert.deepEqual(nested.argumentDefaults, ['$.timeout_ms', '$.options.quiet'])
  assert.deepEqual(JSON.parse(nested.argumentsText), nested.args)
  assert.equal(validateToolCall(nested, specs), null)
})

test('validateToolCall enforces composed, range, length, pattern, and closed-object schemas', () => {
  const specs = [{
    type: 'function',
    function: {
      name: 'strict_tool',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', pattern: '^[a-z]+$', minLength: 2, maxLength: 5 },
          count: { type: 'integer', minimum: 1, maximum: 3 },
          items: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } },
        },
        required: ['mode'],
        anyOf: [
          { required: ['count'] },
          { required: ['items'] },
        ],
        additionalProperties: false,
      },
    },
  }]

  const [missingBranch] = normalizeToolCalls([{
    name: 'strict_tool',
    arguments: '{"mode":"ok"}',
  }])
  const missingBranchError = validateToolCall(missingBranch, specs)
  assert.equal(missingBranchError.code, 'tool_arguments_validation_failed')
  assert.match(missingBranchError.error, /任一允许的参数形状/)

  const [invalid] = normalizeToolCalls([{
    name: 'strict_tool',
    arguments: '{"mode":"TOOLONG","count":4,"items":[],"extra":true}',
  }])
  const invalidError = validateToolCall(invalid, specs)
  assert.equal(invalidError.code, 'tool_arguments_validation_failed')
  assert.ok(Array.isArray(invalidError.issues))
  assert.match(invalidError.issues.join('\n'), /长度不能大于 5/)
  assert.match(invalidError.issues.join('\n'), /不符合要求的格式/)
  assert.match(invalidError.issues.join('\n'), /不能大于 3/)
  assert.match(invalidError.issues.join('\n'), /至少需要 1 项/)
  assert.match(invalidError.issues.join('\n'), /未允许的额外参数/)

  const [invalidLowerBounds] = normalizeToolCalls([{
    name: 'strict_tool',
    arguments: '{"mode":"x","count":0,"items":["a","b","c"]}',
  }])
  const lowerBoundsError = validateToolCall(invalidLowerBounds, specs)
  assert.equal(lowerBoundsError.code, 'tool_arguments_validation_failed')
  assert.match(lowerBoundsError.issues.join('\n'), /长度不能小于 2/)
  assert.match(lowerBoundsError.issues.join('\n'), /不能小于 1/)
  assert.match(lowerBoundsError.issues.join('\n'), /最多允许 2 项/)

  const [prototypeKey] = normalizeToolCalls([{
    name: 'strict_tool',
    arguments: '{"mode":"okay","count":1,"constructor":true}',
  }])
  assert.match(
    validateToolCall(prototypeKey, specs).issues.join('\n'),
    /constructor.*未允许的额外参数/,
  )

  const [valid] = normalizeToolCalls([{
    name: 'strict_tool',
    arguments: '{"mode":"okay","items":["a"]}',
  }])
  assert.equal(validateToolCall(valid, specs), null)
})

test('validateToolCall applies item schemas without requiring a redundant array type', () => {
  const specs = [{
    type: 'function',
    function: {
      name: 'array_tool',
      parameters: {
        type: 'object',
        properties: {
          values: { items: { type: 'integer', minimum: 1 } },
        },
        required: ['values'],
      },
    },
  }]
  const [call] = normalizeToolCalls([{
    name: 'array_tool',
    arguments: '{"values":[0]}',
  }])
  assert.match(validateToolCall(call, specs).issues.join('\n'), /不能小于 1/)
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

test('createToolLoopGuard only counts consecutive duplicate calls and resets after progress', () => {
  const guard = createToolLoopGuard({ maxRepeatedCalls: 2 })
  const first = { name: 'read_file', args: { path: 'a.txt' } }
  const second = { name: 'read_file', args: { path: 'b.txt' } }

  assert.equal(guard.before(first).ok, true)
  assert.equal(guard.before(first).ok, true)
  assert.equal(guard.before(second).ok, true, 'a different call resets the duplicate streak')
  assert.equal(guard.before(first).ok, true)
  assert.equal(guard.before(first).ok, true)
  assert.equal(guard.after({ ok: true, content: 'read' }, first).ok, true)
  assert.equal(guard.snapshot().repeatedCallStreak, 0)
  assert.equal(guard.before(first).ok, true, 'substantive progress resets the duplicate streak')
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

test('normalizeToolResult rejects empty or ambiguous executor results', () => {
  for (const result of [undefined, null, {}, [], true, 'ok']) {
    const normalized = normalizeToolResult(result)
    assert.equal(normalized.ok, false)
    assert.equal(normalized.code, 'tool_result_invalid')
    assert.equal(normalized.retryable, false)
  }

  const explicitSuccess = { ok: true, content: 'done' }
  assert.equal(normalizeToolResult(explicitSuccess), explicitSuccess)

  const legacyFailure = normalizeToolResult({ error: 'legacy failure' })
  assert.equal(legacyFailure.ok, false)
  assert.equal(legacyFailure.error, 'legacy failure')
})

test('a different successful tool does not clear per-tool failure history', () => {
  const guard = createToolLoopGuard({ maxSameToolFailures: 3 })
  const readCall = { name: 'read_file' }

  assert.equal(guard.afterCall(readCall, { ok: false, error: 'first' }).ok, true)
  assert.equal(guard.afterCall(readCall, { ok: false, error: 'second' }).ok, true)
  assert.equal(guard.afterCall({ name: 'git_status' }, { ok: true }).ok, true)
  assert.equal(guard.afterCall(readCall, { ok: false, error: 'third' }).ok, false)
})

test('non-substantive tools do not clear a real execution error streak', () => {
  const nonSubstantiveNames = [
    'reflect',
    'request_clarification',
    'request_directory',
    'sleep_until',
    'manage_todos',
  ]

  for (const name of nonSubstantiveNames) {
    const guard = createToolLoopGuard({ maxConsecutiveErrors: 2 })
    assert.equal(isSubstantiveToolCall({ name }), false)
    assert.equal(guard.after({ ok: false, error: 'first' }, { name: 'read_file' }).ok, true)
    assert.equal(guard.after({ ok: true }, { name }).ok, true)
    assert.equal(guard.after({ ok: false, error: 'second' }, { name: 'read_file' }).ok, false)
  }
})

test('invalid executor results count as failures instead of progress', () => {
  const guard = createToolLoopGuard({ maxConsecutiveErrors: 2 })
  assert.equal(guard.after(undefined, { name: 'read_file' }).ok, true)
  assert.equal(guard.after({}, { name: 'read_file' }).ok, false)
})

test('tool errors preserve routing fields while redacting credentials', () => {
  const normalized = normalizeToolError(Object.assign(
    new Error('request failed Authorization: Bearer secret-token-123456 api_key=sk-supersecret123456'),
    { code: 'UPSTREAM_503', statusCode: 503, retryable: true, hint: 'retry with token=private-value' },
  ))
  assert.equal(normalized.code, 'UPSTREAM_503')
  assert.equal(normalized.status, 503)
  assert.equal(normalized.retryable, true)
  assert.match(normalized.error, /\[REDACTED\]/)
  assert.doesNotMatch(JSON.stringify(normalized), /secret-token|supersecret|private-value/)
})

test('safe tool retry is bounded and never replays external writes', async () => {
  let reads = 0
  const read = await executeToolWithRetry({
    metadata: { isReadOnly: true, riskClass: 'read', isDestructive: false },
    baseDelayMs: 0,
    execute: async () => {
      reads += 1
      return reads < 3
        ? { ok: false, code: 'TEMPORARY', error: 'busy', status: 503, retryable: true }
        : { ok: true, content: 'done' }
    },
  })
  assert.equal(read.ok, true)
  assert.equal(read.attempts, 3)
  assert.equal(reads, 3)

  let writes = 0
  const write = await executeToolWithRetry({
    metadata: { isReadOnly: false, isIdempotent: true, riskClass: 'external', isDestructive: true },
    baseDelayMs: 0,
    execute: async () => {
      writes += 1
      return { ok: false, code: 'TEMPORARY', error: 'unknown outcome', retryable: true }
    },
  })
  assert.equal(write.ok, false)
  assert.equal(writes, 1)
})

test('tool retry backoff is cancellable', async () => {
  const controller = new AbortController()
  let attempts = 0
  const running = executeToolWithRetry({
    metadata: { isReadOnly: true, riskClass: 'read', isDestructive: false },
    signal: controller.signal,
    baseDelayMs: 10_000,
    execute: async () => {
      attempts += 1
      return { ok: false, code: 'TEMPORARY', error: 'busy', retryable: true }
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort('user_stop')
  await assert.rejects(running, (error) => error.name === 'AbortError')
  assert.equal(attempts, 1)
})

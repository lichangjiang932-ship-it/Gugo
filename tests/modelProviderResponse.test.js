import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractUsage,
  isProviderFailoverError,
  parseModelProviderResponse,
  parseOpenAICompatibleResponse,
} from '../server/adapters/modelProxy.js'
import { modelRequestOutcomeUnknown } from '../server/adapters/modelRequestOutcome.js'
import { isRetryableError } from '../server/utils/modelRetry.js'
import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { modelAssistantHistoryMessage } from '../server/services/loop/modelAssistantHistory.js'
import { callStreamingModelWithTools } from '../server/adapters/modelInvocationRuntime.js'

test('parseModelProviderResponse removes complete embedded think blocks from compatible responses', () => {
  const parsed = parseModelProviderResponse({
    choices: [{
      message: {
        content: '<think>private chain of thought</think>\nFinal grounded answer.',
        tool_calls: [],
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  })

  assert.equal(parsed.content, 'Final grounded answer.')
  assert.equal(parsed.content.includes('private chain of thought'), false)
  assert.equal(parsed.content.includes('<think>'), false)
  assert.equal(parsed.content.includes('</think>'), false)
  assert.equal(parsed.finishReason, 'stop')
  assert.equal(parsed.usage.totalTokens, 14)
})

test('parseModelProviderResponse removes orphaned closing think traces from native responses', () => {
  const parsed = parseModelProviderResponse({
    content: [{
      type: 'text',
      text: 'stale internal transcript\n</think>\nPublic answer from the model.',
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 8, output_tokens: 5 },
  }, { kind: 'anthropic' })

  assert.equal(parsed.content, 'Public answer from the model.')
  assert.equal(parsed.content.includes('stale internal transcript'), false)
  assert.equal(parsed.content.includes('<think>'), false)
  assert.equal(parsed.content.includes('</think>'), false)
  assert.equal(parsed.finishReason, 'stop')
  assert.equal(parsed.usage.totalTokens, 13)
})

test('unsigned native thought blocks stay separate and do not disable legacy text cleanup', () => {
  const responses = [
    [{ kind: 'anthropic' }, { content: [
      { type: 'thinking', thinking: 'PRIVATE_NATIVE_THOUGHT' },
      { type: 'text', text: 'orphaned private trace\n</think>\nPublic answer.' },
    ], stop_reason: 'end_turn' }],
    [{ kind: 'gemini' }, { candidates: [{ content: { parts: [
      { text: 'PRIVATE_NATIVE_THOUGHT', thought: true },
      { text: 'orphaned private trace\n</think>\nPublic answer.' },
    ] }, finishReason: 'STOP' }] }],
  ]
  for (const [profile, data] of responses) {
    const parsed = parseModelProviderResponse(data, profile)
    assert.equal(parsed.content, 'Public answer.')
    assert.equal(parsed.providerReplay, undefined)
    assert.equal(parsed.reasoning_content, undefined)
  }
})

test('a request-bound Gemini signature preserves literal think text while native thought remains in its own part', () => {
  const config = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-3-pro-preview', providerId: 'offline-fixture' }
  const profile = { kind: 'gemini', supportsTools: true }
  const user = { role: 'user', content: 'Explain this parser example.' }
  const literal = 'Literal parser example: </think> keep this whole explanation.'
  const parts = [
    { text: 'PRIVATE_NATIVE_THOUGHT', thought: true, thoughtSignature: 'SYNTHETIC_THOUGHT_SIGNATURE' },
    { text: literal, thoughtSignature: 'SYNTHETIC_LITERAL_SIGNATURE' },
  ]
  const providerRequest = buildModelProviderRequest({ config, profile, messages: [user] })
  const parsed = parseModelProviderResponse({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] }, profile, { providerRequest })
  assert.equal(parsed.content, literal)
  assert.deepEqual(parsed.providerReplay.parts, parts)
  assert.equal(parsed.reasoning_content, undefined)
  const assistant = modelAssistantHistoryMessage(parsed.content, parsed)
  const replay = JSON.parse(buildModelProviderRequest({ config, profile, messages: [user, assistant, { role: 'user', content: 'Continue.' }] }).init.body)
  assert.deepEqual(replay.contents.find((entry) => entry.role === 'model').parts, parts)
})

for (const kind of ['anthropic', 'gemini']) {
  test(`unsigned ${kind} stream retains legacy terminal cleanup and separates structured native thought`, async () => {
    const text = []
    const reasoning = []
    const frames = kind === 'anthropic' ? [
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_NATIVE_THOUGHT' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'orphaned private trace\n</thi' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'nk>\nPublic answer.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    ] : [
      { candidates: [{ content: { parts: [{ text: 'PRIVATE_NATIVE_THOUGHT', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'orphaned private trace\n</thi' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'nk>\nPublic answer.' }] }, finishReason: 'STOP' }] },
    ]
    const response = await callStreamingModelWithTools({
      messages: [{ role: 'user', content: 'Reply publicly.' }], tools: [], userId: null,
      env: { MODEL_BASE_URL: kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://generativelanguage.googleapis.com/v1beta', MODEL_NAME: kind === 'anthropic' ? 'claude-fixture' : 'gemini-3-pro-preview', MODEL_API_KEY: 'offline-fixture-only' },
      fetchImpl: async () => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }),
      onTextDelta: (delta) => text.push(delta), onReasoningDelta: (delta) => reasoning.push(delta),
    })
    assert.equal(response.content, 'Public answer.')
    assert.equal(text.join('').includes('PRIVATE_NATIVE_THOUGHT'), false)
    assert.equal(text.join('').endsWith('Public answer.'), true)
    assert.deepEqual(reasoning, ['PRIVATE_NATIVE_THOUGHT'])
    assert.equal(response.reasoning, undefined)
    assert.equal(response.providerReplay, undefined)
  })
}

for (const kind of ['anthropic', 'gemini']) {
  test(`${kind} native text arrives before the terminal frame and signed literal text stays exact`, async () => {
    const first = kind === 'anthropic' ? 'Hello ' : 'Literal </think> '
    const last = kind === 'anthropic' ? 'world.' : 'kept.'
    let controller
    let terminalSent = false
    let receivedBeforeTerminal = false
    const stream = new ReadableStream({ start(value) { controller = value } })
    const frame = (value) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
    const finish = () => {
      if (terminalSent) return
      terminalSent = true
      for (const value of kind === 'anthropic' ? [
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: last } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
      ] : [{ candidates: [{ content: { parts: [{ text: last, thoughtSignature: 'SYNTHETIC_LATE_SIGNATURE' }] }, finishReason: 'STOP' }] }]) controller.enqueue(frame(value))
      controller.close()
    }
    // A terminal-buffering regression still terminates this offline fixture,
    // but fails the assertion that the first text arrived beforehand.
    const timer = setTimeout(finish, 5_000)
    controller.enqueue(frame(kind === 'anthropic'
      ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first } }
      : { candidates: [{ content: { parts: [{ text: first }] } }] }))
    try {
      const response = await callStreamingModelWithTools({
        messages: [{ role: 'user', content: 'Stream an answer.' }], tools: [], userId: null,
        env: { MODEL_BASE_URL: kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://generativelanguage.googleapis.com/v1beta', MODEL_NAME: kind === 'anthropic' ? 'claude-fixture' : 'gemini-3-pro-preview', MODEL_API_KEY: 'offline-fixture-only' },
        fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
        onTextDelta: (delta) => { if (!terminalSent) { assert.equal(delta, first); receivedBeforeTerminal = true; finish() } },
      })
      assert.equal(receivedBeforeTerminal, true)
      assert.equal(response.content, first + last)
      if (kind === 'gemini') assert.equal(response.providerReplay.parts[0].text, first + last)
    } finally { clearTimeout(timer) }
  })
}

test('compatible response parsing accepts content arrays and Responses-style output', () => {
  assert.equal(parseOpenAICompatibleResponse({
    choices: [{ message: { content: [{ type: 'text', text: 'array reply' }] } }],
  }), 'array reply')

  assert.equal(parseModelProviderResponse({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses reply' }] }],
  }).content, 'responses reply')

  assert.equal(parseModelProviderResponse({ raw: 'plain text reply' }).content, 'plain text reply')
})

test('compatible response parsing normalizes Ollama native content and object tool arguments', () => {
  const parsed = parseModelProviderResponse({
    message: {
      role: 'assistant',
      content: 'I will inspect the workspace.',
      tool_calls: [{ function: { name: 'list_files', arguments: { path: '.' } } }],
    },
    done: true,
    done_reason: 'tool_calls',
    prompt_eval_count: 12,
    eval_count: 7,
  })

  assert.equal(parsed.content, 'I will inspect the workspace.')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].type, 'function')
  assert.equal(parsed.toolCalls[0].function.name, 'list_files')
  assert.equal(parsed.toolCalls[0].function.arguments, '{"path":"."}')
  assert.equal(parsed.finishReason, 'tool_calls')
  assert.deepEqual(parsed.usage, {
    promptTokens: 12,
    completionTokens: 7,
    totalTokens: 19,
  })
})

test('compatible usage requires an explicit non-empty prompt token count', () => {
  for (const data of [
    { usage: {} },
    { usage: { prompt_tokens: null, completion_tokens: 2 } },
    { usage: { prompt_tokens: '', completion_tokens: 2 } },
    { usage: { input_tokens: '   ', output_tokens: 2 } },
    { usage: { prompt_tokens: false, completion_tokens: 2 } },
    { prompt_eval_count: null, eval_count: 2 },
    { prompt_eval_count: '', eval_count: 2 },
  ]) assert.equal(extractUsage(data), null)

  assert.deepEqual(extractUsage({
    usage: { prompt_tokens: 0, completion_tokens: 2 },
  }), {
    promptTokens: 0,
    completionTokens: 2,
    totalTokens: 2,
  })
})

test('OpenAI-compatible prompt tokens already include cached tokens', () => {
  assert.deepEqual(extractUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 12,
      prompt_tokens_details: { cached_tokens: 40 },
    },
  }), {
    promptTokens: 100,
    completionTokens: 12,
    totalTokens: 112,
    cacheHitTokens: 40,
    cacheMissTokens: 60,
  })
})

test('compatible response parsing supports legacy function_call and Responses function items', () => {
  const legacy = parseModelProviderResponse({
    choices: [{
      message: { content: null, function_call: { name: 'read_file', arguments: '{"path":"README.md"}' } },
      finish_reason: 'function_call',
    }],
  })
  assert.equal(legacy.toolCalls[0].function.name, 'read_file')
  assert.equal(legacy.toolCalls[0].function.arguments, '{"path":"README.md"}')
  assert.equal(legacy.finishReason, 'tool_calls')

  const responses = parseModelProviderResponse({
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Preparing the result.' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write_file', arguments: { path: 'site.html', content: '<h1>ok</h1>' } },
    ],
    status: 'completed',
    usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
  })
  assert.equal(responses.content, 'Preparing the result.')
  assert.equal(responses.toolCalls[0].id, 'call_1')
  assert.equal(responses.toolCalls[0].function.name, 'write_file')
  assert.equal(responses.toolCalls[0].function.arguments, '{"path":"site.html","content":"<h1>ok</h1>"}')
  assert.equal(responses.finishReason, 'tool_calls')
  assert.equal(responses.usage.totalTokens, 13)
})

test('compatible response preserves output-length truncation when tool calls are present', () => {
  const parsed = parseModelProviderResponse({
    choices: [{
      message: {
        content: '',
        tool_calls: [{
          id: 'truncated-write',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"result.txt"' },
        }],
      },
      finish_reason: 'length',
    }],
  })

  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.finishReason, 'length')
})

test('Responses JSON preserves max-output truncation when function calls are present', () => {
  const parsed = parseModelProviderResponse({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
      type: 'function_call',
      call_id: 'responses-truncated-write',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'result.txt', content: 'looks complete but is not safe to run' }),
    }],
  })

  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'write_file')
  assert.equal(parsed.finishReason, 'length')
})

test('compatible JSON responses reject safety and unknown finish reasons', () => {
  for (const finishReason of ['content_filter', 'future_finish_reason']) {
    assert.throws(
      () => parseModelProviderResponse({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'unsafe',
              type: 'function',
              function: { name: 'write_file', arguments: '{"path":"unsafe.txt"}' },
            }],
          },
          finish_reason: finishReason,
        }],
      }),
      (error) => error?.code === 'MODEL_PROVIDER_STOP_REASON_ERROR'
        && error?.stopReason === finishReason
        && error?.fromUpstream === true,
      finishReason,
    )
  }
})

test('explicit provider stop failures cannot retry, fail over, or become outcome-unknown', () => {
  let providerError
  try {
    parseModelProviderResponse({
      choices: [{ message: { content: 'blocked' }, finish_reason: 'content_filter' }],
    })
  } catch (error) {
    providerError = error
  }

  assert.equal(providerError?.code, 'MODEL_PROVIDER_STOP_REASON_ERROR')
  assert.equal(isRetryableError(providerError), false)
  assert.equal(isProviderFailoverError(providerError), false)
  assert.equal(modelRequestOutcomeUnknown(providerError, {
    modelRequestId: 'mr_explicit_provider_failure',
    phase: 'response',
    responseReceived: true,
    requestStarted: true,
  }), providerError)
})

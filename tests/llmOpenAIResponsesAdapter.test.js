import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildOpenAIResponsesRequest,
  consumeOpenAIResponsesStreamPayload,
  createOpenAIResponsesStreamState,
  finishOpenAIResponsesStream,
  parseOpenAIResponsesResponse,
  registerOpenAIResponsesAdapter,
  toResponsesInput,
} from '../server/llm/adapters/openaiResponses.js'
import { hasModelProviderAdapter } from '../server/adapters/modelProviderRegistry.js'
import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { consumeNativeProviderStreamPayload, parseNativeProviderResponse } from '../server/adapters/nativeModelProviders.js'

const CONFIG = { baseUrl: 'https://gw.example/v1', modelName: 'gpt-5.1', apiKey: 'sk-1' }

test('the adapter registers itself under the protocol name the config uses', () => {
  assert.equal(registerOpenAIResponsesAdapter(), true, 'first registration wins')
  assert.equal(registerOpenAIResponsesAdapter(), false, 'registering twice is a no-op')
  assert.equal(hasModelProviderAdapter('openai-responses'), true)
})

test('system messages become instructions and turns become typed input items', () => {
  const { instructions, input } = toResponsesInput([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"p":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file body' },
  ])
  assert.equal(instructions, 'be terse')
  assert.deepEqual(input[0], { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] })
  assert.deepEqual(input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] })
  assert.deepEqual(input[2], { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"p":"a"}' })
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'c1', output: 'file body' })
})

test('the request targets /responses with a flat tool schema', () => {
  const { url, init } = buildOpenAIResponsesRequest({
    config: { ...CONFIG, maxTokens: 256, temperature: 0.2 },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } } }],
    profile: { supportsTools: true },
    stream: true,
  })
  assert.equal(url, 'https://gw.example/v1/responses')
  assert.equal(init.headers.authorization, 'Bearer sk-1')
  const body = JSON.parse(init.body)
  assert.equal(body.stream, true)
  assert.equal(body.max_output_tokens, 256)
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.tools, [{ type: 'function', name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }])
  // An endpoint already naming /responses is not doubled up.
  assert.equal(buildOpenAIResponsesRequest({ config: { ...CONFIG, baseUrl: 'https://gw.example/v1/responses' }, messages: [] }).url, 'https://gw.example/v1/responses')
})

test('a non-streaming payload is parsed into the pipeline response shape', () => {
  const parsed = parseOpenAIResponsesResponse({
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'hello ' }, { type: 'output_text', text: 'world' }] },
      { type: 'function_call', call_id: 'c9', name: 'read', arguments: '{"p":"a"}' },
    ],
    usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
  })
  assert.equal(parsed.content, 'hello world')
  assert.deepEqual(parsed.toolCalls, [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }])
  assert.deepEqual(parsed.usage, { promptTokens: 7, completionTokens: 2, totalTokens: 9 })
  assert.equal(parsed.finishReason, 'tool_calls')
  assert.equal(parseOpenAIResponsesResponse({ status: 'incomplete', output: [] }).finishReason, 'length')
})

test('the stream accumulates tool arguments and finishes exactly once', () => {
  const state = createOpenAIResponsesStreamState()
  assert.deepEqual(consumeOpenAIResponsesStreamPayload({ type: 'response.output_text.delta', delta: 'he' }, state), [{ type: 'text', delta: 'he' }])
  assert.deepEqual(consumeOpenAIResponsesStreamPayload({ type: 'response.reasoning_summary_text.delta', delta: 'why' }, state), [{ type: 'reasoning', delta: 'why' }])
  assert.deepEqual(consumeOpenAIResponsesStreamPayload({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c9', name: 'read' } }, state), [])
  consumeOpenAIResponsesStreamPayload({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"p"' }, state)
  consumeOpenAIResponsesStreamPayload({ type: 'response.function_call_arguments.delta', output_index: 0, delta: ':"a"}' }, state)
  const ready = consumeOpenAIResponsesStreamPayload({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } }, state)
  assert.equal(ready.length, 1)
  assert.equal(ready[0].type, 'tool_call_ready')
  assert.equal(ready[0].toolCall.function.arguments, '{"p":"a"}')
  const done = consumeOpenAIResponsesStreamPayload({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }, state)
  assert.deepEqual(done.map((event) => event.type), ['usage', 'finish'])
  assert.deepEqual(finishOpenAIResponsesStream(state), [], 'a completed stream does not finish twice')
  // An unknown event type is ignored rather than guessed at.
  assert.deepEqual(consumeOpenAIResponsesStreamPayload({ type: 'response.in_progress' }, state), [])
})

test('the pipeline routes the protocol through this adapter, not the compatible path', () => {
  const built = buildModelProviderRequest({
    config: { ...CONFIG, profileOverrides: { kind: 'openai-responses' } },
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }],
    stream: false,
    env: {},
  })
  assert.match(built.url, /\/responses$/u, 'responses goes to /responses, not /chat/completions')
  const parsed = parseNativeProviderResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }, 'openai-responses')
  assert.equal(parsed.content, 'ok')
  const state = { kind: 'openai-responses' }
  const nativeState = consumeNativeProviderStreamPayload({ type: 'response.output_text.delta', delta: 'x' }, { ...createOpenAIResponsesStreamState(), kind: 'openai-responses' })
  assert.deepEqual(nativeState, [{ type: 'text', delta: 'x' }])
  assert.ok(state)
})

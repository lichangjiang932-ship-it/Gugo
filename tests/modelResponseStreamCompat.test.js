import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCompatibleModelStreamState,
  decodeModelStreamLine,
  normalizeCompatibleModelStreamPayload,
} from '../server/adapters/modelResponseStream.js'
import { streamOpenAICompatible } from '../server/adapters/modelProxy.js'

test('Ollama NDJSON exposes content, thinking, complete tool calls, and terminal state', () => {
  const state = createCompatibleModelStreamState()
  const first = decodeModelStreamLine(JSON.stringify({
    message: { content: '', thinking: 'checking files' },
    done: false,
  }))
  assert.equal(first.done, false)
  assert.equal(normalizeCompatibleModelStreamPayload(first.data, state).reasoning, 'checking files')

  const second = normalizeCompatibleModelStreamPayload({
    message: {
      content: 'Ready.',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }],
    },
    done: true,
    done_reason: 'tool_calls',
  }, state)
  assert.equal(second.text, 'Ready.')
  assert.equal(second.toolCallDeltas[0].name, 'read_file')
  assert.equal(second.toolCallDeltas[0].arguments, '{"path":"README.md"}')
  assert.equal(second.toolCallDeltas[0].argumentsMode, 'replace')
  assert.equal(second.finishReason, 'tool_calls')
  assert.equal(second.terminal, true)
})

test('OpenAI legacy streaming function_call is converted to indexed tool deltas', () => {
  const state = createCompatibleModelStreamState()
  const one = normalizeCompatibleModelStreamPayload({
    choices: [{ delta: { function_call: { name: 'write_file', arguments: '{"path":' } } }],
  }, state)
  const two = normalizeCompatibleModelStreamPayload({
    choices: [{ delta: { function_call: { arguments: '"a.txt"}' } }, finish_reason: 'function_call' }],
  }, state)
  assert.deepEqual(one.toolCallDeltas[0], {
    index: 0,
    id: '',
    name: 'write_file',
    arguments: '{"path":',
    argumentsMode: 'append',
  })
  assert.equal(two.toolCallDeltas[0].arguments, '"a.txt"}')
  assert.equal(two.finishReason, 'tool_calls')
})

test('Responses streaming events normalize output text and function arguments', () => {
  const state = createCompatibleModelStreamState()
  const added = normalizeCompatibleModelStreamPayload({
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'function_call', id: 'fc_7', call_id: 'call_7', name: 'apply_patch', arguments: '' },
  }, state)
  const text = normalizeCompatibleModelStreamPayload({
    type: 'response.output_text.delta',
    delta: 'Working now.',
  }, state)
  const args = normalizeCompatibleModelStreamPayload({
    type: 'response.function_call_arguments.done',
    output_index: 1,
    item_id: 'fc_7',
    arguments: { patch: '*** Begin Patch' },
  }, state)
  const completed = normalizeCompatibleModelStreamPayload({ type: 'response.completed' }, state)

  assert.equal(added.toolCallDeltas[0].id, 'call_7')
  assert.equal(added.toolCallDeltas[0].name, 'apply_patch')
  assert.equal(text.text, 'Working now.')
  assert.equal(args.toolCallDeltas[0].arguments, '{"patch":"*** Begin Patch"}')
  assert.equal(args.toolCallDeltas[0].argumentsMode, 'replace')
  assert.equal(completed.terminal, true)
  assert.equal(completed.finishReason, 'tool_calls')
})

test('LM Studio and llama.cpp no-choices frames retain text and tool calls', () => {
  const state = createCompatibleModelStreamState()
  assert.equal(normalizeCompatibleModelStreamPayload({ content: 'token A' }, state).text, 'token A')
  assert.equal(normalizeCompatibleModelStreamPayload({ token: { text: ' token B' } }, state).text, ' token B')

  const frame = normalizeCompatibleModelStreamPayload({
    message: {
      content: ' done',
      tool_calls: [{ id: 'call_local', function: { name: 'list_files', arguments: '{"path":"."}' } }],
    },
    done: true,
  }, state)
  assert.equal(frame.text, ' done')
  assert.equal(frame.toolCallDeltas[0].id, 'call_local')
  assert.equal(frame.toolCallDeltas[0].name, 'list_files')
  assert.equal(frame.terminal, true)
})

test('stream finish normalization keeps length stronger than a partial tool call', () => {
  const state = createCompatibleModelStreamState()
  normalizeCompatibleModelStreamPayload({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'partial',
          function: { name: 'write_file', arguments: '{' },
        }],
      },
    }],
  }, state)
  const terminal = normalizeCompatibleModelStreamPayload({
    choices: [{ delta: {}, finish_reason: 'length' }],
  }, state)

  assert.equal(terminal.finishReason, 'length')
})

test('decodeModelStreamLine accepts SSE variants, NDJSON, and done markers', () => {
  assert.deepEqual(decodeModelStreamLine('data:{"content":"a"}'), { done: false, data: { content: 'a' } })
  assert.deepEqual(decodeModelStreamLine('{"content":"b"}'), { done: false, data: { content: 'b' } })
  assert.deepEqual(decodeModelStreamLine('data: [DONE]'), { done: true, data: null })
  assert.equal(decodeModelStreamLine('event: message'), null)
  assert.equal(decodeModelStreamLine('id: 7'), null)
  assert.equal(decodeModelStreamLine('retry: 1000'), null)
  assert.equal(decodeModelStreamLine('vendor-field: opaque metadata'), null)
  assert.equal(decodeModelStreamLine('data:'), null)
  assert.equal(decodeModelStreamLine('data'), null)
})

test('malformed model data frames fail closed while SSE metadata remains ignorable', () => {
  for (const line of [
    'data: {"choices":[}',
    '{"message":',
    'not-json',
    'data: null',
    'data: 1',
    'data: "text"',
    'data: []',
    'data: {}',
  ]) {
    assert.throws(
      () => decodeModelStreamLine(line),
      (error) => error?.code === 'MODEL_STREAM_MALFORMED_FRAME'
        && error?.fromUpstream === true
        && error?.retryable === false
        && error?.modelRequestOutcome === 'failed',
      line,
    )
  }
})

test('a malformed frame before done rejects without a canonical terminal event', async () => {
  const events = []

  await assert.rejects(
    async () => {
      for await (const event of streamOpenAICompatible({
        config: { baseUrl: 'https://example.test/v1', apiKey: 'x', modelName: 'compatible-model' },
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: async () => new Response('data: null\n\ndata: [DONE]\n\n', { status: 200 }),
        env: {},
      })) events.push(event)
    },
    (error) => error?.code === 'MODEL_STREAM_MALFORMED_FRAME'
      && error?.retryable === false
      && error?.modelRequestOutcome === 'failed',
  )

  assert.deepEqual(events, [])
})

test('compatible safety and unknown finish reasons fail even after tool input', () => {
  const state = createCompatibleModelStreamState()
  normalizeCompatibleModelStreamPayload({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'unsafe',
          function: { name: 'write_file', arguments: '{"path":"unsafe.txt"}' },
        }],
      },
    }],
  }, state)

  for (const finishReason of ['content_filter', 'future_finish_reason']) {
    assert.throws(
      () => normalizeCompatibleModelStreamPayload({
        choices: [{ delta: {}, finish_reason: finishReason }],
      }, state),
      (error) => error?.code === 'MODEL_PROVIDER_STOP_REASON_ERROR'
        && error?.stopReason === finishReason,
      finishReason,
    )
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseModelProviderResponse,
  parseOpenAICompatibleResponse,
} from '../server/adapters/modelProxy.js'

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
    cacheHitTokens: 0,
    cacheMissTokens: 12,
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

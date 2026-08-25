import test from 'node:test'
import assert from 'node:assert/strict'

import { prepareOutboundMessages, retainReasoningForEnv } from '../server/adapters/outboundMessagePipeline.js'
import { buildAssistantToolCallsMessage } from '../server/utils/toolCallHarness.js'

const TOOL_CALLS = [{
  id: 'call_1',
  type: 'function',
  function: { name: 'read_file', arguments: '{"path":"README.md"}' },
}]

test('assistant reasoning_content is stripped from outbound messages by default', () => {
  const message = buildAssistantToolCallsMessage(TOOL_CALLS, '', { reasoning: 'think step by step' })
  assert.equal(message.reasoning_content, 'think step by step')

  const outbound = prepareOutboundMessages({
    messages: [message, { role: 'tool', tool_call_id: 'call_1', content: '{}' }],
    profile: {},
  })
  assert.equal(outbound.some((item) => 'reasoning_content' in item), false)
})

test('MODEL_REASONING_RETENTION=1 keeps assistant reasoning in the outbound request', () => {
  const message = buildAssistantToolCallsMessage(TOOL_CALLS, 'partial answer', { reasoning: 'chain of thought' })
  const outbound = prepareOutboundMessages({
    messages: [message, { role: 'tool', tool_call_id: 'call_1', content: '{}' }],
    profile: {},
    retainReasoning: true,
  })
  const replayed = outbound.find((item) => item.role === 'assistant')
  assert.equal(replayed?.reasoning_content, 'chain of thought')
  assert.equal(Array.isArray(replayed?.tool_calls), true)
})

test('reasoning replay gate never leaks user/tool/system reasoning fields', () => {
  const outbound = prepareOutboundMessages({
    messages: [
      { role: 'user', content: 'hi', reasoning_content: 'user-thought' },
      { role: 'tool', tool_call_id: 'call_1', content: '{}', reasoning_content: 'tool-thought' },
      { role: 'system', content: 'sys', reasoning_content: 'sys-thought' },
    ],
    profile: {},
    retainReasoning: true,
  })
  for (const message of outbound) {
    if (message.role !== 'assistant') assert.equal('reasoning_content' in message, false)
  }
})

test('blank or non-string reasoning never attaches to durable assistant messages', () => {
  assert.equal('reasoning_content' in buildAssistantToolCallsMessage(TOOL_CALLS, '', { reasoning: '   ' }), false)
  assert.equal('reasoning_content' in buildAssistantToolCallsMessage(TOOL_CALLS, '', { reasoning: null }), false)
  assert.equal('reasoning_content' in buildAssistantToolCallsMessage(TOOL_CALLS), false)
})

test('retainReasoningForEnv accepts only explicit 1', () => {
  assert.equal(retainReasoningForEnv({ MODEL_REASONING_RETENTION: '1' }), true)
  assert.equal(retainReasoningForEnv({ MODEL_REASONING_RETENTION: '0' }), false)
  assert.equal(retainReasoningForEnv({ MODEL_REASONING_RETENTION: 'true' }), false)
  assert.equal(retainReasoningForEnv({}), false)
  assert.equal(retainReasoningForEnv(undefined), false)
})

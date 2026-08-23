import assert from 'node:assert/strict'
import test from 'node:test'

import { serializeServerTurnHistory } from '../src/pages/ChatSplit/serverTurnHistory.js'

test('server turn history migration preserves the complete transcript', () => {
  const messages = Array.from({ length: 240 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
  }))

  const serialized = serializeServerTurnHistory(messages)

  assert.equal(serialized.length, messages.length)
  assert.equal(serialized[0].content, 'message-0')
  assert.equal(serialized.at(-1).content, 'message-239')
})

test('server turn history expands assistant meta tool calls and their results', () => {
  const serialized = serializeServerTurnHistory([
    { role: 'user', content: 'Read the project file' },
    {
      role: 'assistant',
      content: 'Checking now.',
      meta: {
        toolCalls: [
          {
            id: 'history-read-1',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
            result: '{"ok":true,"content":"project readme"}',
          },
          {
            id: 'history-grep-1',
            name: 'grep',
            args: { pattern: 'TODO' },
            error: 'permission denied',
          },
        ],
      },
    },
  ])

  assert.deepEqual(serialized.map((message) => message.role), ['user', 'assistant', 'tool', 'tool'])
  assert.deepEqual(serialized[1].tool_calls, [
    {
      id: 'history-read-1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"README.md"}' },
    },
    {
      id: 'history-grep-1',
      type: 'function',
      function: { name: 'grep', arguments: '{"pattern":"TODO"}' },
    },
  ])
  assert.equal(serialized[2].tool_call_id, 'history-read-1')
  assert.equal(serialized[2].content, '{"ok":true,"content":"project readme"}')
  assert.equal(JSON.parse(serialized[3].content).error, 'permission denied')
})

test('server turn history uses an explicit tool message without duplicating it', () => {
  const serialized = serializeServerTurnHistory([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'existing-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'existing-1', name: 'read_file', content: 'explicit result' },
  ])

  assert.deepEqual(serialized.map((message) => message.role), ['assistant', 'tool'])
  assert.equal(serialized[1].content, 'explicit result')
})

test('server turn history excludes failed UI placeholders and configuration errors', () => {
  const serialized = serializeServerTurnHistory([
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: '模型服务尚未正确配置', meta: { failed: true } },
    { role: 'assistant', content: 'valid reply' },
    { role: 'tool', tool_call_id: 'failed-tool', content: 'failed result', meta: { failed: true } },
  ])
  assert.deepEqual(serialized, [
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: 'valid reply' },
  ])
})

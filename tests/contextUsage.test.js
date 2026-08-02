import assert from 'node:assert/strict'
import test from 'node:test'

import {
  estimateClientContextUsage,
  estimateTextTokens,
} from '../src/lib/contextUsage.js'

test('client token estimate charges non-ASCII more heavily than ASCII', () => {
  assert.equal(estimateTextTokens('abcd'), 1)
  assert.equal(estimateTextTokens('中文'), 2)
})

test('client context estimate includes tool calls, attachments, and tool specs', () => {
  const base = estimateClientContextUsage({
    messages: [{ role: 'user', content: 'hello' }],
    contextWindow: 1000,
  })
  const complete = estimateClientContextUsage({
    messages: [{
      role: 'user',
      content: 'hello',
      meta: {
        toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' }, result: 'done' }],
        attachments: [{ name: 'notes.txt', kind: 'text', sizeKB: 1, text: '附件内容' }],
      },
    }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    contextWindow: 1000,
  })

  assert.ok(complete.estimatedTokens > base.estimatedTokens)
  assert.ok(complete.toolCallTokens > 0)
  assert.ok(complete.attachmentTokens > 0)
  assert.ok(complete.toolSpecTokens > 0)
  assert.equal(complete.visibleCharacters, 5)
})

test('client context estimate includes the actual system prompt', () => {
  const withoutSystem = estimateClientContextUsage({
    messages: [{ role: 'user', content: 'hello' }],
    contextWindow: 1_000_000,
  })
  const systemPrompt = 'Always answer in Chinese. '.repeat(200)
  const withSystem = estimateClientContextUsage({
    messages: [{ role: 'user', content: 'hello' }],
    systemPrompt,
    contextWindow: 1_000_000,
  })
  assert.equal(
    withSystem.systemTokens - withoutSystem.systemTokens,
    estimateTextTokens(systemPrompt),
  )
  assert.ok(withSystem.estimatedTokens > withoutSystem.estimatedTokens)
})

test('client context percent is bounded and invalid windows use the default', () => {
  const usage = estimateClientContextUsage({
    messages: [{ role: 'user', content: '中'.repeat(1000) }],
    contextWindow: 10,
  })
  assert.equal(usage.percent, 100)
  assert.equal(estimateClientContextUsage({ contextWindow: 0 }).contextWindow, 1_000_000)
})

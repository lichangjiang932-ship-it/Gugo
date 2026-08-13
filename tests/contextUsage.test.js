import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  estimateClientContextUsage,
  estimateTextTokens,
  normalizeContextWindow,
  resolveModelContextWindow,
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
  assert.equal(estimateClientContextUsage({ contextWindow: 0 }).contextWindow, DEFAULT_MODEL_CONTEXT_WINDOW)
  assert.equal(estimateClientContextUsage().contextWindow, 128_000)
})

test('context window normalization is conservative for invalid model metadata', () => {
  assert.equal(normalizeContextWindow('32768'), 32_768)
  assert.equal(normalizeContextWindow(32_768.9), 32_768)
  assert.equal(normalizeContextWindow(-1), DEFAULT_MODEL_CONTEXT_WINDOW)
  assert.equal(normalizeContextWindow(undefined, 0), DEFAULT_MODEL_CONTEXT_WINDOW)
})

test('selected model context window follows model switches and falls back conservatively', () => {
  const models = [
    { name: 'small-model', contextWindow: 8_192 },
    { name: 'large-model', contextWindow: 262_144 },
  ]

  assert.equal(resolveModelContextWindow(models, 'small-model'), 8_192)
  assert.equal(resolveModelContextWindow(models, 'large-model'), 262_144)
  assert.equal(resolveModelContextWindow(models, 'unknown-model'), DEFAULT_MODEL_CONTEXT_WINDOW)
})

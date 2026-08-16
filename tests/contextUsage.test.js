import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  estimateClientContextUsage,
  estimateTextTokens,
  normalizeContextWindow,
  normalizeOptionalTokenCount,
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

test('client context estimate treats a large inline image as visual input instead of base64 text', () => {
  const oneMegabyteImage = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
  const usage = estimateClientContextUsage({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Please inspect this screenshot.' },
        { type: 'image_url', image_url: { url: oneMegabyteImage } },
      ],
    }],
    contextWindow: 128_000,
  })

  assert.equal(usage.imageTokens, 256)
  assert.ok(usage.estimatedTokens < 1_000)
  assert.ok(usage.percent < 2)
  assert.equal(usage.visibleCharacters, 'Please inspect this screenshot.'.length)
})

test('client context estimate does not count extracted attachment text twice when it is already in content', () => {
  const extractedText = 'Release notes include the completed migration and verification results. '.repeat(200)
  const content = `Attached file contents:\n${extractedText}`
  const withoutAttachment = estimateClientContextUsage({
    messages: [{ role: 'user', content }],
  })
  const duplicatedAttachment = estimateClientContextUsage({
    messages: [{
      role: 'user',
      content,
      meta: {
        attachments: [{ name: 'notes.txt', kind: 'text', sizeKB: 14, text: extractedText }],
      },
    }],
  })

  assert.ok(duplicatedAttachment.attachmentTokens > 0, 'attachment metadata should still be represented')
  assert.ok(duplicatedAttachment.attachmentTokens < 50, 'the duplicated extracted body should be omitted')
  assert.ok(duplicatedAttachment.estimatedTokens - withoutAttachment.estimatedTokens < 50)
})

test('client context estimate still charges ordinary non-duplicated text, tools, and attachments', () => {
  const base = estimateClientContextUsage({ messages: [{ role: 'user', content: 'Summarize the inputs.' }] })
  const usage = estimateClientContextUsage({
    messages: [{
      role: 'user',
      content: 'Summarize the inputs.',
      meta: {
        toolCalls: [{ name: 'read_file', args: { path: 'brief.txt' }, result: 'read successfully' }],
        attachments: [{ name: 'brief.txt', kind: 'text', sizeKB: 1, text: 'Unique attachment body.' }],
      },
    }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
  })

  assert.ok(usage.messageTokens >= base.messageTokens)
  assert.ok(usage.toolCallTokens > 0)
  assert.ok(usage.attachmentTokens >= estimateTextTokens('Unique attachment body.'))
  assert.ok(usage.toolSpecTokens > 0)
  assert.ok(usage.estimatedTokens > base.estimatedTokens)
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

test('client context usage retains a measured zero instead of falling back to the estimate', () => {
  const usage = estimateClientContextUsage({
    messages: [{ role: 'user', content: 'This still has an estimate.' }],
    actualPromptTokens: 0,
  })
  assert.equal(usage.actualPromptTokens, 0)
  assert.ok(usage.estimatedTokens > 0)
})

test('missing measured usage stays absent so the UI can use its estimate', () => {
  for (const actualPromptTokens of [null, undefined, '', '   ', false]) {
    const usage = estimateClientContextUsage({
      messages: [{ role: 'user', content: 'This needs an estimate.' }],
      actualPromptTokens,
    })
    assert.equal(Object.hasOwn(usage, 'actualPromptTokens'), false)
    assert.ok(usage.estimatedTokens > 0)
  }
  assert.equal(normalizeOptionalTokenCount(0), 0)
  assert.equal(normalizeOptionalTokenCount('42'), 42)
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

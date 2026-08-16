import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachManualCompactionArchive,
  fitManualCompactionResult,
  resolveCompactionModelContext,
} from '../server/routes/compactionRoutes.js'
import { buildCompaction } from '../server/services/compactionService.js'
import { estimateContextTokens } from '../server/services/contextCompactionRuntime.js'

test('manual compaction resolves and invokes the explicitly selected model', async () => {
  let resolvedWith = null
  let invokedWith = null
  const signal = new AbortController().signal
  const messages = [{ role: 'user', content: 'compact this' }]
  const context = resolveCompactionModelContext({
    userId: 'user-1',
    modelName: '  long-context-model  ',
    resolveContextWindow: (request) => {
      resolvedWith = request
      return 256_000
    },
    invokeModel: async (request) => {
      invokedWith = request
      return { content: 'summary' }
    },
  })

  assert.equal(context.modelName, 'long-context-model')
  assert.equal(context.contextWindow, 256_000)
  assert.deepEqual(resolvedWith, { userId: 'user-1', modelName: 'long-context-model' })
  assert.deepEqual(await context.callModel({ messages, signal }), { content: 'summary' })
  assert.deepEqual(invokedWith, {
    userId: 'user-1',
    modelName: 'long-context-model',
    messages,
    signal,
  })
})

test('manual compaction preserves backend-default model selection when omitted', async () => {
  let resolvedWith = null
  let invokedWith = null
  const context = resolveCompactionModelContext({
    userId: 'user-2',
    modelName: '   ',
    resolveContextWindow: (request) => {
      resolvedWith = request
      return 128_000
    },
    invokeModel: async (request) => {
      invokedWith = request
      return { content: 'default summary' }
    },
  })

  await context.callModel({ messages: [] })
  assert.deepEqual(resolvedWith, { userId: 'user-2', modelName: undefined })
  assert.equal(invokedWith.modelName, undefined)
})

test('manual compaction bounds and remeasures the final outbound surface', () => {
  const messages = [
    { role: 'user', content: `original objective ${'x'.repeat(48_000)}` },
    { role: 'assistant', content: 'older progress' },
    { role: 'user', content: 'latest request' },
  ]
  const result = buildCompaction({ messages, keepMessages: 1, force: true })
  assert.equal(result.ok, true)
  assert.equal(result.compacted, true)

  const fit = fitManualCompactionResult(result, { contextWindow: 16_000 })

  assert.equal(fit.ok, true)
  assert.equal(fit.summaryTruncated, true)
  assert.ok(fit.estimatedTokens < fit.threshold)
  assert.equal(
    estimateContextTokens(fit.result.outboundMessages, []),
    fit.estimatedTokens,
  )
})

test('manual compaction refuses a retained tail that cannot fit the model window', () => {
  const messages = [
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old response' },
    { role: 'user', content: 'z'.repeat(80_000) },
  ]
  const result = buildCompaction({ messages, keepMessages: 1, force: true })
  const fit = fitManualCompactionResult(result, { contextWindow: 8_000 })

  assert.equal(fit.ok, false)
  assert.ok(fit.estimatedTokens >= fit.threshold - 64)
})

test('adding an archive id replaces only the exact summary message', () => {
  const systemMessage = { role: 'system', content: 'keep me' }
  const summaryMessage = { role: 'assistant', content: 'summary', meta: { compaction: true } }
  const tailMessage = { role: 'user', content: 'keep me too' }
  const attached = attachManualCompactionArchive({
    summaryMessage,
    outboundMessages: [systemMessage, summaryMessage, tailMessage],
  }, 'archive-1')

  assert.equal(attached.outboundMessages[0], systemMessage)
  assert.equal(attached.outboundMessages[1], attached.summaryMessage)
  assert.equal(attached.outboundMessages[2], tailMessage)
  assert.equal(attached.summaryMessage.meta.archiveId, 'archive-1')
})

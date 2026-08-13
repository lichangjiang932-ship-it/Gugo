import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCompactionModelContext } from '../server/routes/compactionRoutes.js'

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

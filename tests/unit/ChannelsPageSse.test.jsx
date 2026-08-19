import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeChannelMessages, startChannelMessageSync } from '../../src/lib/channelClient.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('channel reconciliation replaces duplicates and orders missed messages', () => {
  const merged = mergeChannelMessages(
    [
      { id: 'one', createdAt: 1, content: 'old' },
      { id: 'three', createdAt: 3, content: 'third' },
    ],
    [
      { id: 'one', createdAt: 1, content: 'fresh' },
      { id: 'two', createdAt: 2, content: 'second' },
    ],
  )
  assert.deepEqual(merged.map(({ id }) => id), ['one', 'two', 'three'])
  assert.equal(merged[0].content, 'fresh')
})

test('channel ready events reconcile through REST and cleanup ignores late results', async () => {
  const late = deferred()
  const listCalls = []
  const responses = [
    Promise.resolve({ messages: [{ id: 'one', createdAt: 1, content: 'initial' }] }),
    Promise.resolve({ messages: [
      { id: 'one', createdAt: 1, content: 'reconciled' },
      { id: 'three', createdAt: 3, content: 'missed while disconnected' },
    ] }),
    late.promise,
  ]
  let messages = []
  let streamMessage
  let connectionChange
  let closed = false
  const close = startChannelMessageSync({
    channelId: 'channel-1',
    applyMessages: (incoming) => {
      messages = mergeChannelMessages(messages, incoming)
    },
    listMessages: async (...args) => {
      listCalls.push(args)
      return responses.shift()
    },
    subscribe: (channelId, onMessage, options) => {
      assert.equal(channelId, 'channel-1')
      streamMessage = onMessage
      connectionChange = options.onConnectionChange
      return () => { closed = true }
    },
  })

  await flush()
  streamMessage({ id: 'two', createdAt: 2, content: 'live' })
  connectionChange({ state: 'open' })
  await flush()
  assert.deepEqual(messages.map(({ id }) => id), ['one', 'two', 'three'])
  assert.equal(messages.find(({ id }) => id === 'one').content, 'reconciled')
  assert.equal(listCalls.length, 2)

  connectionChange({ state: 'open' })
  close()
  late.resolve({ messages: [{ id: 'four', createdAt: 4, content: 'late' }] })
  await flush()
  assert.equal(closed, true)
  assert.equal(listCalls.length, 3)
  assert.deepEqual(messages.map(({ id }) => id), ['one', 'two', 'three'])
})

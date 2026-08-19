import assert from 'node:assert/strict'
import test from 'node:test'
import { subscribeToChannelMessages } from '../src/lib/channelClient.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('channel subscription uses a channel-scoped ticket and parses messages', async () => {
  const calls = []
  const received = []
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      instances.push(this)
    }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    emit(type, data) { this.listeners.get(type)?.(data) }
    close() {}
  }

  const unsubscribe = subscribeToChannelMessages('team / alpha', (message) => received.push(message), {
    EventSourceImpl: FakeEventSource,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 201, json: async () => ({ ticket: 'channel ticket' }) }
    },
  })
  await flush()

  assert.equal(calls[0].url, '/api/channels/team%20%2F%20alpha/stream-ticket')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(instances[0].url, '/api/channels/team%20%2F%20alpha/stream?ticket=channel%20ticket')
  assert.doesNotMatch(instances[0].url, /token=/)
  instances[0].emit('channel_message', { data: '{"id":"message-1"}' })
  instances[0].emit('channel_message', { data: '{broken' })
  assert.deepEqual(received, [{ id: 'message-1' }])
  unsubscribe()
})

test('switching channels cancels a late ticket before it can open the old stream', async () => {
  const pendingA = deferred()
  const pendingB = deferred()
  const opened = []
  class FakeEventSource {
    constructor(url) { opened.push(url) }
    addEventListener() {}
    close() {}
  }
  const fetchImpl = (url) => url.includes('/channel-a/') ? pendingA.promise : pendingB.promise

  const closeA = subscribeToChannelMessages('channel-a', () => {}, {
    EventSourceImpl: FakeEventSource,
    fetchImpl,
    AbortControllerImpl: null,
  })
  closeA()
  const closeB = subscribeToChannelMessages('channel-b', () => {}, {
    EventSourceImpl: FakeEventSource,
    fetchImpl,
    AbortControllerImpl: null,
  })

  pendingB.resolve({ ok: true, status: 201, json: async () => ({ ticket: 'ticket-b' }) })
  await flush()
  pendingA.resolve({ ok: true, status: 201, json: async () => ({ ticket: 'ticket-a' }) })
  await flush()

  assert.deepEqual(opened, ['/api/channels/channel-b/stream?ticket=ticket-b'])
  closeB()
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { subscribeToTicketedSse } from '../src/lib/ticketedSseClient.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function eventSourceHarness() {
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.closed = false
      this.listeners = new Map()
      instances.push(this)
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }

    emit(type, data = {}) {
      for (const listener of this.listeners.get(type) || []) listener(data)
    }

    close() {
      this.closed = true
    }
  }
  return { FakeEventSource, instances }
}

function timerHarness() {
  const timers = []
  return {
    timers,
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutImpl(timer) {
      timer.cleared = true
    },
  }
}

test('ticketed SSE exchanges with POST and never puts account auth in the stream URL', async () => {
  const calls = []
  const states = []
  const events = []
  const { FakeEventSource, instances } = eventSourceHarness()
  const unsubscribe = subscribeToTicketedSse({
    ticketUrl: '/api/example/stream-ticket',
    streamUrl: (ticket) => `/api/example/stream?ticket=${encodeURIComponent(ticket)}`,
    eventName: 'message',
    onEvent: (event) => events.push(event.data),
    headers: () => ({ Authorization: 'Bearer account-secret' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 201, json: async () => ({ ticket: 'st one' }) }
    },
    EventSourceImpl: FakeEventSource,
    onConnectionChange: ({ state }) => states.push(state),
  })

  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/example/stream-ticket')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer account-secret')
  assert.equal(instances[0].url, '/api/example/stream?ticket=st%20one')
  assert.doesNotMatch(instances[0].url, /account-secret|token=/)

  instances[0].emit('ready')
  instances[0].emit('message', { data: 'payload' })
  assert.deepEqual(states.slice(0, 2), ['connecting', 'open'])
  assert.deepEqual(events, ['payload'])

  unsubscribe()
  assert.equal(instances[0].closed, true)
  assert.equal(states.at(-1), 'closed')
})

test('stream errors close the source, re-ticket, and ready resets exponential backoff', async () => {
  const tickets = ['first', 'second', 'third', 'fourth']
  const calls = []
  const states = []
  const { FakeEventSource, instances } = eventSourceHarness()
  const timers = timerHarness()
  const unsubscribe = subscribeToTicketedSse({
    ticketUrl: '/ticket',
    streamUrl: (ticket) => `/stream?ticket=${ticket}`,
    eventName: 'message',
    onEvent: () => {},
    fetchImpl: async (url) => {
      calls.push(url)
      return { ok: true, status: 201, json: async () => ({ ticket: tickets.shift() }) }
    },
    EventSourceImpl: FakeEventSource,
    retryBaseMs: 25,
    retryMaxMs: 100,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    onConnectionChange: (state) => states.push(state),
  })

  await flush()
  instances[0].emit('error')
  assert.equal(instances[0].closed, true)
  assert.equal(timers.timers[0].delay, 25)
  timers.timers[0].callback()
  await flush()
  assert.equal(instances[1].url, '/stream?ticket=second')

  instances[1].emit('error')
  assert.equal(timers.timers[1].delay, 50)
  timers.timers[1].callback()
  await flush()
  instances[2].emit('ready')
  instances[2].emit('error')
  assert.equal(timers.timers[2].delay, 25)
  timers.timers[2].callback()
  await flush()

  assert.equal(calls.length, 4)
  assert.equal(instances[3].url, '/stream?ticket=fourth')
  assert.equal(states.filter(({ state }) => state === 'open').length, 1)
  unsubscribe()
})

for (const status of [401, 403]) {
  test(`ticket exchange ${status} terminates without retrying`, async () => {
    const calls = []
    const states = []
    const { FakeEventSource, instances } = eventSourceHarness()
    const timers = timerHarness()
    subscribeToTicketedSse({
      ticketUrl: '/ticket',
      streamUrl: (ticket) => `/stream?ticket=${ticket}`,
      eventName: 'message',
      onEvent: () => {},
      fetchImpl: async () => {
        calls.push(status)
        return { ok: false, status, json: async () => ({}) }
      },
      EventSourceImpl: FakeEventSource,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      onConnectionChange: (state) => states.push(state),
    })

    await flush()
    assert.equal(calls.length, 1)
    assert.equal(instances.length, 0)
    assert.equal(timers.timers.length, 0)
    assert.deepEqual(states.at(-1), { state: 'unauthorized', status })
  })
}

test('unsubscribe invalidates a late ticket response even when fetch cannot be aborted', async () => {
  let resolveTicket
  const responsePromise = new Promise((resolve) => { resolveTicket = resolve })
  const states = []
  const { FakeEventSource, instances } = eventSourceHarness()
  const unsubscribe = subscribeToTicketedSse({
    ticketUrl: '/ticket',
    streamUrl: (ticket) => `/stream?ticket=${ticket}`,
    eventName: 'message',
    onEvent: () => {},
    fetchImpl: () => responsePromise,
    EventSourceImpl: FakeEventSource,
    AbortControllerImpl: null,
    onConnectionChange: ({ state }) => states.push(state),
  })

  unsubscribe()
  resolveTicket({ ok: true, status: 201, json: async () => ({ ticket: 'late' }) })
  await flush()
  assert.equal(instances.length, 0)
  assert.deepEqual(states, ['connecting', 'closed'])
})

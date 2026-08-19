import assert from 'node:assert/strict'
import test from 'node:test'
import { setAuthToken } from '../src/lib/accountClient.js'
import { subscribeToNotifications } from '../src/lib/notificationClient.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

test('notification subscription exchanges a ticket and parses notification events', async () => {
  const previousWindow = globalThis.window
  globalThis.window = { localStorage: memoryStorage(), sessionStorage: memoryStorage() }
  setAuthToken('notification-account-token')
  const calls = []
  const received = []
  const instances = []
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      this.closed = false
      instances.push(this)
    }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    emit(type, data) { this.listeners.get(type)?.(data) }
    close() { this.closed = true }
  }

  try {
    const unsubscribe = subscribeToNotifications((notification) => received.push(notification), {
      EventSourceImpl: FakeEventSource,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return { ok: true, status: 201, json: async () => ({ ticket: 'notification-ticket' }) }
      },
    })
    await flush()

    assert.equal(calls[0].url, '/api/notifications/stream-ticket')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer notification-account-token')
    assert.equal(instances[0].url, '/api/notifications/stream?ticket=notification-ticket')
    assert.doesNotMatch(instances[0].url, /notification-account-token|token=/)
    instances[0].emit('notification', { data: '{"id":"notice-1"}' })
    instances[0].emit('notification', { data: 'not-json' })
    assert.deepEqual(received, [{ id: 'notice-1' }])

    unsubscribe()
    assert.equal(instances[0].closed, true)
  } finally {
    setAuthToken('')
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

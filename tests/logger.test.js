import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logWarn, logError } from '../server/utils/logger.js'

test('logWarn emits a structured warn line including scope and message', () => {
  const calls = []
  const sink = { warn: (m) => calls.push(m), error: () => {} }
  logWarn('memory.inject', 'failed to inject', { userId: 'u1' }, sink)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /memory\.inject/)
  assert.match(calls[0], /failed to inject/)
  assert.match(calls[0], /u1/)
})

test('logError emits a structured error line and serializes Error objects', () => {
  const calls = []
  const sink = { warn: () => {}, error: (m) => calls.push(m) }
  logError('agent.inject', new Error('boom'), { jobId: 'j2' }, sink)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /agent\.inject/)
  assert.match(calls[0], /boom/)
  assert.match(calls[0], /j2/)
})

test('logWarn always emits regardless of NODE_ENV (production observability)', () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const calls = []
    const sink = { warn: (m) => calls.push(m), error: () => {} }
    logWarn('x', 'y', {}, sink)
    assert.equal(calls.length, 1, 'must log in production too')
  } finally {
    process.env.NODE_ENV = prev
  }
})

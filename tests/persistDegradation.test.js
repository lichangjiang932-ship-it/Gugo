import assert from 'node:assert/strict'
import test from 'node:test'
import { persistWithDegradation } from '../src/store/persistDegradation.js'

function quotaError() {
  const error = new Error('QuotaExceededError: localStorage is full')
  error.name = 'QuotaExceededError'
  error.code = 22
  return error
}

test('persistWithDegradation writes a full snapshot when capacity is available', () => {
  const stored = new Map()
  const snapshot = { sessions: [{ id: 's1', messages: [{ id: 'm1', role: 'user', content: 'hello' }] }] }
  const result = persistWithDegradation(snapshot, (key, value) => stored.set(key, value))
  assert.equal(result.ok, true)
  assert.equal(result.level, 'full')
  assert.equal(JSON.parse([...stored.values()][0]).sessions[0].messages[0].content, 'hello')
})

test('quota fallback only compacts regenerable metadata and keeps every session and message body', () => {
  const stored = new Map()
  let calls = 0
  const snapshot = {
    sessions: Array.from({ length: 7 }, (_, sessionIndex) => ({
      id: `s${sessionIndex}`,
      messages: Array.from({ length: 75 }, (_, messageIndex) => ({
        id: `${sessionIndex}-${messageIndex}`,
        role: messageIndex % 2 ? 'assistant' : 'user',
        content: `message-${sessionIndex}-${messageIndex}`,
        meta: { dataUrl: `data:image/png;base64,${'x'.repeat(4_000)}` },
      })),
    })),
  }
  const result = persistWithDegradation(snapshot, (key, value) => {
    calls += 1
    if (calls === 1) throw quotaError()
    stored.set(key, value)
  })

  assert.equal(result.ok, true)
  assert.equal(result.level, 'compact-metadata')
  assert.equal(result.requiresUserAction, true)
  const saved = JSON.parse([...stored.values()][0])
  assert.equal(saved.sessions.length, 7)
  assert.equal(saved.sessions.every((item) => item.messages.length === 75), true)
  assert.equal(saved.sessions[6].messages[74].content, 'message-6-74')
  assert.match(saved.sessions[0].messages[0].meta.dataUrl, /OMITTED/)
})

test('when compact metadata still exceeds quota the previous successful snapshot is left untouched', () => {
  const stored = new Map([['your-model-atelier:state:v1', JSON.stringify({ sessions: [{ id: 'safe' }] })]])
  const result = persistWithDegradation(
    { sessions: [{ id: 'current', messages: [{ id: 'm', role: 'user', content: 'current' }] }] },
    () => { throw quotaError() },
  )
  assert.equal(result.ok, false)
  assert.equal(result.level, 'quota')
  assert.equal(result.requiresUserAction, true)
  assert.deepEqual(JSON.parse(stored.get('your-model-atelier:state:v1')), { sessions: [{ id: 'safe' }] })
})

test('non-quota storage errors do not trigger fallback writes', () => {
  let calls = 0
  const result = persistWithDegradation({ sessions: [] }, () => {
    calls += 1
    throw new Error('storage disabled')
  })
  assert.equal(result.ok, false)
  assert.equal(result.level, 'error')
  assert.equal(calls, 1)
})

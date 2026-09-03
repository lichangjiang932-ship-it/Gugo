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
  const snapshot = {
    sessions: [{ id: 's1', messages: [{ id: 'm1', role: 'user', content: 'hello' }] }],
    theme: 'dark',
  }
  const result = persistWithDegradation(snapshot, (key, value) => stored.set(key, value))
  assert.equal(result.ok, true)
  assert.equal(result.level, 'full')
  const saved = JSON.parse([...stored.values()][0])
  assert.equal(saved.theme, 'dark')
  assert.equal(Object.hasOwn(saved, 'sessions'), false)
  assert.doesNotMatch(JSON.stringify(saved), /hello/)
})

test('localStorage fallback strips every retired browser field and keeps settings', () => {
  const stored = new Map()
  const result = persistWithDegradation({
    user: { plan: 'legacy' },
    isLoggedIn: true,
    sessions: [{ id: 's1', messages: [{ id: 'm1', content: 'keep' }] }],
    toolsConfig: { fetch_url: false },
    customSetting: { keep: true },
    __sync: { fields: { user: 1, isLoggedIn: 1, sessions: 1 } },
  }, (key, value) => stored.set(key, value))

  assert.equal(result.ok, true)
  const saved = JSON.parse([...stored.values()][0])
  assert.equal(Object.hasOwn(saved, 'user'), false)
  assert.equal(Object.hasOwn(saved, 'isLoggedIn'), false)
  assert.equal(Object.hasOwn(saved.__sync.fields, 'user'), false)
  assert.equal(Object.hasOwn(saved.__sync.fields, 'isLoggedIn'), false)
  assert.equal(Object.hasOwn(saved.__sync.fields, 'sessions'), false)
  assert.equal(Object.hasOwn(saved, 'sessions'), false)
  assert.deepEqual(saved.toolsConfig, { fetch_url: false })
  assert.deepEqual(saved.customSetting, { keep: true })
})

test('quota fallback compacts regenerable metadata without recreating browser sessions', () => {
  const stored = new Map()
  let calls = 0
  const snapshot = {
    sessions: [{ id: 'retired', messages: [{ content: 'must-not-persist' }] }],
    tasks: [{ id: 't1', label: 'keep', meta: { dataUrl: `data:image/png;base64,${'x'.repeat(4_000)}` } }],
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
  assert.equal(Object.hasOwn(saved, 'sessions'), false)
  assert.equal(saved.tasks[0].label, 'keep')
  assert.match(saved.tasks[0].meta.dataUrl, /OMITTED/)
  assert.doesNotMatch(JSON.stringify(saved), /must-not-persist/)
})

test('when compact metadata still exceeds quota the previous successful snapshot is left untouched', () => {
  const stored = new Map([['your-model-atelier:state:v1', JSON.stringify({ theme: 'light' })]])
  const result = persistWithDegradation(
    { sessions: [{ id: 'current', messages: [{ id: 'm', role: 'user', content: 'current' }] }] },
    () => { throw quotaError() },
  )
  assert.equal(result.ok, false)
  assert.equal(result.level, 'quota')
  assert.equal(result.requiresUserAction, true)
  assert.deepEqual(JSON.parse(stored.get('your-model-atelier:state:v1')), { theme: 'light' })
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

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearPersistedSnapshot,
  createSessionSnapshotStore,
  estimatePersistedSnapshotBytes,
  readPersistedSnapshot,
  SESSION_SNAPSHOT_DB_NAME,
  SESSION_SNAPSHOT_DB_VERSION,
  SESSION_SNAPSHOT_RECORD_KEY,
  SESSION_SNAPSHOT_STORE_NAME,
  writePersistedSnapshot,
} from '../src/store/indexedDbPersistence.js'

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createFakeIndexedDB({ openError = null, putError = null } = {}) {
  const records = new Map()
  const stores = new Set()
  const stats = { opens: [], transactions: [], puts: [], deletes: [] }

  const complete = (transaction) => queueMicrotask(() => transaction.oncomplete?.())
  const fail = (request, transaction, error) => queueMicrotask(() => {
    request.error = error
    transaction.error = error
    request.onerror?.()
    transaction.onabort?.()
  })
  const successfulRequest = (transaction, operation) => {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null }
    queueMicrotask(() => {
      request.result = operation()
      request.onsuccess?.()
      complete(transaction)
    })
    return request
  }

  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) {
      stores.add(name)
    },
    transaction(name, mode) {
      if (!stores.has(name)) throw new Error(`missing object store: ${name}`)
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            put(value) {
              stats.puts.push(clone(value))
              if (!putError) return successfulRequest(transaction, () => {
                records.set(value.key, clone(value))
                return value.key
              })
              const request = { result: undefined, error: null, onsuccess: null, onerror: null }
              fail(request, transaction, putError)
              return request
            },
            get(key) {
              return successfulRequest(transaction, () => clone(records.get(key)))
            },
            delete(key) {
              stats.deletes.push(key)
              return successfulRequest(transaction, () => records.delete(key))
            },
          }
        },
      }
      stats.transactions.push({ name, mode })
      return transaction
    },
    close() {},
    onversionchange: null,
  }

  return {
    records,
    stats,
    open(name, version) {
      stats.opens.push({ name, version })
      const request = { result: database, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }
      queueMicrotask(() => {
        if (openError) {
          request.error = openError
          request.onerror?.()
          return
        }
        if (!stores.size) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
}

function namedError(name, message = name) {
  const error = new Error(message)
  error.name = name
  return error
}

test('IndexedDB session snapshot constants are stable', () => {
  assert.equal(SESSION_SNAPSHOT_DB_NAME, 'your-model-atelier:session-snapshots')
  assert.equal(SESSION_SNAPSHOT_DB_VERSION, 1)
  assert.equal(SESSION_SNAPSHOT_STORE_NAME, 'snapshots')
  assert.equal(SESSION_SNAPSHOT_RECORD_KEY, 'session-domain')
})

test('persisted snapshot APIs atomically round-trip, estimate, and clear the complete payload', async () => {
  const factory = createFakeIndexedDB()
  const payload = {
    sessions: [{ id: 's1', messages: [{ id: 'm1', content: 'hello' }] }],
    tasks: [{ id: 't1', status: 'running' }],
    history: [{ id: 'h1', name: 'task' }],
    sessionDrafts: { s1: 'draft' },
    activeSessionId: 's1',
    __sync: { version: 1, writtenAt: 123456, fields: { activeSessionId: 123456 } },
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength

  const write = await writePersistedSnapshot(payload, { factory, now: () => 123456 })
  assert.deepEqual(write, { ok: true, status: 'ok', payload, updatedAt: 123456, bytes })
  assert.equal(write.payload, payload)
  assert.deepEqual(await readPersistedSnapshot({ factory }), { ok: true, status: 'ok', payload, updatedAt: 123456 })
  assert.deepEqual(await estimatePersistedSnapshotBytes({ factory }), { ok: true, status: 'ok', bytes })
  assert.deepEqual(await clearPersistedSnapshot({ factory }), { ok: true, status: 'ok' })
  assert.deepEqual(await readPersistedSnapshot({ factory }), { ok: true, status: 'ok', payload: null, updatedAt: null })

  assert.deepEqual(factory.stats.opens, [{ name: SESSION_SNAPSHOT_DB_NAME, version: SESSION_SNAPSHOT_DB_VERSION }])
  assert.equal(factory.stats.puts.length, 1)
  assert.equal(factory.stats.puts[0].key, SESSION_SNAPSHOT_RECORD_KEY)
  assert.deepEqual(factory.stats.puts[0].payload, payload)
  assert.deepEqual(factory.stats.deletes, [SESSION_SNAPSHOT_RECORD_KEY])
  assert.deepEqual(factory.stats.transactions.map(({ mode }) => mode), ['readwrite', 'readonly', 'readonly', 'readwrite', 'readonly'])
})

test('IndexedDB writes remove retired account fields without changing sessions or settings', async () => {
  const factory = createFakeIndexedDB()
  const result = await writePersistedSnapshot({
    user: { plan: 'legacy' },
    isLoggedIn: true,
    sessions: [{ id: 'safe', messages: [{ id: 'm1', content: 'keep' }] }],
    toolsConfig: { fetch_url: false },
    customSetting: { keep: true },
    __sync: { fields: { user: 10, isLoggedIn: 10, sessions: 10 } },
  }, { factory, now: () => 10 })

  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(result.payload, 'user'), false)
  assert.equal(Object.hasOwn(result.payload, 'isLoggedIn'), false)
  assert.equal(Object.hasOwn(result.payload.__sync.fields, 'user'), false)
  assert.equal(Object.hasOwn(result.payload.__sync.fields, 'isLoggedIn'), false)
  assert.equal(result.payload.sessions[0].messages[0].content, 'keep')
  assert.deepEqual(result.payload.toolsConfig, { fetch_url: false })
  assert.deepEqual(result.payload.customSetting, { keep: true })
  assert.deepEqual(factory.records.get(SESSION_SNAPSHOT_RECORD_KEY).payload, result.payload)
})

test('IndexedDB reads rewrite legacy records in place and preserve their timestamp and current data', async () => {
  const factory = createFakeIndexedDB()
  await estimatePersistedSnapshotBytes({ factory })
  factory.records.set(SESSION_SNAPSHOT_RECORD_KEY, {
    key: SESSION_SNAPSHOT_RECORD_KEY,
    schemaVersion: SESSION_SNAPSHOT_DB_VERSION,
    updatedAt: 77,
    bytes: 1,
    payload: {
      user: { plan: 'legacy' },
      isLoggedIn: true,
      sessions: [{ id: 'safe', messages: [{ id: 'm1', content: 'keep' }] }],
      toolsConfig: { fetch_url: false },
      __sync: { fields: { user: 77, isLoggedIn: 77, sessions: 77 } },
    },
  })

  const result = await readPersistedSnapshot({ factory })
  assert.equal(result.ok, true)
  assert.equal(result.updatedAt, 77)
  assert.deepEqual(result.retiredAccountFieldsRemoved.sort(), ['isLoggedIn', 'user'])
  assert.equal(Object.hasOwn(result.payload, 'user'), false)
  assert.equal(Object.hasOwn(result.payload, 'isLoggedIn'), false)
  assert.equal(result.payload.sessions[0].messages[0].content, 'keep')
  assert.deepEqual(result.payload.toolsConfig, { fetch_url: false })

  const stored = factory.records.get(SESSION_SNAPSHOT_RECORD_KEY)
  assert.equal(stored.updatedAt, 77)
  assert.equal(Object.hasOwn(stored.payload, 'user'), false)
  assert.equal(Object.hasOwn(stored.payload, 'isLoggedIn'), false)
  assert.equal(stored.payload.sessions[0].messages[0].content, 'keep')
})

test('IndexedDB read failures never expose retired fields and request a later cleanup write', async () => {
  const factory = createFakeIndexedDB({ putError: namedError('UnknownError', 'rewrite failed') })
  await estimatePersistedSnapshotBytes({ factory })
  factory.records.set(SESSION_SNAPSHOT_RECORD_KEY, {
    key: SESSION_SNAPSHOT_RECORD_KEY,
    schemaVersion: SESSION_SNAPSHOT_DB_VERSION,
    updatedAt: 88,
    bytes: 1,
    payload: { user: { plan: 'legacy' }, isLoggedIn: true, sessions: [{ id: 'safe' }] },
  })

  const result = await readPersistedSnapshot({ factory })
  assert.equal(result.ok, true)
  assert.equal(result.cleanupNeeded, true)
  assert.equal(result.cleanupError?.name, 'UnknownError')
  assert.equal(Object.hasOwn(result.payload, 'user'), false)
  assert.equal(Object.hasOwn(result.payload, 'isLoggedIn'), false)
  assert.deepEqual(result.payload.sessions, [{ id: 'safe' }])
})

test('StrictMode-style concurrent calls share one IndexedDB open request', async () => {
  const factory = createFakeIndexedDB()
  const [left, right] = await Promise.all([
    estimatePersistedSnapshotBytes({ factory }),
    estimatePersistedSnapshotBytes({ factory }),
  ])
  assert.equal(left.ok, true)
  assert.equal(right.ok, true)
  assert.equal(factory.stats.opens.length, 1)
})

test('session snapshot facade maps to the direct persisted snapshot APIs', async () => {
  const indexedDBFactory = createFakeIndexedDB()
  const store = createSessionSnapshotStore({ indexedDBFactory, now: () => 42 })
  const payload = { sessions: [], tasks: [], history: [], sessionDrafts: {}, __sync: { version: 1 } }
  assert.equal((await store.writeSnapshot(payload)).updatedAt, 42)
  assert.deepEqual((await store.readSnapshot()).payload, payload)
  assert.equal((await store.estimateBytes()).bytes, new TextEncoder().encode(JSON.stringify(payload)).byteLength)
  assert.equal((await store.clearSnapshot()).ok, true)
})

test('persisted snapshot APIs report unavailable IndexedDB explicitly', async () => {
  const write = await writePersistedSnapshot({ sessions: [] }, { factory: null })
  const read = await readPersistedSnapshot({ factory: null })
  const clear = await clearPersistedSnapshot({ factory: null })
  const estimate = await estimatePersistedSnapshotBytes({ factory: null })
  for (const result of [write, read, clear, estimate]) {
    assert.equal(result.ok, false)
    assert.equal(result.status, 'unavailable')
  }
})

test('persisted snapshot writes distinguish quota failures from generic errors', async () => {
  const quotaFactory = createFakeIndexedDB({ putError: namedError('QuotaExceededError', 'storage quota exceeded') })
  const quotaResult = await writePersistedSnapshot({ sessions: [] }, { factory: quotaFactory })
  assert.equal(quotaResult.ok, false)
  assert.equal(quotaResult.status, 'quota')

  const errorFactory = createFakeIndexedDB({ putError: namedError('UnknownError', 'disk I/O failed') })
  const errorResult = await writePersistedSnapshot({ sessions: [] }, { factory: errorFactory })
  assert.equal(errorResult.ok, false)
  assert.equal(errorResult.status, 'error')
})

test('persisted snapshot reads map blocked browser access to unavailable', async () => {
  const factory = createFakeIndexedDB({ openError: namedError('SecurityError', 'storage blocked') })
  const result = await readPersistedSnapshot({ factory })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'unavailable')
})

test('default IndexedDB getter SecurityError is contained by direct APIs and the facade', async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      throw namedError('SecurityError', 'IndexedDB getter blocked')
    },
  })

  try {
    const directResults = await Promise.all([
      writePersistedSnapshot({ sessions: [] }),
      readPersistedSnapshot(),
      clearPersistedSnapshot(),
      estimatePersistedSnapshotBytes(),
    ])
    const store = createSessionSnapshotStore()
    const facadeResults = await Promise.all([
      store.writeSnapshot({ sessions: [] }),
      store.readSnapshot(),
      store.clearSnapshot(),
      store.estimateBytes(),
    ])

    for (const result of [...directResults, ...facadeResults]) {
      assert.equal(result.ok, false)
      assert.equal(result.status, 'unavailable')
      assert.equal(result.error?.name, 'SecurityError')
    }
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'indexedDB', originalDescriptor)
    else delete globalThis.indexedDB
  }
})

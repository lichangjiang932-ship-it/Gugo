export const SESSION_SNAPSHOT_DB_NAME = 'your-model-atelier:session-snapshots'
export const SESSION_SNAPSHOT_DB_VERSION = 1
export const SESSION_SNAPSHOT_STORE_NAME = 'snapshots'
export const SESSION_SNAPSHOT_RECORD_KEY = 'session-domain'

const connections = new WeakMap()
const UNAVAILABLE_ERROR_NAMES = new Set([
  'InvalidStateError',
  'NotAllowedError',
  'NotSupportedError',
  'SecurityError',
])

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'))
  })
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    let request
    let settled = false
    try {
      request = factory.open(SESSION_SNAPSHOT_DB_NAME, SESSION_SNAPSHOT_DB_VERSION)
    } catch (error) {
      reject(error)
      return
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SESSION_SNAPSHOT_STORE_NAME)) {
        database.createObjectStore(SESSION_SNAPSHOT_STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      if (settled) {
        request.result?.close()
        return
      }
      settled = true
      resolve(request.result)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(request.error || new Error('IndexedDB open failed'))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      const error = new Error('IndexedDB upgrade is blocked')
      error.name = 'InvalidStateError'
      reject(error)
    }
  })
}

function unavailableError() {
  const error = new Error('IndexedDB is unavailable')
  error.name = 'NotSupportedError'
  return error
}

function connectionFor(factory) {
  if (!factory || typeof factory.open !== 'function') return Promise.reject(unavailableError())
  let state = connections.get(factory)
  if (!state) {
    state = { database: null, opening: null }
    connections.set(factory, state)
  }
  if (state.database) return Promise.resolve(state.database)
  if (!state.opening) {
    state.opening = openDatabase(factory).then((database) => {
      state.database = database
      state.opening = null
      database.onversionchange = () => {
        database.close()
        if (state.database === database) state.database = null
      }
      return database
    }, (error) => {
      state.opening = null
      throw error
    })
  }
  return state.opening
}

function failure(error, factory) {
  const quota = error?.name === 'QuotaExceededError'
    || error?.code === 22
    || error?.code === 1014
    || /quota/i.test(error?.message || '')
  let usableFactory = false
  try {
    usableFactory = !!factory && typeof factory.open === 'function'
  } catch {
    // Accessing browser storage capabilities can itself throw in restricted contexts.
  }
  const unavailable = !usableFactory || UNAVAILABLE_ERROR_NAMES.has(error?.name)
  return { ok: false, status: quota ? 'quota' : (unavailable ? 'unavailable' : 'error'), error }
}

function resolveFactory(options, { allowIndexedDBFactory = false } = {}) {
  const source = options == null ? {} : options
  if (Object.hasOwn(source, 'factory')) return source.factory
  if (allowIndexedDBFactory && Object.hasOwn(source, 'indexedDBFactory')) return source.indexedDBFactory
  return globalThis.indexedDB
}

function payloadBytes(payload) {
  const serialized = JSON.stringify(payload)
  if (serialized === undefined) return 0
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(serialized).byteLength
  if (typeof Blob === 'function') return new Blob([serialized]).size
  return serialized.length * 2
}

async function readRecord(factory) {
  const database = await connectionFor(factory)
  const transaction = database.transaction(SESSION_SNAPSHOT_STORE_NAME, 'readonly')
  const request = transaction.objectStore(SESSION_SNAPSHOT_STORE_NAME).get(SESSION_SNAPSHOT_RECORD_KEY)
  const [record] = await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
  return record || null
}

export async function writePersistedSnapshot(payload, options = {}) {
  let factory
  try {
    factory = resolveFactory(options)
    const now = options?.now || Date.now
    const database = await connectionFor(factory)
    const updatedAt = Number(now()) || Date.now()
    const bytes = payloadBytes(payload)
    const transaction = database.transaction(SESSION_SNAPSHOT_STORE_NAME, 'readwrite')
    const request = transaction.objectStore(SESSION_SNAPSHOT_STORE_NAME).put({
      key: SESSION_SNAPSHOT_RECORD_KEY,
      schemaVersion: SESSION_SNAPSHOT_DB_VERSION,
      updatedAt,
      bytes,
      payload,
    })
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
    return { ok: true, status: 'ok', payload, updatedAt, bytes }
  } catch (error) {
    return failure(error, factory)
  }
}

export async function readPersistedSnapshot(options = {}) {
  let factory
  try {
    factory = resolveFactory(options)
    const record = await readRecord(factory)
    return {
      ok: true,
      status: 'ok',
      payload: record?.payload ?? null,
      updatedAt: record?.updatedAt ?? null,
    }
  } catch (error) {
    return failure(error, factory)
  }
}

export async function clearPersistedSnapshot(options = {}) {
  let factory
  try {
    factory = resolveFactory(options)
    const database = await connectionFor(factory)
    const transaction = database.transaction(SESSION_SNAPSHOT_STORE_NAME, 'readwrite')
    const request = transaction.objectStore(SESSION_SNAPSHOT_STORE_NAME).delete(SESSION_SNAPSHOT_RECORD_KEY)
    await Promise.all([requestToPromise(request), transactionToPromise(transaction)])
    return { ok: true, status: 'ok' }
  } catch (error) {
    return failure(error, factory)
  }
}

export async function estimatePersistedSnapshotBytes(options = {}) {
  let factory
  try {
    factory = resolveFactory(options)
    const record = await readRecord(factory)
    return { ok: true, status: 'ok', bytes: record ? (record.bytes ?? payloadBytes(record.payload)) : 0 }
  } catch (error) {
    return failure(error, factory)
  }
}

export function createSessionSnapshotStore(options = {}) {
  let factory
  let now
  let setupError = null
  try {
    factory = resolveFactory(options, { allowIndexedDBFactory: true })
    now = options?.now || Date.now
  } catch (error) {
    setupError = error
  }
  const run = (operation) => setupError
    ? Promise.resolve(failure(setupError, factory))
    : operation()
  return {
    readSnapshot: () => run(() => readPersistedSnapshot({ factory })),
    writeSnapshot: (payload) => run(() => writePersistedSnapshot(payload, { factory, now })),
    clearSnapshot: () => run(() => clearPersistedSnapshot({ factory })),
    estimateBytes: () => run(() => estimatePersistedSnapshotBytes({ factory })),
  }
}

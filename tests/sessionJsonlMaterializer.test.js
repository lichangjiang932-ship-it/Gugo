import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  decodeSessionContentRecord,
  encodeSessionContentRecord,
  projectSessionContentEvents,
  resolveSessionContentPath,
} from '../server/services/sessionJsonlCodec.js'
import {
  appendSessionContentRecord,
  createSessionJsonlMaterializer,
  materializeSessionContentEvent,
  readSessionContentProjection,
  readSessionContentRecords,
} from '../server/services/sessionJsonlMaterializer.js'

function event({
  id,
  eventId = `event-${id}`,
  userId = 'private-user-id',
  sessionId = 'private-session-id',
  eventType = 'message.upsert',
  payload = null,
  createdAt = id,
} = {}) {
  return {
    id,
    eventId,
    userId,
    sessionId,
    eventType,
    payload: payload || {
      message: {
        id: `message-${id}`,
        role: 'user',
        content: `content-${id}`,
        modelContext: { z: id, a: true },
        createdAt,
        updatedAt: createdAt,
      },
    },
    createdAt,
  }
}

test('codec is deterministic, round-trips, and rejects unversioned records', () => {
  const first = event({ id: 1 })
  const reordered = {
    ...first,
    payload: {
      message: {
        ...first.payload.message,
        modelContext: { a: true, z: 1 },
      },
    },
  }
  assert.equal(encodeSessionContentRecord(first), encodeSessionContentRecord(reordered))
  assert.deepEqual(decodeSessionContentRecord(encodeSessionContentRecord(first)), {
    ...first,
    payload: reordered.payload,
  })
  assert.throws(
    () => decodeSessionContentRecord('{"schemaVersion":2}\n'),
    (error) => error?.code === 'SESSION_JSONL_RECORD_UNSUPPORTED',
  )
})

test('hashed storage paths never expose raw user or session identifiers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-path-'))
  try {
    const paths = resolveSessionContentPath({
      userId: 'user@example.test',
      sessionId: '../../sensitive/session',
      env: { APP_DATA_DIR: root },
    })
    assert.equal(paths.filePath.startsWith(path.join(root, 'session-content')), true)
    assert.equal(paths.filePath.includes('user@example.test'), false)
    assert.equal(paths.filePath.includes('sensitive'), false)
    assert.equal(path.extname(paths.filePath), '.jsonl')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('append repairs only a partial tail and keeps complete records durable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-jsonl-'))
  const options = { env: { APP_DATA_DIR: root } }
  try {
    const first = event({ id: 1 })
    const second = event({ id: 2 })
    const written = appendSessionContentRecord(first, options)
    fs.appendFileSync(written.path, '{"partial":', 'utf8')
    appendSessionContentRecord(second, options)
    const records = readSessionContentRecords({
      userId: first.userId,
      sessionId: first.sessionId,
      ...options,
    })
    assert.deepEqual(records.map((record) => record.eventId), ['event-1', 'event-2'])
    assert.equal(fs.readFileSync(written.path, 'utf8').endsWith('\n'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('reader ignores an incomplete UTF-8 tail but rejects corruption in the complete region', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-utf8-tail-'))
  const options = { env: { APP_DATA_DIR: root } }
  try {
    const first = event({ id: 1 })
    const written = appendSessionContentRecord(first, options)
    fs.appendFileSync(written.path, Buffer.from([0xe4, 0xb8]))
    assert.deepEqual(readSessionContentRecords({
      userId: first.userId,
      sessionId: first.sessionId,
      ...options,
      toleratePartialTail: true,
    }).map((record) => record.eventId), ['event-1'])

    fs.appendFileSync(written.path, Buffer.from('\n'))
    assert.throws(
      () => readSessionContentRecords({
        userId: first.userId,
        sessionId: first.sessionId,
        ...options,
        toleratePartialTail: true,
      }),
      (error) => error instanceof TypeError && /utf-8/iu.test(error.message),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('append rejects a symbolic-link target without changing its victim', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-symlink-'))
  const options = { env: { APP_DATA_DIR: root } }
  const first = event({ id: 1 })
  try {
    const paths = resolveSessionContentPath({
      userId: first.userId,
      sessionId: first.sessionId,
      ...options,
    })
    fs.mkdirSync(paths.userDirectory, { recursive: true })
    const victim = path.join(root, 'symlink-victim.txt')
    fs.writeFileSync(victim, 'victim must stay unchanged\n', 'utf8')
    try {
      fs.symlinkSync(victim, paths.filePath, 'file')
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOSYS'].includes(error?.code)) {
        t.skip(`symbolic links are unavailable on this platform: ${error.code}`)
        return
      }
      throw error
    }
    assert.throws(
      () => appendSessionContentRecord(first, options),
      (error) => error?.code === 'SESSION_JSONL_PATH_UNSAFE',
    )
    assert.equal(fs.readFileSync(victim, 'utf8'), 'victim must stay unchanged\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('append rejects a hard-linked target without changing its victim', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-hardlink-'))
  const options = { env: { APP_DATA_DIR: root } }
  const first = event({ id: 1 })
  try {
    const paths = resolveSessionContentPath({
      userId: first.userId,
      sessionId: first.sessionId,
      ...options,
    })
    fs.mkdirSync(paths.userDirectory, { recursive: true })
    const victim = path.join(root, 'hardlink-victim.txt')
    fs.writeFileSync(victim, 'victim must stay unchanged\n', 'utf8')
    try {
      fs.linkSync(victim, paths.filePath)
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOSYS', 'EXDEV'].includes(error?.code)) {
        t.skip(`hard links are unavailable on this platform: ${error.code}`)
        return
      }
      throw error
    }
    assert.throws(
      () => appendSessionContentRecord(first, options),
      (error) => error?.code === 'SESSION_JSONL_PATH_UNSAFE',
    )
    assert.equal(fs.readFileSync(victim, 'utf8'), 'victim must stay unchanged\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a stale concurrent append cannot overwrite a later complete record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-concurrent-append-'))
  const options = { env: { APP_DATA_DIR: root } }
  try {
    const first = event({ id: 1, eventId: 'stable-first' })
    const second = event({
      id: 2,
      eventId: 'must-survive',
      payload: {
        message: {
          ...event({ id: 2 }).payload.message,
          content: 'a later record with different byte length must survive',
        },
      },
    })
    appendSessionContentRecord(first, options)
    let injected = false
    const concurrentFileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'writeSync') {
          return (...args) => {
            if (!injected) {
              injected = true
              appendSessionContentRecord(second, options)
            }
            return fs.writeSync(...args)
          }
        }
        return target[property]
      },
    })
    appendSessionContentRecord(first, { ...options, fileSystem: concurrentFileSystem })
    assert.deepEqual(readSessionContentRecords({
      userId: first.userId,
      sessionId: first.sessionId,
      ...options,
    }).map((record) => record.eventId), ['stable-first', 'must-survive', 'stable-first'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('first append synchronizes file contents and every newly created directory entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-directory-sync-'))
  const options = { env: { APP_DATA_DIR: root } }
  const first = event({ id: 1 })
  const paths = resolveSessionContentPath({
    userId: first.userId,
    sessionId: first.sessionId,
    ...options,
  })
  const descriptorPaths = new Map()
  const syncedPaths = []
  let fakeDescriptor = 1_000_000
  const trackingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (targetPath, ...args) => {
          if (typeof targetPath === 'string'
            && fs.existsSync(targetPath)
            && fs.lstatSync(targetPath).isDirectory()) {
            const descriptor = fakeDescriptor
            fakeDescriptor += 1
            descriptorPaths.set(descriptor, path.resolve(targetPath))
            return descriptor
          }
          const descriptor = fs.openSync(targetPath, ...args)
          descriptorPaths.set(descriptor, path.resolve(String(targetPath)))
          return descriptor
        }
      }
      if (property === 'fsyncSync') {
        return (descriptor) => {
          syncedPaths.push(descriptorPaths.get(descriptor))
          if (descriptor < 1_000_000) fs.fsyncSync(descriptor)
        }
      }
      if (property === 'closeSync') {
        return (descriptor) => {
          descriptorPaths.delete(descriptor)
          if (descriptor < 1_000_000) fs.closeSync(descriptor)
        }
      }
      return target[property]
    },
  })
  try {
    appendSessionContentRecord(first, { ...options, fileSystem: trackingFileSystem })
    const expectedDirectories = [
      path.join(paths.dataRoot, 'session-content'),
      paths.root,
      paths.userDirectory,
    ].map((entry) => path.resolve(entry))
    assert.equal(syncedPaths.includes(path.resolve(paths.filePath)), true)
    for (const directory of expectedDirectories) {
      assert.equal(syncedPaths.includes(directory), true, directory)
    }
    assert.equal(
      syncedPaths.indexOf(path.resolve(paths.filePath)) < syncedPaths.indexOf(path.resolve(paths.userDirectory)),
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('append-before-ack replay is harmless because projection deduplicates eventId', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-replay-'))
  const options = { env: { APP_DATA_DIR: root } }
  try {
    const upsert = event({ id: 1, eventId: 'stable-event' })
    appendSessionContentRecord(upsert, options)
    appendSessionContentRecord(upsert, options)
    const records = readSessionContentRecords({
      userId: upsert.userId,
      sessionId: upsert.sessionId,
      ...options,
    })
    assert.equal(records.length, 2)
    const projection = readSessionContentProjection({
      userId: upsert.userId,
      sessionId: upsert.sessionId,
      ...options,
    })
    assert.equal(projection.messages.length, 1)
    assert.deepEqual(projection.appliedEventIds, ['stable-event'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('replace and delete events produce an unambiguous in-memory projection', () => {
  const replacement = event({
    id: 1,
    eventType: 'session.replace',
    payload: {
      messages: [
        event({ id: 10 }).payload.message,
        event({ id: 11 }).payload.message,
      ],
    },
  })
  const deleteMessage = event({
    id: 2,
    eventType: 'message.delete',
    payload: { messageId: 'message-10' },
  })
  const deleteSession = event({ id: 3, eventType: 'session.delete', payload: {} })
  assert.deepEqual(projectSessionContentEvents([replacement, deleteMessage]).messages.map((item) => item.id), [
    'message-11',
  ])
  assert.equal(projectSessionContentEvents([replacement, deleteSession]).deleted, true)
})

test('destructive materialization physically removes deleted and superseded message bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-privacy-'))
  const options = { env: { APP_DATA_DIR: root } }
  const secret = 'deleted-secret-must-not-remain-in-jsonl'
  const superseded = 'superseded-secret-must-not-remain-in-jsonl'
  try {
    const first = event({
      id: 1,
      payload: {
        message: {
          ...event({ id: 1 }).payload.message,
          content: superseded,
        },
      },
    })
    const second = event({
      id: 2,
      payload: {
        message: {
          ...first.payload.message,
          content: 'safe replacement',
          updatedAt: 2,
        },
      },
    })
    const disposable = event({
      id: 3,
      payload: {
        message: {
          ...event({ id: 3 }).payload.message,
          content: secret,
        },
      },
    })
    materializeSessionContentEvent(first, options)
    materializeSessionContentEvent(second, options)
    materializeSessionContentEvent(disposable, options)
    const deleted = event({
      id: 4,
      eventType: 'message.delete',
      payload: { messageId: disposable.payload.message.id },
    })
    const written = materializeSessionContentEvent(deleted, options)
    const raw = fs.readFileSync(written.path, 'utf8')
    assert.doesNotMatch(raw, new RegExp(secret))
    assert.doesNotMatch(raw, new RegExp(superseded))
    assert.deepEqual(readSessionContentProjection({
      userId: first.userId,
      sessionId: first.sessionId,
      ...options,
    }).messages.map((message) => [message.id, message.content]), [
      [first.payload.message.id, 'safe replacement'],
    ])

    const removed = materializeSessionContentEvent(event({
      id: 5,
      eventType: 'session.delete',
      payload: {},
    }), options)
    assert.equal(removed.deleted, true)
    assert.equal(fs.existsSync(removed.path), false)
    assert.equal(materializeSessionContentEvent(event({
      id: 5,
      eventType: 'session.delete',
      payload: {},
    }), options).deleted, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('combined materialize path commits append and acknowledgement without a second ack', async () => {
  const row = event({ id: 21 })
  const calls = []
  const materializer = createSessionJsonlMaterializer({
    ownerId: 'combined-worker',
    claim: () => [row],
    materialize(scope, append) {
      calls.push(['materialize', scope])
      return { written: append(row) }
    },
    append(input) {
      calls.push(['append', input.eventId])
      return { path: 'memory.jsonl' }
    },
    acknowledge() {
      calls.push(['unexpected-ack'])
      return true
    },
    releaseFailure() {
      calls.push(['unexpected-release'])
      return true
    },
    now: () => 22,
  })

  const result = await materializer.drainOnce()
  assert.equal(result[0].ok, true)
  assert.deepEqual(result[0].written, { path: 'memory.jsonl' })
  assert.deepEqual(calls, [
    ['materialize', { id: 21, eventId: 'event-21', ownerId: 'combined-worker', now: 22 }],
    ['append', 'event-21'],
  ])
})

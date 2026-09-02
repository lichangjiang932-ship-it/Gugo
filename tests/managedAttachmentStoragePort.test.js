import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { MANAGED_ATTACHMENT_PUBLIC_FIELDS } from '../server/core/managedAttachmentDtos.js'
import {
  MANAGED_ATTACHMENT_STORAGE_PORT_METHODS,
  MANAGED_ATTACHMENT_STORAGE_PORT_VERSION,
  assertManagedAttachmentStoragePort,
  createManagedAttachmentStoragePort,
} from '../server/core/managedAttachmentStoragePort.js'

const SHA256 = 'a'.repeat(64)

function attachment(id = 'attachment-1', overrides = {}) {
  return {
    id,
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 12,
    sha256: SHA256,
    status: 'ready',
    sessionId: 'session-1',
    messageId: null,
    uri: `attachment://${id}`,
    downloadUrl: `/api/attachments/${encodeURIComponent(id)}/content`,
    createdAt: 100,
    updatedAt: 101,
    ...overrides,
  }
}

function source(value = 'hello world!') {
  return (async function* attachmentSource() {
    yield Buffer.from(value)
  })()
}

function adapter(overrides = {}) {
  return {
    apiVersion: MANAGED_ATTACHMENT_STORAGE_PORT_VERSION,
    id: 'test.managed-attachment-storage',
    create: () => attachment(),
    list: () => [attachment()],
    get: () => attachment(),
    delete: () => true,
    deleteForSession: () => 1,
    cleanup: () => ({ removedRows: 1, removedFiles: 1 }),
    openContent: () => ({
      attachment: attachment(),
      stream: Readable.from([Buffer.from('hello world!')]),
    }),
    ...overrides,
  }
}

function createInput(overrides = {}) {
  return {
    userId: 'user-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    sessionId: 'session-1',
    messageId: null,
    source: source(),
    contentLength: 12,
    ...overrides,
  }
}

function assertInputError(call) {
  assert.throws(
    call,
    (error) => (
      error?.code === 'MANAGED_ATTACHMENT_STORAGE_PORT_INPUT_INVALID'
      && error?.retryable === false
    ),
  )
}

function assertPortError(call, code = 'MANAGED_ATTACHMENT_STORAGE_PORT_INVALID') {
  assert.throws(
    call,
    (error) => error?.code === code && error?.retryable === false,
  )
}

test('storage port accepts only a complete v1 adapter and brands the resulting port as trusted', () => {
  assert.equal(MANAGED_ATTACHMENT_STORAGE_PORT_VERSION, 1)
  assert.equal(Object.isFrozen(MANAGED_ATTACHMENT_STORAGE_PORT_METHODS), true)
  assert.deepEqual(MANAGED_ATTACHMENT_STORAGE_PORT_METHODS, [
    'create',
    'list',
    'get',
    'delete',
    'deleteForSession',
    'cleanup',
    'openContent',
  ])

  const candidate = adapter()
  const port = createManagedAttachmentStoragePort(candidate)
  assert.equal(assertManagedAttachmentStoragePort(port), port)
  assert.equal(Object.isFrozen(port), true)
  assert.deepEqual(Object.keys(port), [
    'apiVersion',
    'id',
    ...MANAGED_ATTACHMENT_STORAGE_PORT_METHODS,
  ])

  assertPortError(
    () => createManagedAttachmentStoragePort({ ...candidate, apiVersion: 2 }),
    'MANAGED_ATTACHMENT_STORAGE_PORT_VERSION_UNSUPPORTED',
  )
  assertPortError(() => createManagedAttachmentStoragePort({ ...candidate, get: null }))
  assertPortError(() => createManagedAttachmentStoragePort({ ...candidate, id: 'INVALID ID' }))
  assertPortError(
    () => assertManagedAttachmentStoragePort({ ...port }),
    'MANAGED_ATTACHMENT_STORAGE_PORT_UNTRUSTED',
  )
})

test('adapter accessors, proxied adapters, and proxied implementations are rejected without execution', () => {
  let getterCalls = 0
  const accessor = adapter()
  Object.defineProperty(accessor, 'openContent', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('adapter accessor must not execute')
    },
  })
  assertPortError(() => createManagedAttachmentStoragePort(accessor))
  assert.equal(getterCalls, 0)

  let proxyTraps = 0
  const proxiedAdapter = new Proxy(adapter(), {
    getOwnPropertyDescriptor() {
      proxyTraps += 1
      throw new Error('adapter proxy trap must not execute')
    },
  })
  assertPortError(() => createManagedAttachmentStoragePort(proxiedAdapter))
  assert.equal(proxyTraps, 0)

  const candidate = adapter({
    get: new Proxy(() => attachment(), {
      apply() {
        throw new Error('proxied implementation must not execute')
      },
    }),
  })
  assertPortError(() => createManagedAttachmentStoragePort(candidate))
})

test('method inputs reject accessors, Proxies, inherited records, symbols, and unknown fields', () => {
  let calls = 0
  const port = createManagedAttachmentStoragePort(adapter({
    get() {
      calls += 1
      return attachment()
    },
  }))

  let getterCalls = 0
  const accessorInput = { id: 'attachment-1' }
  Object.defineProperty(accessorInput, 'userId', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('input accessor must not execute')
    },
  })
  assertInputError(() => port.get(accessorInput))
  assert.equal(getterCalls, 0)

  let proxyTraps = 0
  const proxyInput = new Proxy({ userId: 'user-1', id: 'attachment-1' }, {
    ownKeys() {
      proxyTraps += 1
      throw new Error('input proxy trap must not execute')
    },
  })
  assertInputError(() => port.get(proxyInput))
  assert.equal(proxyTraps, 0)

  assertInputError(() => port.get(Object.create({ userId: 'user-1', id: 'attachment-1' })))
  assertInputError(() => port.get({ userId: 'user-1', id: 'attachment-1', fullPath: 'private' }))
  assertInputError(() => port.get({
    userId: 'user-1',
    id: 'attachment-1',
    [Symbol('private')]: true,
  }))
  assert.equal(calls, 0)
})

test('every operation requires scoped identity and create requires an own async source', () => {
  const port = createManagedAttachmentStoragePort(adapter())
  const missingUser = [
    () => port.create({ ...createInput(), userId: '' }),
    () => port.list({}),
    () => port.get({ id: 'attachment-1' }),
    () => port.delete({ id: 'attachment-1' }),
    () => port.deleteForSession({ sessionId: 'session-1' }),
    () => port.cleanup({}),
    () => port.openContent({ id: 'attachment-1' }),
  ]
  for (const call of missingUser) assertInputError(call)

  for (const call of [
    () => port.get({ userId: 'user-1', id: ' ' }),
    () => port.delete({ userId: 'user-1' }),
    () => port.openContent({ userId: 'user-1', id: '' }),
    () => port.deleteForSession({ userId: 'user-1', sessionId: ' session-1 ' }),
    () => port.create(createInput({ name: ' ' })),
    () => port.create(createInput({ source: null })),
  ]) assertInputError(call)

  let iteratorGetterCalls = 0
  const unsafeSource = {}
  Object.defineProperty(unsafeSource, Symbol.asyncIterator, {
    get() {
      iteratorGetterCalls += 1
      throw new Error('source iterator accessor must not execute')
    },
  })
  assertInputError(() => port.create(createInput({ source: unsafeSource })))
  assert.equal(iteratorGetterCalls, 0)
})

test('range and expected identity are copied, frozen, and passed to the adapter exactly', () => {
  let observed = null
  const stream = Readable.from([Buffer.from('hello world!')])
  const port = createManagedAttachmentStoragePort(adapter({
    openContent(input) {
      observed = input
      return { attachment: attachment(), stream }
    },
  }))
  const range = { start: 1, end: 4 }
  const expected = { size: 12, sha256: SHA256 }
  const input = { userId: 'user-1', id: 'attachment-1', range, expected }

  const opened = port.openContent(input)
  assert.notEqual(observed, input)
  assert.notEqual(observed.range, range)
  assert.notEqual(observed.expected, expected)
  assert.deepEqual(observed.range, range)
  assert.deepEqual(observed.expected, expected)
  assert.equal(Object.isFrozen(observed), true)
  assert.equal(Object.isFrozen(observed.range), true)
  assert.equal(Object.isFrozen(observed.expected), true)
  opened.stream.destroy()
})

test('range and expected reject Proxies, accessors, extra fields, and invalid values', () => {
  let adapterCalls = 0
  const port = createManagedAttachmentStoragePort(adapter({
    openContent() {
      adapterCalls += 1
      return { attachment: attachment(), stream: Readable.from([]) }
    },
  }))
  const base = { userId: 'user-1', id: 'attachment-1' }

  let rangeGetterCalls = 0
  const rangeAccessor = { end: 1 }
  Object.defineProperty(rangeAccessor, 'start', {
    enumerable: true,
    get() {
      rangeGetterCalls += 1
      throw new Error('range accessor must not execute')
    },
  })
  let expectedGetterCalls = 0
  const expectedAccessor = { sha256: SHA256 }
  Object.defineProperty(expectedAccessor, 'size', {
    enumerable: true,
    get() {
      expectedGetterCalls += 1
      throw new Error('expected accessor must not execute')
    },
  })

  const invalidRanges = [
    new Proxy({ start: 0, end: 1 }, {}),
    rangeAccessor,
    { start: 0 },
    { start: 0, end: 1, privatePath: true },
    { start: -1, end: 1 },
    { start: 2, end: 1 },
    { start: 0.5, end: 1 },
  ]
  for (const range of invalidRanges) assertInputError(() => port.openContent({ ...base, range }))

  const invalidExpected = [
    new Proxy({ size: 12, sha256: SHA256 }, {}),
    expectedAccessor,
    { size: 12 },
    { size: 12, sha256: SHA256, fullPath: 'private' },
    { size: -1, sha256: SHA256 },
    { size: 12, sha256: SHA256.toUpperCase() },
  ]
  for (const expected of invalidExpected) {
    assertInputError(() => port.openContent({ ...base, expected }))
  }
  assert.equal(rangeGetterCalls, 0)
  assert.equal(expectedGetterCalls, 0)
  assert.equal(adapterCalls, 0)
})

test('attachment outputs are complete frozen public DTOs with no host path fields', async () => {
  const privateAttachment = attachment('attachment-1', {
    fullPath: 'C:\\private\\attachment-1',
    storagePath: 'private/attachment-1',
    storage_path: 'private/attachment-1',
    rootPath: 'C:\\private',
  })
  const port = createManagedAttachmentStoragePort(adapter({
    create: async () => privateAttachment,
    list: () => [privateAttachment],
    get: () => privateAttachment,
  }))

  const created = await port.create(createInput())
  const listed = port.list({ userId: 'user-1' })
  const found = port.get({ userId: 'user-1', id: 'attachment-1' })
  for (const value of [created, listed[0], found]) {
    assert.deepEqual(Object.keys(value), MANAGED_ATTACHMENT_PUBLIC_FIELDS)
    assert.equal(Object.isFrozen(value), true)
    assert.doesNotMatch(JSON.stringify(value), /private|fullPath|storagePath|storage_path/u)
  }
  assert.equal(Object.isFrozen(listed), true)

  for (const field of MANAGED_ATTACHMENT_PUBLIC_FIELDS) {
    const incomplete = attachment()
    delete incomplete[field]
    const incompletePort = createManagedAttachmentStoragePort(adapter({ get: () => incomplete }))
    assertPortError(() => incompletePort.get({ userId: 'user-1', id: 'attachment-1' }))
  }
})

test('attachment outputs enforce self-consistent identity, ready state, and monotonic time', () => {
  const invalidOutputs = [
    attachment('short'),
    attachment('attachment-1', { name: '../notes.txt' }),
    attachment('attachment-1', { mimeType: 'invalid' }),
    attachment('attachment-1', { size: -1 }),
    attachment('attachment-1', { sha256: 'A'.repeat(64) }),
    attachment('attachment-1', { status: 'pending' }),
    attachment('attachment-1', { uri: 'attachment://attachment-other' }),
    attachment('attachment-1', { downloadUrl: '/api/attachments/attachment-other/content' }),
    attachment('attachment-1', { createdAt: 102, updatedAt: 101 }),
  ]
  for (const output of invalidOutputs) {
    const port = createManagedAttachmentStoragePort(adapter({ get: () => output }))
    assertPortError(() => port.get({ userId: 'user-1', id: 'attachment-1' }))
  }

  const drift = createManagedAttachmentStoragePort(adapter({
    get: () => attachment('attachment-2'),
  }))
  assertPortError(
    () => drift.get({ userId: 'user-1', id: 'attachment-1' }),
    'MANAGED_ATTACHMENT_STORAGE_PORT_IDENTITY_MISMATCH',
  )
})

test('delete and cleanup operations require typed, non-negative receipts', () => {
  const valid = createManagedAttachmentStoragePort(adapter({
    cleanup: () => ({
      removedRows: 2,
      removedFiles: 1,
      skippedForUserDataClear: false,
      fullPath: 'C:\\private',
    }),
  }))
  assert.equal(valid.delete({ userId: 'user-1', id: 'attachment-1' }), true)
  assert.equal(valid.deleteForSession({ userId: 'user-1', sessionId: 'session-1' }), 1)
  const receipt = valid.cleanup({ userId: 'user-1' })
  assert.deepEqual(receipt, {
    removedRows: 2,
    removedFiles: 1,
    skippedForUserDataClear: false,
  })
  assert.equal(Object.isFrozen(receipt), true)

  for (const output of [null, 1, 'true']) {
    const port = createManagedAttachmentStoragePort(adapter({ delete: () => output }))
    assertPortError(() => port.delete({ userId: 'user-1', id: 'attachment-1' }))
  }
  for (const output of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, true]) {
    const port = createManagedAttachmentStoragePort(adapter({ deleteForSession: () => output }))
    assertPortError(() => port.deleteForSession({ userId: 'user-1', sessionId: 'session-1' }))
  }
  for (const output of [
    null,
    { removedRows: 1 },
    { removedRows: -1, removedFiles: 0 },
    { removedRows: 0, removedFiles: 0.5 },
    { removedRows: 0, removedFiles: 0, skippedForUserDataClear: 'false' },
  ]) {
    const port = createManagedAttachmentStoragePort(adapter({ cleanup: () => output }))
    assertPortError(() => port.cleanup({ userId: 'user-1' }))
  }
})

test('openContent returns its authoritative public DTO and the exact readable stream', () => {
  const stream = Readable.from([Buffer.from('hello world!')])
  const authoritative = attachment('attachment-1', {
    name: 'authoritative.txt',
    fullPath: 'C:\\private\\attachment-1',
    storage_path: 'private/attachment-1',
  })
  const port = createManagedAttachmentStoragePort(adapter({
    openContent: () => ({ attachment: authoritative, stream, fullPath: 'C:\\private' }),
  }))

  const opened = port.openContent({
    userId: 'user-1',
    id: 'attachment-1',
    expected: { size: authoritative.size, sha256: authoritative.sha256 },
  })
  assert.equal(opened.stream, stream)
  assert.equal(opened.attachment.name, 'authoritative.txt')
  assert.deepEqual(Object.keys(opened), ['attachment', 'stream'])
  assert.deepEqual(Object.keys(opened.attachment), MANAGED_ATTACHMENT_PUBLIC_FIELDS)
  assert.equal(Object.isFrozen(opened), true)
  assert.equal(Object.isFrozen(opened.attachment), true)
  assert.doesNotMatch(JSON.stringify(opened.attachment), /private|fullPath|storage_path/u)
  stream.destroy()
})

test('openContent destroys allocated streams when output validation fails', () => {
  for (const badAttachment of [
    attachment('attachment-2'),
    attachment('attachment-1', { status: 'pending' }),
    attachment('attachment-1', { size: 13 }),
  ]) {
    let destroys = 0
    const stream = Readable.from([])
    const originalDestroy = stream.destroy.bind(stream)
    stream.destroy = (...args) => {
      destroys += 1
      return originalDestroy(...args)
    }
    const port = createManagedAttachmentStoragePort(adapter({
      openContent: () => ({ attachment: badAttachment, stream }),
    }))
    assertPortError(
      () => port.openContent({
        userId: 'user-1',
        id: 'attachment-1',
        expected: { size: 12, sha256: SHA256 },
      }),
      badAttachment.id === 'attachment-2' || badAttachment.size === 13
        ? 'MANAGED_ATTACHMENT_STORAGE_PORT_IDENTITY_MISMATCH'
        : 'MANAGED_ATTACHMENT_STORAGE_PORT_INVALID',
    )
    assert.equal(destroys, 1)
  }

  let malformedDestroys = 0
  const malformedStream = {
    once() {},
    destroy() { malformedDestroys += 1 },
  }
  const malformed = createManagedAttachmentStoragePort(adapter({
    openContent: () => ({ attachment: attachment(), stream: malformedStream }),
  }))
  assertPortError(() => malformed.openContent({ userId: 'user-1', id: 'attachment-1' }))
  assert.equal(malformedDestroys, 1)
})

test('openContent never invokes output accessors and destroys an already allocated stream', () => {
  let getterCalls = 0
  let destroys = 0
  const stream = Readable.from([])
  const originalDestroy = stream.destroy.bind(stream)
  stream.destroy = (...args) => {
    destroys += 1
    return originalDestroy(...args)
  }
  const output = { stream }
  Object.defineProperty(output, 'attachment', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('output accessor must not execute')
    },
  })
  const port = createManagedAttachmentStoragePort(adapter({ openContent: () => output }))

  assertPortError(() => port.openContent({ userId: 'user-1', id: 'attachment-1' }))
  assert.equal(getterCalls, 0)
  assert.equal(destroys, 1)
})

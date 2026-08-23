import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
  acquireManagedAttachmentRuntimePort,
  createManagedAttachmentRuntimePortController,
  getManagedAttachmentRuntimePortStatus,
  prepareManagedAttachmentRuntimePort,
} from '../server/core/managedAttachmentRuntimePort.js'

function attachment(id = 'attachment-1', overrides = {}) {
  return {
    id,
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 12,
    sha256: 'a'.repeat(64),
    status: 'ready',
    sessionId: 'session-1',
    messageId: null,
    uri: `attachment://${id}`,
    downloadUrl: `/api/attachments/${id}/content`,
    createdAt: 100,
    updatedAt: 101,
    ...overrides,
  }
}

function expectedReceipt(value = attachment()) {
  return Object.fromEntries([
    'id', 'name', 'mimeType', 'size', 'sha256', 'status', 'sessionId', 'messageId', 'uri',
    'downloadUrl',
  ].map((field) => [field, value[field]]))
}

function prepareInput(expectedAttachments = [expectedReceipt()]) {
  return {
    ...validateInput(),
    attachmentIds: expectedAttachments.map((item) => item.id),
    expectedAttachments,
    text: 'inspect',
    maxAttachmentTokens: 100,
  }
}

function port(overrides = {}) {
  return {
    id: 'test.managed-attachments',
    apiVersion: MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
    validateAttachments: ({ attachmentIds }) => attachmentIds.map((id) => attachment(id)),
    bindAttachments: ({ attachmentIds, messageId }) => (
      attachmentIds.map((id) => attachment(id, { messageId }))
    ),
    prepareAttachments: ({ expectedAttachments, text }) => ({
      attachments: expectedAttachments.map((item) => attachment(item.id, {
        ...item,
        messageId: item.messageId || 'message-bound',
      })),
      content: text,
    }),
    ...overrides,
  }
}

function validateInput() {
  return {
    userId: 'user-1',
    sessionId: 'session-1',
    attachmentIds: ['attachment-1'],
  }
}

test('managed attachment runtime port requires one complete v1 implementation', () => {
  assert.throws(
    () => prepareManagedAttachmentRuntimePort({ ...port(), apiVersion: 2 }),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION_UNSUPPORTED',
  )
  assert.throws(
    () => prepareManagedAttachmentRuntimePort({ ...port(), bindAttachments: null }),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_INVALID',
  )

  let getterCalled = false
  const candidate = port()
  Object.defineProperty(candidate, 'prepareAttachments', {
    enumerable: true,
    get() {
      getterCalled = true
      return () => ({ attachments: [], content: '' })
    },
  })
  assert.throws(
    () => prepareManagedAttachmentRuntimePort(candidate),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_INVALID',
  )
  assert.equal(getterCalled, false)
})

test('port rebuilds frozen inputs and public attachment outputs', async () => {
  let observedInput = null
  const prepared = prepareManagedAttachmentRuntimePort(port({
    async validateAttachments(input) {
      observedInput = input
      return [attachment()]
    },
  }))
  const original = validateInput()
  const result = await prepared.validateAttachments(original)

  assert.notEqual(observedInput, original)
  assert.equal(Object.isFrozen(observedInput), true)
  assert.equal(Object.isFrozen(observedInput.attachmentIds), true)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result[0]), true)
  assert.deepEqual(result, [attachment()])
})

test('port rejects identity drift and host-path output fields', () => {
  const wrongIdentity = prepareManagedAttachmentRuntimePort(port({
    validateAttachments: () => [attachment('attachment-other')],
  }))
  assert.throws(
    () => wrongIdentity.validateAttachments(validateInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_IDENTITY_MISMATCH',
  )

  const leakingPath = prepareManagedAttachmentRuntimePort(port({
    validateAttachments: () => [attachment('attachment-1', { fullPath: 'C:\\private\\a' })],
  }))
  assert.throws(
    () => leakingPath.validateAttachments(validateInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID',
  )
})

test('port accepts safe own-data thenables and rejects a then accessor', async () => {
  const safeThenable = prepareManagedAttachmentRuntimePort(port({
    validateAttachments() {
      return {
        then(resolve) {
          resolve([attachment()])
        },
      }
    },
  }))
  assert.deepEqual(await safeThenable.validateAttachments(validateInput()), [attachment()])

  let getterCalled = false
  const result = {}
  Object.defineProperty(result, 'then', {
    enumerable: true,
    get() {
      getterCalled = true
      return () => {}
    },
  })
  const unsafeThenable = prepareManagedAttachmentRuntimePort(port({
    validateAttachments: () => result,
  }))
  assert.throws(
    () => unsafeThenable.validateAttachments(validateInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID',
  )
  assert.equal(getterCalled, false)
})

test('port rejects a modified native Promise without invoking its constructor accessor', () => {
  let getterCalls = 0
  const result = Promise.resolve([attachment()])
  Object.defineProperty(result, 'constructor', {
    get() {
      getterCalls += 1
      throw new Error('constructor getter must not execute')
    },
  })
  const prepared = prepareManagedAttachmentRuntimePort(port({
    validateAttachments: () => result,
  }))
  assert.throws(
    () => prepared.validateAttachments(validateInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID',
  )
  assert.equal(getterCalls, 0)
})

test('controller is fail-closed, lease-aware, and revokes released snapshots', () => {
  assert.equal(getManagedAttachmentRuntimePortStatus().configured, false)
  assert.throws(
    () => acquireManagedAttachmentRuntimePort(),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_NOT_CONFIGURED',
  )

  const controller = createManagedAttachmentRuntimePortController(port(), {
    source: 'test.lifecycle',
  })
  controller.activate()
  const lease = acquireManagedAttachmentRuntimePort()
  assert.deepEqual(getManagedAttachmentRuntimePortStatus(), {
    configured: true,
    portId: 'test.managed-attachments',
    apiVersion: MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
    source: 'test.lifecycle',
    activeLeases: 1,
    inFlightCalls: 0,
  })
  assert.throws(
    () => controller.release(),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_IN_USE',
  )
  assert.deepEqual(lease.port.validateAttachments(validateInput()), [attachment()])
  assert.equal(lease.release(), true)
  assert.equal(lease.release(), false)
  assert.throws(
    () => lease.port.validateAttachments(validateInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_REVOKED',
  )
  assert.equal(controller.release(), true)
  assert.equal(getManagedAttachmentRuntimePortStatus().configured, false)
})

test('prepareAttachments freezes structured model content without accepting private fields', async () => {
  const bytes = Buffer.from([0])
  const image = attachment('attachment-image', {
    name: 'image.png',
    mimeType: 'image/png',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  const prepared = prepareManagedAttachmentRuntimePort(port({
    prepareAttachments: async ({ expectedAttachments }) => ({
      attachments: expectedAttachments.map((item) => attachment(item.id, {
        ...item,
        messageId: 'message-bound',
      })),
      content: [
        { type: 'text', text: 'notes' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
    }),
  }))
  const result = await prepared.prepareAttachments(prepareInput([expectedReceipt(image)]))

  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.content), true)
  assert.ok(result.content.every(Object.isFrozen))
  assert.equal(Object.isFrozen(result.content[1].image_url), true)
})

test('port rejects Proxies and array accessors without invoking their traps or getters', () => {
  let proxyTraps = 0
  const proxyOutput = new Proxy([], {
    getOwnPropertyDescriptor() {
      proxyTraps += 1
      throw new Error('must not execute')
    },
  })
  const proxied = prepareManagedAttachmentRuntimePort(port({
    validateAttachments: () => proxyOutput,
  }))
  assert.throws(
    () => proxied.validateAttachments(validateInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID',
  )
  assert.equal(proxyTraps, 0)

  let getterCalls = 0
  const accessorOutput = []
  Object.defineProperty(accessorOutput, '0', {
    enumerable: true,
    get() {
      getterCalls += 1
      return attachment()
    },
  })
  accessorOutput.length = 1
  const accessor = prepareManagedAttachmentRuntimePort(port({
    validateAttachments: () => accessorOutput,
  }))
  assert.throws(
    () => accessor.validateAttachments(validateInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID',
  )
  assert.equal(getterCalls, 0)
})

test('port rejects host paths, external URLs, malformed media, and oversized text', async () => {
  for (const overrides of [
    { name: 'C:\\private\\notes.txt' },
    { uri: 'file:///private/notes.txt' },
    { downloadUrl: 'https://example.com/private/notes.txt' },
  ]) {
    const prepared = prepareManagedAttachmentRuntimePort(port({
      validateAttachments: () => [attachment('attachment-1', overrides)],
    }))
    assert.throws(
      () => prepared.validateAttachments(validateInput()),
      (error) => (
        error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID'
        && !/C:\\|file:\/\/|example\.com/.test(error.message)
      ),
    )
  }

  const imageBytes = Buffer.from([0])
  const image = attachment('attachment-image', {
    name: 'image.png',
    mimeType: 'image/png',
    size: imageBytes.length,
    sha256: createHash('sha256').update(imageBytes).digest('hex'),
  })
  const externalMedia = prepareManagedAttachmentRuntimePort(port({
    prepareAttachments: ({ expectedAttachments }) => ({
      attachments: expectedAttachments.map((item) => attachment(item.id, {
        ...item,
        messageId: 'message-bound',
      })),
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
    }),
  }))
  await assert.rejects(
    Promise.resolve().then(() => externalMedia.prepareAttachments(
      prepareInput([expectedReceipt(image)]),
    )),
    (error) => (
      error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID'
      && !error.message.includes('example.com')
    ),
  )

  const oversized = prepareManagedAttachmentRuntimePort(port({
    prepareAttachments: ({ expectedAttachments }) => ({
      attachments: expectedAttachments.map((item) => attachment(item.id, {
        ...item,
        messageId: 'message-bound',
      })),
      content: [{ type: 'text', text: 'x'.repeat((1024 * 1024) + 1) }],
    }),
  }))
  assert.throws(
    () => oversized.prepareAttachments(prepareInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID',
  )
})

test('bind and prepare outputs fail closed on binding or receipt drift', () => {
  const badBinding = prepareManagedAttachmentRuntimePort(port({
    bindAttachments: ({ attachmentIds, messageId }) => attachmentIds.map((id) => (
      attachment(id, { messageId, sessionId: 'session-other' })
    )),
  }))
  assert.throws(
    () => badBinding.bindAttachments({
      ...validateInput(),
      messageId: 'message-1',
      now: 200,
    }),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_IDENTITY_MISMATCH',
  )

  const receiptDrift = prepareManagedAttachmentRuntimePort(port({
    prepareAttachments: ({ expectedAttachments }) => ({
      attachments: expectedAttachments.map((item) => attachment(item.id, {
        ...item,
        sha256: 'b'.repeat(64),
        messageId: 'message-bound',
      })),
      content: [{ type: 'text', text: 'safe fallback' }],
    }),
  }))
  assert.throws(
    () => receiptDrift.prepareAttachments(prepareInput()),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_IDENTITY_MISMATCH',
  )
})

test('prepared methods use a stable frozen receiver and sanitize adapter failures', () => {
  let receiver = null
  const prepared = prepareManagedAttachmentRuntimePort(port({
    validateAttachments({ attachmentIds }) {
      receiver = this
      return attachmentIds.map((id) => attachment(id))
    },
  }))
  prepared.validateAttachments(validateInput())
  assert.equal(receiver.id, 'test.managed-attachments')
  assert.equal(Object.isFrozen(receiver), true)

  const failed = prepareManagedAttachmentRuntimePort(port({
    validateAttachments() {
      const error = new Error('C:\\Users\\owner\\secret.txt')
      error.cause = { privatePath: 'C:\\private' }
      throw error
    },
  }))
  assert.throws(
    () => failed.validateAttachments(validateInput()),
    (error) => (
      error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID'
      && !/C:\\|secret|private/i.test(`${error.message}\n${error.stack}`)
      && !Object.hasOwn(error, 'cause')
    ),
  )
})

test('lease revocation rejects an async result and keeps the binding in use until settlement', async () => {
  let resolveCall
  const controller = createManagedAttachmentRuntimePortController(port({
    validateAttachments: () => new Promise((resolve) => { resolveCall = resolve }),
  }), { source: 'test.async-lifecycle' })
  controller.activate()
  const lease = acquireManagedAttachmentRuntimePort()
  const pending = lease.port.validateAttachments(validateInput())
  assert.equal(getManagedAttachmentRuntimePortStatus().inFlightCalls, 1)
  assert.equal(lease.release(), true)
  assert.throws(
    () => controller.release(),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_IN_USE',
  )
  resolveCall([attachment()])
  await assert.rejects(
    pending,
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_REVOKED',
  )
  assert.equal(getManagedAttachmentRuntimePortStatus().inFlightCalls, 0)
  assert.equal(controller.release(), true)
})

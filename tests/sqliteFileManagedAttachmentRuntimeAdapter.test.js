import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SQLITE_FILE_MANAGED_ATTACHMENT_RUNTIME_ADAPTER_ID,
  createSqliteFileManagedAttachmentRuntimeAdapter,
} from '../server/adapters/sqliteFileManagedAttachmentRuntimeAdapter.js'

function attachment(overrides = {}) {
  return {
    id: 'attachment-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 12,
    sha256: 'a'.repeat(64),
    status: 'ready',
    sessionId: 'session-1',
    messageId: null,
    uri: 'attachment://attachment-1',
    downloadUrl: '/api/attachments/attachment-1/content',
    createdAt: 100,
    updatedAt: 101,
    fullPath: 'C:\\private\\attachments\\attachment-1',
    rootPath: 'C:\\private\\attachments',
    storagePath: 'private/attachment-1',
    ...overrides,
  }
}

test('sqlite-file managed attachment adapter exposes the versioned runtime surface', () => {
  const adapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => [],
    bind: () => [],
    prepare: () => ({ attachments: [], content: [] }),
  })

  assert.equal(adapter.apiVersion, 1)
  assert.equal(adapter.id, SQLITE_FILE_MANAGED_ATTACHMENT_RUNTIME_ADAPTER_ID)
  assert.equal(Object.isFrozen(adapter), true)
  assert.deepEqual(
    Object.keys(adapter).sort(),
    ['apiVersion', 'bindAttachments', 'id', 'prepareAttachments', 'validateAttachments'],
  )
})

test('validateAttachments returns frozen public DTOs without filesystem paths', async () => {
  let observedInput = null
  const adapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate(input) {
      observedInput = input
      return Promise.resolve([attachment()])
    },
    bind: () => [],
    prepare: () => ({ attachments: [], content: [] }),
  })
  const input = {
    userId: 'user-1',
    sessionId: 'session-1',
    attachmentIds: ['attachment-1'],
  }

  const result = await adapter.validateAttachments(input)

  assert.equal(observedInput, input)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result[0]), true)
  assert.equal(result[0].id, 'attachment-1')
  assert.equal(Object.hasOwn(result[0], 'fullPath'), false)
  assert.equal(Object.hasOwn(result[0], 'rootPath'), false)
  assert.equal(Object.hasOwn(result[0], 'storagePath'), false)
  assert.equal(JSON.stringify(result).includes('C:\\\\private'), false)
})

test('bindAttachments preserves public binding metadata and strips host-only fields', () => {
  let observedInput = null
  const adapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => [],
    bind(input) {
      observedInput = input
      return [attachment({ messageId: input.messageId })]
    },
    prepare: () => ({ attachments: [], content: [] }),
  })
  const input = {
    userId: 'user-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    attachmentIds: ['attachment-1'],
    now: 200,
  }

  const result = adapter.bindAttachments(input)

  assert.equal(observedInput, input)
  assert.equal(result[0].messageId, 'message-1')
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result[0]), true)
  assert.equal(Object.hasOwn(result[0], 'fullPath'), false)
})

test('prepareAttachments returns deeply frozen known model parts without host metadata', async () => {
  const adapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => [],
    bind: () => [],
    async prepare() {
      return {
        attachments: [attachment()],
        content: [
          { type: 'text', text: 'attachment text', fullPath: 'C:\\private\\text' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,AA==',
              fullPath: 'C:\\private\\image.png',
            },
            storagePath: 'private/image.png',
          },
          {
            type: 'yma_pdf',
            filename: 'document.pdf',
            file_data: 'data:application/pdf;base64,AA==',
            fallback_text: 'document text',
            rootPath: 'C:\\private',
          },
        ],
        fullPath: 'C:\\private\\prepared',
      }
    },
  })

  const result = await adapter.prepareAttachments({
    userId: 'user-1',
    sessionId: 'session-1',
    attachmentIds: ['attachment-1'],
    text: 'inspect',
  })

  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.attachments), true)
  assert.equal(Object.isFrozen(result.attachments[0]), true)
  assert.equal(Object.isFrozen(result.content), true)
  assert.ok(result.content.every(Object.isFrozen))
  assert.equal(Object.isFrozen(result.content[1].image_url), true)
  assert.equal(Object.hasOwn(result, 'fullPath'), false)
  assert.equal(Object.hasOwn(result.attachments[0], 'fullPath'), false)
  assert.equal(Object.hasOwn(result.content[0], 'fullPath'), false)
  assert.equal(Object.hasOwn(result.content[1].image_url, 'fullPath'), false)
  assert.equal(Object.hasOwn(result.content[2], 'rootPath'), false)
})

test('prepareAttachments preserves the existing no-attachment string content contract', async () => {
  const adapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => [],
    bind: () => [],
    prepare: async ({ text }) => ({ attachments: [], content: text }),
  })

  const result = await adapter.prepareAttachments({
    userId: 'user-1',
    sessionId: 'session-1',
    attachmentIds: [],
    text: 'plain prompt',
  })

  assert.deepEqual(result, { attachments: [], content: 'plain prompt' })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.attachments), true)
})

test('sqlite-file managed attachment adapter rejects missing dependencies and malformed outputs', async () => {
  assert.throws(
    () => createSqliteFileManagedAttachmentRuntimeAdapter({ validate: null }),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID',
  )

  const badList = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => ({ fullPath: 'C:\\private' }),
    bind: () => [],
    prepare: () => ({ attachments: [], content: [] }),
  })
  assert.throws(
    () => badList.validateAttachments({}),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID',
  )

  const badContent = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => [],
    bind: () => [],
    prepare: async () => ({
      attachments: [],
      content: [{ type: 'host_path', fullPath: 'C:\\private' }],
    }),
  })
  await assert.rejects(
    badContent.prepareAttachments({}),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID',
  )
})

test('adapter accepts own-data thenables without invoking a then accessor', async () => {
  const safeThenableAdapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => ({
      then(resolve) {
        resolve([attachment()])
      },
    }),
    bind: () => [],
    prepare: () => ({ attachments: [], content: [] }),
  })
  assert.equal((await safeThenableAdapter.validateAttachments({}))[0].id, 'attachment-1')

  let getterCalls = 0
  const accessorResult = {}
  Object.defineProperty(accessorResult, 'then', {
    get() {
      getterCalls += 1
      throw new Error('then getter must not execute')
    },
  })
  const accessorAdapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => accessorResult,
    bind: () => [],
    prepare: () => ({ attachments: [], content: [] }),
  })

  assert.throws(
    () => accessorAdapter.validateAttachments({}),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID',
  )
  assert.equal(getterCalls, 0)
})

test('adapter rejects a modified native Promise without invoking its constructor getter', () => {
  let getterCalls = 0
  const result = Promise.resolve([attachment()])
  Object.defineProperty(result, 'constructor', {
    get() {
      getterCalls += 1
      throw new Error('Promise constructor getter must not execute')
    },
  })
  const adapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => result,
    bind: () => [],
    prepare: () => ({ attachments: [], content: [] }),
  })

  assert.throws(
    () => adapter.validateAttachments({}),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID',
  )
  assert.equal(getterCalls, 0)
})

test('adapter rejects output accessors and proxies without executing them', () => {
  let fieldGetterCalls = 0
  const unsafeAttachment = attachment()
  Object.defineProperty(unsafeAttachment, 'id', {
    enumerable: true,
    get() {
      fieldGetterCalls += 1
      throw new Error('attachment getter must not execute')
    },
  })
  const accessorAdapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => [unsafeAttachment],
    bind: () => [],
    prepare: () => ({ attachments: [], content: [] }),
  })
  assert.throws(
    () => accessorAdapter.validateAttachments({}),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID',
  )
  assert.equal(fieldGetterCalls, 0)

  let indexGetterCalls = 0
  const unsafeContent = []
  Object.defineProperty(unsafeContent, '0', {
    enumerable: true,
    get() {
      indexGetterCalls += 1
      throw new Error('array index getter must not execute')
    },
  })
  unsafeContent.length = 1
  const indexAdapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => [],
    bind: () => [],
    prepare: () => ({ attachments: [], content: unsafeContent }),
  })
  assert.throws(
    () => indexAdapter.prepareAttachments({}),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID',
  )
  assert.equal(indexGetterCalls, 0)

  let proxyTrapCalls = 0
  const proxyAdapter = createSqliteFileManagedAttachmentRuntimeAdapter({
    validate: () => new Proxy([], {
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1
        throw new Error('proxy trap must not execute')
      },
    }),
    bind: () => [],
    prepare: () => ({ attachments: [], content: [] }),
  })
  assert.throws(
    () => proxyAdapter.validateAttachments({}),
    (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID',
  )
  assert.equal(proxyTrapCalls, 0)
})

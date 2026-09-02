import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MANAGED_ATTACHMENT_PUBLIC_FIELDS,
  projectManagedAttachmentDto,
  projectManagedAttachmentList,
} from '../server/core/managedAttachmentDtos.js'

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
    storagePath: 'private/attachment-1',
    rootPath: 'C:\\private\\attachments',
    sentinel: 'must-not-leak',
    ...overrides,
  }
}

test('managed attachment projector emits only the fixed public field set', () => {
  const projected = projectManagedAttachmentDto(attachment())

  assert.deepEqual(Object.keys(projected), MANAGED_ATTACHMENT_PUBLIC_FIELDS)
  assert.equal(Object.isFrozen(projected), true)
  for (const field of ['fullPath', 'storagePath', 'rootPath', 'sentinel']) {
    assert.equal(Object.hasOwn(projected, field), false)
  }
  assert.equal(JSON.stringify(projected).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(projected).includes('C:\\\\private'), false)
})

test('managed attachment projector ignores unknown accessors and rejects public accessors safely', () => {
  let unknownGetterCalls = 0
  const source = attachment()
  Object.defineProperty(source, 'privateGetter', {
    enumerable: true,
    get() {
      unknownGetterCalls += 1
      throw new Error('unknown getter must not execute')
    },
  })

  const projected = projectManagedAttachmentDto(source)
  assert.equal(unknownGetterCalls, 0)
  assert.equal(Object.hasOwn(projected, 'privateGetter'), false)

  let publicGetterCalls = 0
  Object.defineProperty(source, 'id', {
    enumerable: true,
    get() {
      publicGetterCalls += 1
      throw new Error('public getter must not execute')
    },
  })
  assert.throws(
    () => projectManagedAttachmentDto(source),
    (error) => error?.code === 'MANAGED_ATTACHMENT_DTO_INVALID',
  )
  assert.equal(publicGetterCalls, 0)
})

test('managed attachment list projection applies the same allowlist to every item', () => {
  const projected = projectManagedAttachmentList([
    attachment(),
    attachment({ id: 'attachment-2', sentinel: 'second-private-value' }),
  ])

  assert.equal(Object.isFrozen(projected), true)
  assert.deepEqual(projected.map((item) => Object.keys(item)), [
    MANAGED_ATTACHMENT_PUBLIC_FIELDS,
    MANAGED_ATTACHMENT_PUBLIC_FIELDS,
  ])
  assert.doesNotMatch(JSON.stringify(projected), /private|sentinel/u)
})

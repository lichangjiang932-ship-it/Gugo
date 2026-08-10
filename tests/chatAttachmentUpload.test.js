import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentSendState, createPendingChatAttachment, prepareChatAttachment } from '../src/lib/chatAttachmentUpload.js'

test('prepared attachments keep local previews but require a server upload', async () => {
  const file = { name: 'report.pdf', type: 'application/pdf', size: 10 }
  const pending = createPendingChatAttachment(file)
  const ready = await prepareChatAttachment(file, pending, {
    sessionId: 'session-1',
    parseImpl: async () => [{ kind: 'pdf', dataUrl: 'data:application/pdf;base64,AA==', text: 'preview' }],
    uploadImpl: async () => ({ id: 'server-id', name: 'report.pdf', mimeType: 'application/pdf', type: 'application/pdf', size: 10, sizeKB: '0.0', sha256: 'hash', downloadUrl: '/api/attachments/server-id/content' }),
  })
  assert.equal(ready.uploadStatus, 'ready')
  assert.equal(ready.id, 'server-id')
  assert.equal(ready.text, 'preview')
  assert.deepEqual(attachmentSendState([ready]), { uploading: false, failed: false })
})

test('failed and in-progress uploads block message sending', async () => {
  const pending = createPendingChatAttachment({ name: 'a.bin', type: '', size: 1 })
  assert.deepEqual(attachmentSendState([pending]), { uploading: true, failed: true })
  const failed = await prepareChatAttachment({ name: 'a.bin', type: '', size: 1 }, pending, {
    sessionId: 'session-1',
    parseImpl: async () => [{ kind: 'file' }],
    uploadImpl: async () => { throw new Error('network down') },
  })
  assert.equal(failed.uploadStatus, 'error')
  assert.match(failed.uploadError, /network down/)
  assert.deepEqual(attachmentSendState([failed]), { uploading: false, failed: true })
})

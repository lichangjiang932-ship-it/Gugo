import assert from 'node:assert/strict'
import test from 'node:test'
import { safeAttachmentName, serializeAttachmentReferences, uploadChatAttachment } from '../src/lib/attachmentClient.js'

test('attachment client uploads original bytes without exposing a local path', async () => {
  const file = { name: 'D:\\private\\report.pdf', type: 'application/pdf', size: 4 }
  let request = null
  const attachment = await uploadChatAttachment(file, {
    sessionId: 'session-1',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options }
      return new Response(JSON.stringify({ attachment: {
        id: 'attachment-1', name: 'report.pdf', mimeType: 'application/pdf', size: 4,
        sha256: 'abc123', status: 'ready', sessionId: 'session-1', downloadUrl: '/api/attachments/attachment-1/content',
      } }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    },
  })
  assert.equal(request.options.body, file)
  assert.equal(request.options.method, 'POST')
  assert.match(request.url, /^\/api\/attachments\?/)
  assert.match(request.url, /filename=report\.pdf/)
  assert.doesNotMatch(request.url, /private|D%3A|%5C/i)
  assert.equal(attachment.id, 'attachment-1')
  assert.equal(attachment.sha256, 'abc123')
})

test('attachment references exclude previews and failed uploads', () => {
  const references = serializeAttachmentReferences([{
    id: 'a1', name: '..\\secret\\notes.txt', mimeType: 'text/plain', size: 5,
    sha256: 'hash', downloadUrl: '/api/attachments/a1/content', uploadStatus: 'ready',
    dataUrl: 'data:text/plain;base64,c2VjcmV0', text: 'secret body',
  }, { id: 'a2', name: 'failed.txt', uploadStatus: 'error' }])
  assert.deepEqual(references, [{ id: 'a1', name: 'notes.txt', mimeType: 'text/plain', size: 5, sha256: 'hash', downloadUrl: '/api/attachments/a1/content' }])
  assert.equal(JSON.stringify(references).includes('secret body'), false)
  assert.equal(JSON.stringify(references).includes('data:'), false)
})

test('safe attachment names strip Windows and POSIX directory prefixes', () => {
  assert.equal(safeAttachmentName('C:\\Users\\me\\draft.docx'), 'draft.docx')
  assert.equal(safeAttachmentName('/home/me/draft.docx'), 'draft.docx')
})

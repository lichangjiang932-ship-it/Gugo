import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChatAttachments } from '../src/lib/chatAttachmentParser.js'

test('chat attachment parser extracts text files', async () => {
  const [attachment] = await parseChatAttachments([{
    name: 'notes.txt',
    size: 12,
    type: 'text/plain',
    text: async () => 'hello world',
  }])
  assert.equal(attachment.kind, 'text')
  assert.equal(attachment.text, 'hello world')
})

test('chat attachment parser returns localized unsupported-format errors', async () => {
  const [attachment] = await parseChatAttachments([{
    name: 'archive.zip',
    size: 24,
    type: 'application/zip',
  }], {
    messages: { unsupportedFormat: 'unsupported-localized' },
  })
  assert.equal(attachment.kind, 'file')
  assert.equal(attachment.error, 'unsupported-localized')
})

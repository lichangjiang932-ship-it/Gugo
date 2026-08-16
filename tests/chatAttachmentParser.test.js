import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
  parseChatAttachments,
} from '../src/lib/chatAttachmentParser.js'

test('chat attachment limits match the managed upload capacity', async () => {
  assert.equal(MAX_CHAT_ATTACHMENTS_PER_MESSAGE, 32)
  assert.equal(MAX_IMAGES_PER_MESSAGE, 32)
  const [attachment] = await parseChatAttachments([{
    name: 'overflow.png',
    size: 12,
    type: 'image/png',
  }], {
    existingImageCount: 32,
    messages: { imageLimit: '32-image-limit' },
  })
  assert.equal(attachment.kind, 'file')
  assert.equal(attachment.error, '32-image-limit')
})

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

test('chat attachment parser keeps PDF data and extracted text together', async () => {
  const OriginalFileReader = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:application/pdf;base64,JVBERg=='
      this.onload()
    }
  }
  try {
    const source = new TextEncoder().encode('%PDF-1.4\nBT (Hello PDF) Tj ET')
    const [attachment] = await parseChatAttachments([{
      name: 'report.pdf',
      size: source.byteLength,
      type: 'application/pdf',
      arrayBuffer: async () => source.buffer,
    }])
    assert.equal(attachment.kind, 'pdf')
    assert.equal(attachment.dataUrl, 'data:application/pdf;base64,JVBERg==')
    assert.match(attachment.text, /Hello PDF/)
  } finally {
    globalThis.FileReader = OriginalFileReader
  }
})

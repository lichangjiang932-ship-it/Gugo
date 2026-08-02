import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampTextToBytes,
  dataUrlByteLength,
  getClipboardImageFiles,
  isExcelFile,
  isPdfFile,
  isTextLikeFile,
} from '../src/lib/chatAttachmentFiles.js'

test('chat attachment helpers classify supported document types', () => {
  assert.equal(isPdfFile({ type: '', name: 'report.PDF' }), true)
  assert.equal(isExcelFile({ name: 'report.xlsx' }), true)
  assert.equal(isTextLikeFile({ type: 'application/json', name: 'payload' }), true)
  assert.equal(isTextLikeFile({ type: '', name: 'archive.zip' }), false)
})

test('chat attachment helpers extract pasted images without treating copied text as a file', () => {
  const image = { name: 'clipboard.png', type: 'image/png' }
  const files = getClipboardImageFiles({
    items: [
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', getAsFile: () => image },
    ],
  })
  assert.deepEqual(files, [image])
  assert.deepEqual(getClipboardImageFiles({ items: [{ kind: 'string', type: 'text/plain' }] }), [])
})

test('chat attachment helpers measure data URLs and preserve a truncation marker', () => {
  assert.equal(dataUrlByteLength('data:image/png;base64,AAAA'), 3)
  const clipped = clampTextToBytes('x'.repeat(300_000), 'Large file')
  assert.ok(clipped.length < 300_000)
  assert.match(clipped, /\[Large file, truncated\]$/)
})

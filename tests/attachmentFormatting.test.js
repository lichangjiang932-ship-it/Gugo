import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildUserContentWithAttachments,
  formatAttachmentForPrompt,
} from '../src/lib/attachments.js'

test('formats text attachments as bounded prompt context', () => {
  const formatted = formatAttachmentForPrompt({
    kind: 'text',
    name: 'notes.md',
    sizeKB: '1.2',
    text: '# Meeting notes\nShip the local model switcher.',
  })

  assert.equal(
    formatted,
    '\n\n[附件: notes.md, 1.2 KB]\n```\n# Meeting notes\nShip the local model switcher.\n```'
  )
})

test('builds multimodal user content when images are attached', () => {
  const content = buildUserContentWithAttachments('请总结', [
    {
      kind: 'text',
      name: 'data.csv',
      sizeKB: '0.8',
      text: 'name,value\natelier,42',
    },
    {
      kind: 'image',
      name: 'mockup.png',
      sizeKB: '3.1',
      dataUrl: 'data:image/png;base64,abc123',
    },
  ])

  assert.deepEqual(content, [
    {
      type: 'text',
      text: '请总结\n\n[附件: data.csv, 0.8 KB]\n```\nname,value\natelier,42\n```',
    },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc123' },
    },
  ])
})

test('falls back to an attachment analysis prompt when only files are provided', () => {
  const content = buildUserContentWithAttachments('', [
    { kind: 'file', name: 'archive.zip', sizeKB: '12.4', type: 'application/zip' },
  ])

  assert.equal(content, '请分析附件内容。\n\n[附件: archive.zip, 12.4 KB, 类型: application/zip（二进制文件，无法直接读取内容）]')
})

test('PDF 同时保留原始数据与本地文本回退', () => {
  const content = buildUserContentWithAttachments('请总结', [{
    kind: 'pdf',
    name: 'report.pdf',
    sizeKB: '4.2',
    dataUrl: 'data:application/pdf;base64,JVBERg==',
    text: '本地提取的 PDF 正文',
  }])

  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'yma_pdf')
  assert.equal(content[1].file_data, 'data:application/pdf;base64,JVBERg==')
  assert.match(content[1].fallback_text, /本地提取的 PDF 正文/)
})

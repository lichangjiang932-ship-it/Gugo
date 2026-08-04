import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeModelContentForEndpoint } from '../server/utils/modelContentCapabilities.js'

const PDF_PART = {
  type: 'yma_pdf',
  filename: 'report.pdf',
  file_data: 'data:application/pdf;base64,JVBERi0xLjQ=',
  fallback_text: '[附件: report.pdf]\n```\nQuarterly revenue grew 42%.\n```',
}

test('支持原生 PDF 的端点收到 file 内容块', () => {
  const [message] = normalizeModelContentForEndpoint([
    { role: 'user', content: [{ type: 'text', text: '总结附件' }, PDF_PART] },
  ], { supportsPdf: true })

  assert.deepEqual(message.content[1], {
    type: 'file',
    file: {
      filename: 'report.pdf',
      file_data: PDF_PART.file_data,
    },
  })
})

test('不支持原生 PDF 的端点收到本地提取文本且内部块不泄漏', () => {
  const [message] = normalizeModelContentForEndpoint([
    { role: 'user', content: [{ type: 'text', text: '总结附件' }, PDF_PART] },
  ], { supportsPdf: false })

  assert.equal(message.content[1].type, 'text')
  assert.match(message.content[1].text, /Quarterly revenue grew 42%/)
  assert.equal(JSON.stringify(message).includes('yma_pdf'), false)
  assert.equal(JSON.stringify(message).includes('file_data'), false)
})

test('原生 PDF 数据无效时即使能力开启也回退文本', () => {
  const [message] = normalizeModelContentForEndpoint([
    { role: 'user', content: [{ ...PDF_PART, file_data: 'not-a-data-url' }] },
  ], { supportsPdf: true })

  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /report\.pdf/)
})

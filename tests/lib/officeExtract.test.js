import test from 'node:test'
import assert from 'node:assert/strict'

import JSZip from 'jszip'
import {
  extractDocxText,
  extractPptxText,
  isDocxFile,
  isPptxFile,
} from '../../src/lib/officeExtract.js'

async function makeDocx(documentXml) {
  const zip = new JSZip()
  zip.file('word/document.xml', documentXml)
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  return new File([buffer], 'doc.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

async function makePptx(slides) {
  const zip = new JSZip()
  for (const [name, xml] of Object.entries(slides)) {
    zip.file(`ppt/slides/${name}`, xml)
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  return new File([buffer], 'deck.pptx', {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })
}

test('extractDocxText 聚合段落并解码 XML 实体', async () => {
  const file = await makeDocx(
    '<w:document xmlns:w="x"><w:body>' +
      '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second &amp; line</w:t></w:r></w:p>' +
      '</w:body></w:document>'
  )
  const text = await extractDocxText(file)
  assert.equal(text, 'Hello World\nSecond & line')
})

test('extractDocxText 对空文档给出可读提示而非空串', async () => {
  const file = await makeDocx('<w:document xmlns:w="x"><w:body></w:body></w:document>')
  const text = await extractDocxText(file)
  assert.match(text, /未提取到文本|为空/)
})

test('extractPptxText 按幻灯片序号数值排序（slide10 在 slide2 之后）', async () => {
  const file = await makePptx({
    'slide10.xml': '<p:sld xmlns:a="x"><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>',
    'slide2.xml': '<p:sld xmlns:a="x"><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>',
    'slide1.xml': '<p:sld xmlns:a="x"><a:p><a:r><a:t>One</a:t></a:r></a:p></p:sld>',
  })
  const text = await extractPptxText(file)
  const order = ['One', 'Two', 'Ten'].map((w) => text.indexOf(w))
  assert.ok(order[0] < order[1] && order[1] < order[2], `顺序错误: ${text}`)
})

test('isDocxFile / isPptxFile 按扩展名识别', () => {
  assert.equal(isDocxFile({ name: 'a.DOCX' }), true)
  assert.equal(isDocxFile({ name: 'a.txt' }), false)
  assert.equal(isPptxFile({ name: 'deck.pptx' }), true)
  assert.equal(isPptxFile({ name: 'deck.key' }), false)
})

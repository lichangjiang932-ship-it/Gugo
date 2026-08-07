import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'

import {
  classifyDirectFile,
  loadDirectFilePreview,
  parseDelimitedPreview,
  parseDocxPreview,
  parsePptxPreview,
  parseXlsxPreview,
  withArtifactPreviewMode,
} from '../src/lib/directFilePreview.js'

test('classifies mainstream direct file formats and keeps unknown binaries download-only', () => {
  const cases = {
    'report.pdf': 'pdf', 'photo.avif': 'image', 'scan.bmp': 'image', 'page.svg': 'image', 'index.html': 'html',
    'notes.md': 'markdown', 'app.tsx': 'code', 'data.json': 'json', 'feed.xml': 'xml',
    'table.csv': 'csv', 'table.tsv': 'csv', 'report.docx': 'docx', 'book.ods': 'xlsx',
    'book.xls': 'xlsx', 'deck.pptx': 'pptx', 'voice.opus': 'audio', 'movie.ogv': 'video',
    'archive.zip': 'unsupported', 'program.exe': 'unsupported',
  }
  for (const [filename, expected] of Object.entries(cases)) {
    assert.equal(classifyDirectFile({ filename }), expected, filename)
  }
  assert.equal(withArtifactPreviewMode('/api/artifacts/report.pdf?token=abc'), '/api/artifacts/report.pdf?token=abc&preview=1')
})

test('parses real DOCX paragraphs and headings from OOXML bytes', async () => {
  const zip = new JSZip()
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目总结</w:t></w:r></w:p>
    <w:p><w:r><w:t>本周完成核心功能。</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>补齐测试</w:t></w:r></w:p>
  </w:body></w:document>`)
  const preview = await parseDocxPreview(await zip.generateAsync({ type: 'nodebuffer' }), 'fallback.docx')
  assert.equal(preview.title, '项目总结')
  assert.deepEqual(preview.blocks, [
    { type: 'paragraph', text: '本周完成核心功能。' },
    { type: 'bullet', text: '补齐测试' },
  ])
})

test('parses real PPTX slide text from OOXML bytes', async () => {
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>封面</a:t></a:r></a:p><a:p><a:r><a:t>年度复盘</a:t></a:r></a:p></p:sld>')
  zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>成果</a:t></a:r></a:p><a:p><a:r><a:t>增长 42%</a:t></a:r></a:p></p:sld>')
  const preview = await parsePptxPreview(await zip.generateAsync({ type: 'nodebuffer' }), '年度报告.pptx')
  assert.equal(preview.slides.length, 2)
  assert.equal(preview.slides[1].title, '成果')
  assert.match(preview.content, /增长 42%/)
})

test('parses real XLSX worksheets and cell values', async () => {
  const module = await import('@e965/xlsx')
  const XLSX = module.default || module
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['月份', '收入'], ['一月', 1200]]), '销售')
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
  const preview = await parseXlsxPreview(bytes)
  assert.equal(preview.sheets[0].name, '销售')
  assert.deepEqual(preview.sheets[0].rows, [['月份', '收入'], ['一月', '1200']])
})

test('parses legacy XLS and OpenDocument spreadsheet bytes', async () => {
  const module = await import('@e965/xlsx')
  const XLSX = module.default || module
  for (const bookType of ['xls', 'ods']) {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['Format', 'Value'],
      [bookType.toUpperCase(), 42],
    ]), 'Data')
    const bytes = XLSX.write(workbook, { type: 'array', bookType })
    const preview = await parseXlsxPreview(bytes)
    assert.deepEqual(preview.sheets[0].rows, [
      ['Format', 'Value'],
      [bookType.toUpperCase(), '42'],
    ], bookType)
  }
})

test('loads and formats JSON/CSV text previews', async () => {
  const json = await loadDirectFilePreview({
    file: { filename: 'data.json' }, url: '/data.json',
    fetchImpl: async () => new Response('{"ready":true}', { headers: { 'content-type': 'application/json' } }),
  })
  assert.match(json.text, /\n {2}"ready": true\n/)

  const csv = await loadDirectFilePreview({
    file: { filename: 'data.csv' }, url: '/data.csv',
    fetchImpl: async () => new Response('name,note\nalpha,"one, two"'),
  })
  assert.deepEqual(csv.rows, [['name', 'note'], ['alpha', 'one, two']])
  assert.deepEqual(parseDelimitedPreview('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildOfficeFilename,
  createDocxBlobFromMarkdown,
  createXlsxBlobFromMarkdown,
  parseMarkdownDocument,
  parseSpreadsheetRows,
  shouldOfferOfficeExport,
} from '../src/lib/officeExport.js'

test('parses markdown document content for docx export', async () => {
  const doc = parseMarkdownDocument(`# 项目复盘

## 背景
项目完成本地模型工作台。

## 后续事项
- 补充文件导出
- 加强错误提示`)

  assert.equal(doc.title, '项目复盘')
  assert.equal(doc.blocks[0].type, 'heading')
  assert.equal(doc.blocks[0].text, '背景')
  assert.deepEqual(doc.blocks.slice(-2), [
    { type: 'bullet', text: '补充文件导出' },
    { type: 'bullet', text: '加强错误提示' },
  ])

  const blob = await createDocxBlobFromMarkdown('# 标题\n\n正文内容')
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.ok(blob.size > 1000)
})

test('parses markdown table content for xlsx export', async () => {
  const rows = parseSpreadsheetRows(`| 月份 | 收入 | 成本 |
| --- | ---: | ---: |
| 1月 | 1200 | 400 |
| 2月 | 1800 | 600 |`)

  assert.deepEqual(rows, [
    ['月份', '收入', '成本'],
    ['1月', '1200', '400'],
    ['2月', '1800', '600'],
  ])

  const blob = await createXlsxBlobFromMarkdown('| A | B |\n| - | - |\n| 1 | 2 |')
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.ok(blob.size > 1000)
})

test('parses csv fenced blocks and falls back to outline rows', () => {
  assert.deepEqual(
    parseSpreadsheetRows('```csv\nname,value\nalpha,1\nbeta,2\n```'),
    [
      ['name', 'value'],
      ['alpha', '1'],
      ['beta', '2'],
    ]
  )

  assert.deepEqual(parseSpreadsheetRows('结论\n- 增长明显\n- 成本可控'), [
    ['项目', '内容'],
    ['结论', '结论'],
    ['1', '增长明显'],
    ['2', '成本可控'],
  ])
})

test('detects office export types and builds safe filenames', () => {
  assert.equal(shouldOfferOfficeExport({ skillId: 'doc' }), 'docx')
  assert.equal(shouldOfferOfficeExport({ skillId: 'excel' }), 'xlsx')
  assert.equal(shouldOfferOfficeExport({ artifactType: 'docx' }), 'docx')
  assert.equal(shouldOfferOfficeExport({ artifactType: 'xlsx' }), 'xlsx')
  assert.equal(shouldOfferOfficeExport({ skillId: 'mail' }), '')
  assert.equal(buildOfficeFilename('周报 / 五月?', 'docx'), '周报-五月.docx')
  assert.equal(buildOfficeFilename('', 'xlsx'), 'export.xlsx')
})

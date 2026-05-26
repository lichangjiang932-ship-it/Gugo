import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePptx, extractSlideTexts } from '../src/lib/pptxParse.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, '..', 'test-fixtures', 'sample.pptx')

test('pptxParse 真实 fixture 解析出 3 页 + 标题正确', async () => {
  assert.ok(fs.existsSync(FIXTURE), '需要 test-fixtures/sample.pptx, 重新生成: node scripts ...')
  const buf = fs.readFileSync(FIXTURE)
  const slides = await parsePptx(buf)
  assert.equal(slides.length, 3, '应有 3 页')
  assert.equal(slides[0].idx, 1)
  // 标题等于第一行文字
  assert.equal(slides[0].title, 'Sample Deck Title')
  assert.match(slides[1].title, /Problem|opportunity/i)
  assert.equal(slides[2].title, '结束 / 致谢')
  // 每页至少 1 行
  for (const s of slides) assert.ok(s.lines.length >= 1)
})

test('pptxParse 拒绝超大文件', async () => {
  const big = new Uint8Array(1024)
  await assert.rejects(
    () => parsePptx(big, { maxBytes: 100 }),
    /too large/,
  )
})

test('pptxParse 损坏 zip 抛 not a valid pptx', async () => {
  const fake = Buffer.from('not a zip just text')
  await assert.rejects(() => parsePptx(fake), /not a valid pptx|no slides/)
})

test('pptxParse 空数据抛 empty', async () => {
  await assert.rejects(() => parsePptx(new Uint8Array(0)), /empty/)
})

test('extractSlideTexts 段落合并 + 多 run', () => {
  const xml = `<a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>World</a:t></a:r></a:p><a:p><a:r><a:t>Line 2</a:t></a:r></a:p>`
  const lines = extractSlideTexts(xml)
  assert.deepEqual(lines, ['Hello World', 'Line 2'])
})

test('extractSlideTexts 解码实体', () => {
  const xml = '<a:p><a:r><a:t>A &amp; B &lt;x&gt;</a:t></a:r></a:p>'
  assert.deepEqual(extractSlideTexts(xml), ['A & B <x>'])
})

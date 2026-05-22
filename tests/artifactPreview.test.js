import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildArtifactPreview,
  buildHtmlDocument,
  isHtmlDeckLike,
  shouldCollapseArtifactPreview,
} from '../src/lib/artifactPreview.js'

test('builds a pptx artifact preview from slide markdown', () => {
  const preview = buildArtifactPreview({
    content: '# Launch Plan\nOpening frame\n\n---\n\n## Roadmap\n- Alpha\n- Beta',
    meta: { artifactType: 'pptx' },
  })

  assert.equal(preview.type, 'pptx')
  assert.equal(preview.title, 'Launch Plan')
  assert.equal(preview.filename, 'Launch-Plan.pptx')
  assert.equal(preview.summary, '2 页幻灯片')
  assert.equal(preview.slides.length, 2)
  assert.deepEqual(preview.slides[1].bullets, ['Alpha', 'Beta'])
})

test('builds a docx artifact preview from document markdown', () => {
  const preview = buildArtifactPreview({
    content: '# Weekly Report\n\n## Progress\n\n- Shipped export\n- Fixed downloads',
    meta: { skillId: 'doc' },
  })

  assert.equal(preview.type, 'docx')
  assert.equal(preview.title, 'Weekly Report')
  assert.equal(preview.filename, 'Weekly-Report.docx')
  assert.equal(preview.summary, '3 个内容块')
  assert.equal(preview.blocks[0].type, 'heading')
  assert.equal(preview.blocks[1].text, 'Shipped export')
})

test('builds an xlsx artifact preview from table markdown', () => {
  const preview = buildArtifactPreview({
    content: '| Metric | Value |\n| - | - |\n| Revenue | 120 |\n| Cost | 45 |',
    meta: { artifactType: 'xlsx' },
  })

  assert.equal(preview.type, 'xlsx')
  assert.equal(preview.title, 'Metric')
  assert.equal(preview.filename, 'Metric.xlsx')
  assert.equal(preview.summary, '3 行数据')
  assert.deepEqual(preview.rows[0], ['Metric', 'Value'])
  assert.deepEqual(preview.rows[2], ['Cost', '45'])
})

test('returns null for non-file replies', () => {
  assert.equal(buildArtifactPreview({ content: 'hello', meta: { skillId: 'mail' } }), null)
})
test('treats htmlppt as an explicit html artifact instead of inferred content', () => {
  const preview = buildArtifactPreview({
    content: '```html\n<!doctype html><html><head><title>Pitch Deck</title></head><body><section class="slide active"><h1>Pitch Deck</h1></section></body></html>\n```',
    meta: { skillId: 'htmlppt', artifactType: 'html', artifactTitle: 'Pitch Deck' },
  })

  assert.equal(preview.type, 'html')
  assert.equal(preview.inferred, false)
  assert.equal(preview.title, 'Pitch Deck')
  assert.equal(preview.filename, 'Pitch-Deck.html')
  assert.equal(preview.previewable, true)
})

test('enhances html slide decks with platform navigation fallback', () => {
  const html = buildHtmlDocument(`
    <section class="slide active"><h1>封面</h1></section>
    <section class="slide"><h1>第二页</h1></section>
  `)

  assert.equal(isHtmlDeckLike(html), true)
  assert.match(html, /data-yma-deck-enhancer="style"/)
  assert.match(html, /window\.__ymaDeck/)
  assert.match(html, /yma-deck-next/)
  assert.match(html, /yma-deck-prev/)
})

test('does not inject deck controls into ordinary html fragments', () => {
  const html = buildHtmlDocument('<main><h1>普通网页</h1><p>Hello</p></main>')

  assert.equal(isHtmlDeckLike(html), false)
  assert.doesNotMatch(html, /data-yma-deck-enhancer/)
})


test('collapses inferred file previews into a single file card too', () => {
  const preview = buildArtifactPreview({
    content: '| Metric | Value |\n| --- | --- |\n| Revenue | 120 |\n| Cost | 45 |\n| Margin | 75 |\n| Users | 300 |\n| Growth | 12% |',
    meta: {},
  })

  assert.equal(preview.type, 'xlsx')
  assert.equal(preview.inferred, true)
  assert.equal(shouldCollapseArtifactPreview(preview), true)
})

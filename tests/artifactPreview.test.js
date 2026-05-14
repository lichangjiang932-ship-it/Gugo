import assert from 'node:assert/strict'
import test from 'node:test'

import { buildArtifactPreview } from '../src/lib/artifactPreview.js'

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

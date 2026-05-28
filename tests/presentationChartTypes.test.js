import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  buildHtmlPreview,
  parseMarkdownSlides,
} from '../src/lib/presentationExport.js'

const FIXTURE = fs.readFileSync(new URL('./fixtures/chart-types.md', import.meta.url), 'utf8')

test('PR4a: parses stacked / area / scatter chart types from markdown fence', () => {
  const slides = parseMarkdownSlides(FIXTURE)
  // slide 0 = cover; 1/2/3 = the three chart slides
  assert.equal(slides.length, 4)
  assert.equal(slides[1].type, 'chart')
  assert.equal(slides[1].chart.type, 'stacked')
  assert.equal(slides[1].chart.series.length, 3)
  assert.deepEqual(slides[1].chart.categories, ['Q1', 'Q2', 'Q3', 'Q4'])

  assert.equal(slides[2].type, 'chart')
  assert.equal(slides[2].chart.type, 'area')

  assert.equal(slides[3].type, 'chart')
  assert.equal(slides[3].chart.type, 'scatter')
})

test('PR4a: stacked chart type aliases (stack / stackedbar / stacked_bar) all resolve', () => {
  for (const alias of ['stack', 'stackedbar', 'stacked_bar']) {
    const md = `## T\n\n<!-- chart -->\n\n\`\`\`chart\ntype: ${alias}\ncategories: A,B\nFoo: 1,2\nBar: 3,4\n\`\`\``
    const slides = parseMarkdownSlides(md)
    assert.equal(slides[0].chart.type, 'stacked', `alias ${alias} should resolve to stacked`)
  }
})

test('PR4a: HTML preview emits stacked / area / scatter SVG shapes', () => {
  const html = buildHtmlPreview(FIXTURE)
  // every slide section must render an SVG
  assert.match(html, /<svg[\s\S]*<\/svg>/)
  // stacked: 3 series × 4 categories ≥ 10 rects (cumulative)
  const rectCount = (html.match(/<rect /g) || []).length
  assert.ok(rectCount >= 10, `expected ≥10 rects for stacked, got ${rectCount}`)
  // area: must have at least one path with opacity="0.18" (area fill)
  assert.match(html, /opacity="0\.18"/)
  // scatter: must have circles with opacity="0.85" (scatter dots)
  assert.match(html, /opacity="0\.85"/)
})

test('PR4a: unknown chart type still falls back to bar (no crash)', () => {
  const md = `## T\n\n<!-- chart -->\n\n\`\`\`chart\ntype: futuristic_3d_donut\ncategories: A,B\nFoo: 1,2\n\`\`\``
  const slides = parseMarkdownSlides(md)
  assert.equal(slides[0].chart.type, 'bar')
  const html = buildHtmlPreview(md)
  assert.match(html, /<svg[\s\S]*<\/svg>/)
})

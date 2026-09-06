import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { buildPptxArtifactBuffer } from '../server/services/pptxArtifactFormat.js'
import { PPTX_CHART_TYPES } from '../server/services/pptxArtifactContract.js'
import { applyPptxRunFonts } from '../server/services/pptxArtifactDesign.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQz38NQQxwFgBTqAjXImzcIAAAAABJRU5ErkJggg==',
  'base64',
)

function image(overrides = {}) {
  return { buffer: Buffer.from(PNG_BYTES), extension: 'png', pixelWidth: 3, pixelHeight: 2, ...overrides }
}

function textElement(text, overrides = {}) {
  return { type: 'text', x: 0.1, y: 0.1, w: 0.8, h: 0.3, text, ...overrides }
}

async function packageFor(slides, options = {}) {
  const result = await buildPptxArtifactBuffer({
    title: 'Metadata only', generatedAt: '2024-05-06T07:08:09.000Z',
    design: { background: 'FFFFFF', foreground: '172033' }, slides, ...options,
  })
  return { ...result, zip: await JSZip.loadAsync(result.buffer) }
}

async function chartForSlide(zip, index) {
  const relationships = await zip.file(`ppt/slides/_rels/slide${index}.xml.rels`).async('string')
  const target = relationships.match(/Type="[^"]*\/chart" Target="([^"]+)"/u)?.[1]
  assert.ok(target, `slide ${index} must have a native chart relationship`)
  return zip.file(target.replace(/^\//u, '')).async('string')
}

test('a one-slide canvas honors requested geometry, colors, fonts, notes, and absence of chrome', async () => {
  const { zip, fontInjection } = await packageFor([{
    title: 'Not an automatic cover',
    notes: 'Source: user-supplied quarterly figures.',
    elements: [
      textElement('实际业务结论', { h: 0.15, color: '#CC2200', font_size: 30, font_face: 'Arial', bold: true }),
      textElement('All requested narrative remains editable.', { y: 0.35, h: 0.2, font_size: 20 }),
    ],
  }], {
    brand: 'Must not appear',
    design: {
      aspect_ratio: '4:3', background: '#ffffff', foreground: '#112233',
      accent: '#CC2200', heading_font: 'Arial', body_font: 'Georgia', east_asian_font: 'Microsoft YaHei',
    },
  })
  const presentation = await zip.file('ppt/presentation.xml').async('string')
  const slide = await zip.file('ppt/slides/slide1.xml').async('string')
  assert.equal(zip.file('ppt/slides/slide2.xml'), null)
  assert.match(presentation, /<p:sldSz cx="9144000" cy="6858000"\/>/)
  assert.match(slide, /<a:srgbClr val="FFFFFF"\/>/)
  assert.match(slide, /<a:srgbClr val="CC2200"\/>/)
  assert.match(slide, /<a:srgbClr val="112233"\/>/)
  assert.match(slide, /<a:off x="914400" y="685800"\/><a:ext cx="7315200" cy="1028700"\/>/)
  assert.match(slide, /<a:latin typeface="Arial"/)
  assert.match(slide, /<a:latin typeface="Georgia"/)
  assert.match(slide, /<a:ea typeface="Microsoft YaHei"/)
  assert.match(slide, /<a:t>实际业务结论<\/a:t>/)
  assert.doesNotMatch(slide, /Not an automatic cover|Metadata only|Must not appear|2024-05-06|01 \/ 01/)
  assert.doesNotMatch(slide, /<p:pic>/)
  const notes = await zip.file('ppt/notesSlides/notesSlide1.xml').async('string')
  assert.match(notes, /Source: user-supplied quarterly figures/)
  assert.equal(fontInjection.font, 'Microsoft YaHei')
})

test('explicit custom slide dimensions and per-slide backgrounds survive the package', async () => {
  const { zip } = await packageFor([
    { title: 'One', elements: [textElement('First')] },
    { title: 'Two', background: '#001122', elements: [textElement('Second', { color: 'FFFFFF' })] },
  ], { design: { width: 12, height: 9, background: 'FFFFFF' } })
  assert.match(await zip.file('ppt/presentation.xml').async('string'), /cx="10972800" cy="8229600"/)
  assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /<a:srgbClr val="001122"\/>/)
})

test('explicit font sizes survive unchanged or reject overflow instead of silently shrinking', async () => {
  const { zip } = await packageFor([
    { title: 'Small cover by request', layout: 'cover' },
    { title: 'Metadata', elements: [textElement('Requested heading', { role: 'heading' }),
      textElement('Requested body', { y: 0.5, h: 0.2, font_size: 22.5 })] },
  ], { design: { heading_font: 'Arial', heading_font_size: 20, body_font_size: 18 } })
  const cover = await zip.file('ppt/slides/slide1.xml').async('string')
  const canvas = await zip.file('ppt/slides/slide2.xml').async('string')
  assert.match(cover, /sz="2000"/)
  assert.doesNotMatch(cover, /sz="4200"/)
  assert.match(canvas, /sz="2000"/)
  assert.match(canvas, /sz="2250"/)
  assert.match(canvas, /typeface="Arial"/)
  for (const options of [
    { element: { font_size: 18 }, design: {} },
    { element: {}, design: { body_font_size: 18 } },
    { element: { role: 'heading' }, design: { heading_font_size: 18 } },
  ]) {
    await assert.rejects(() => packageFor([{ title: 'Exact size', elements: [
      textElement('Twenty-letter phrase', { w: 0.1, h: 0.1, ...options.element }),
    ] }], { design: options.design }), (error) => error.code === 'PPTX_CONTENT_OVERFLOW')
  }
})

test('font names containing replacement markers are kept literal in Office XML', () => {
  const xml = '<a:rPr><a:latin typeface="Dollar $1"/><a:ea typeface="Dollar $1"/></a:rPr>'
  const rewritten = applyPptxRunFonts(xml, {
    bodyFont: 'Dollar $1', headingFont: 'Heading', eastAsianFont: 'CJK $& $2', headingEastAsianFont: 'Heading',
  })
  assert.equal(rewritten, '<a:rPr><a:latin typeface="Dollar $1"/><a:ea typeface="CJK $&amp; $2"/></a:rPr>')
})

test('native chart and table preserve zero, precise labels, rows, and editable data', async () => {
  const { zip } = await packageFor([{
    title: 'Editable evidence',
    elements: [
      { type: 'table', x: 0.05, y: 0.10, w: 0.40, h: 0.70, font_size: 14,
        header_fill: 'CC2200', header_color: 'FFFFFF',
        table: { header: true, column_widths: [0.4, 0.3, 0.3], rows: [['Code', 'Actual', 'Delta'], ['001', 42, 0], ['002', 35, null]] } },
      { type: 'chart', x: 0.52, y: 0.10, w: 0.43, h: 0.70,
        chart: { type: 'line', categories: ['First month', 'Second month', 'Third month'],
          series: [{ name: 'User series', values: [12.5, 0, -3.25] }],
          colors: ['#CC2200'], show_values: true, x_axis_title: 'Month', y_axis_title: 'Revenue, USD' } },
    ],
  }])
  const slide = await zip.file('ppt/slides/slide1.xml').async('string')
  assert.match(slide, /<a:tbl>/)
  assert.equal((slide.match(/<a:tr\b/gu) || []).length, 3)
  assert.match(slide, /<a:t>001<\/a:t>/)
  assert.match(slide, /<a:t>42<\/a:t>/)
  assert.match(slide, /<a:t>0<\/a:t>/)
  assert.doesNotMatch(slide, /<p:pic>/)
  const chart = await chartForSlide(zip, 1)
  assert.match(chart, /<c:lineChart>/)
  for (const text of ['First month', 'Second month', 'Third month', 'User series', '12.5', '0', '-3.25']) {
    assert.ok(chart.includes('>' + text + '<'), text)
  }
  assert.match(chart, /val="CC2200"/)
  assert.ok(Object.keys(zip.files).some((name) => /^ppt\/embeddings\/.*\.xlsx$/u.test(name)))
})

test('every supported chart type produces its requested native chart instead of a fallback', async () => {
  const { zip } = await packageFor(PPTX_CHART_TYPES.map((type) => ({
    title: type,
    elements: [{ type: 'chart', x: 0.1, y: 0.1, w: 0.8, h: 0.75,
      chart: { type, categories: ['A', 'B'], series: [{ name: 'Actual', values: [12, 24] }] } }],
  })))
  for (const [index, type] of PPTX_CHART_TYPES.entries()) {
    const chart = await chartForSlide(zip, index + 1)
    const expected = type.startsWith('bar') ? 'bar' : type
    assert.ok(chart.includes(`<c:${expected}Chart>`), type)
    if (type === 'bar-stacked') assert.match(chart, /<c:grouping val="stacked"\/>/)
    if (type === 'bar-horizontal') assert.match(chart, /<c:barDir val="bar"\/>/)
  }
})

test('stacked charts center native value labels in every series without changing the evidence', async () => {
  const values = [[12, 18, 15], [8, 13, 17]]
  const makeChart = (type, showValues) => ({
    type, categories: ['第一阶段', '第二阶段', '第三阶段'], show_values: showValues,
    series: values.map((series, index) => ({ name: index === 0 ? '甲组' : '乙组', values: series })),
  })
  const { zip } = await packageFor([
    { title: 'Visible segments', elements: [{ type: 'chart', x: 0.06, y: 0.2, w: 0.88, h: 0.7, chart: makeChart('bar-stacked', true) }] },
    { title: 'Hidden values', layout: 'chart', chart: makeChart('bar-stacked', false) },
    { title: 'Ordinary columns', layout: 'chart', chart: makeChart('bar', true) },
  ])
  for (const [index, visible] of [[1, true], [2, false]]) {
    const chart = await chartForSlide(zip, index)
    const series = [...chart.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/gu)].map(([xml]) => xml)
    assert.equal(series.length, 2)
    assert.equal((chart.match(/<c:dLblPos val="ctr"\/>/gu) || []).length, 3, 'both series and their parent chart have the same native label position')
    assert.doesNotMatch(chart, /<c:dLblPos val="outEnd"\/>/)
    series.forEach((xml, seriesIndex) => {
      const labels = xml.match(/<c:dLbls>[\s\S]*?<\/c:dLbls>/u)?.[0] || ''
      assert.match(labels, /<c:dLblPos val="ctr"\/>/)
      assert.ok(labels.includes('<c:showVal val="' + (visible ? '1' : '0') + '"/>'))
      const cache = xml.match(/<c:val>[\s\S]*?<\/c:val>/u)?.[0] || ''
      assert.deepEqual([...cache.matchAll(/<c:v>([^<]*)<\/c:v>/gu)].map((match) => Number(match[1])), values[seriesIndex])
    })
    const slide = await zip.file(`ppt/slides/slide${index}.xml`).async('string')
    assert.doesNotMatch(slide, /<p:pic>/, 'labels remain part of the editable chart, not a screenshot')
  }
  assert.doesNotMatch(await chartForSlide(zip, 3), /<c:dLblPos val="ctr"\/>/)
})

test('canvas preserves native shapes and zero-height or zero-width connection lines', async () => {
  const { zip } = await packageFor([{
    title: 'Diagram', elements: [
      { type: 'shape', shape: 'rect', x: 0.1, y: 0.2, w: 0.2, h: 0.2, fill: '#CC2200', line_width: 0 },
      { type: 'line', x: 0.3, y: 0.3, w: 0.3, h: 0, end_arrow: 'triangle', line_color: 'CC2200' },
      { type: 'line', x: 0.6, y: 0.3, w: 0, h: 0.3, end_arrow: 'triangle' },
    ],
  }])
  const slide = await zip.file('ppt/slides/slide1.xml').async('string')
  assert.equal((slide.match(/prst="line"/gu) || []).length, 2)
  assert.match(slide, /<a:ext cx="3657600" cy="0"\/>/)
  assert.match(slide, /<a:ext cx="0" cy="2057400"\/>/)
  assert.match(slide, /<a:tailEnd type="triangle"/)
  assert.doesNotMatch(slide, /<p:pic>/)
})

test('canvas images use only authorized prepared inputs with explicit placement and no duplicate overlays', async () => {
  for (const fit of ['contain', 'cover', 'stretch']) {
    const { zip } = await packageFor([{
      title: 'Photo', elements: [{ type: 'image', image_index: 1, fit, x: 0, y: 0, w: 0.5, h: 0.5 }],
    }], { preparedImages: [image({ targetIndex: 1, alt: 'User picture' })] })
    const slide = await zip.file('ppt/slides/slide1.xml').async('string')
    assert.equal((slide.match(/<p:pic>/gu) || []).length, 1, fit)
    assert.match(slide, /descr="User picture"/)
    assert.equal(Object.values(zip.files).filter((entry) => /^ppt\/media\/.*\.png$/u.test(entry.name)).length, 1)
    if (fit === 'stretch') assert.match(slide, /<a:off x="0" y="0"\/>/)
  }
})

test('canvas rejects outside references, bad bounds, unknown properties, and unreadable overflow', async () => {
  const invalid = [
    textElement('Bad bounds', { x: 0.9, w: 0.2 }),
    textElement('Bad size', { h: 0 }),
    textElement('Bad color', { color: 'red' }),
    { type: 'line', x: 0, y: 0, w: 0, h: 0 },
    { type: 'image', image_index: 1, x: 0, y: 0, w: 1, h: 1 },
    { type: 'image', image_index: 1, path: 'outside.png', x: 0, y: 0, w: 1, h: 1 },
    { type: 'image', image_index: 1, url: 'https://invalid.example/pixel', x: 0, y: 0, w: 1, h: 1 },
  ]
  for (const element of invalid) {
    await assert.rejects(() => packageFor([{ title: 'Invalid', elements: [element] }]), /slides\[0\]\.elements/)
  }
  await assert.rejects(() => packageFor([{ title: 'Overflow', elements: [
    textElement('全部保留'.repeat(1000), { w: 0.01, h: 0.01 }),
  ] }]), (error) => error.code === 'PPTX_CONTENT_OVERFLOW')
  await assert.rejects(() => packageFor([{ title: 'Conflict', bullets: ['Would be lost'], elements: [textElement('Canvas')] }]), /cannot accompany elements/)
  await assert.rejects(() => packageFor([{ title: 'Invalid' }], { design: { width: 10 } }), /width and height together/)
  await assert.rejects(() => packageFor([{ title: 'Invalid' }], { design: { width: Infinity, height: 10 } }), /finite number/)
  await assert.rejects(() => packageFor([
    { title: 'First' }, { title: 'Wrong target', elements: [{ type: 'image', image_index: 1, x: 0, y: 0, w: 0.5, h: 0.5 }] },
  ], { preparedImages: [image({ targetIndex: 1 })] }), /conflicts with the image target_index/)
})

test('invalid chart and table data fail rather than filtering points or fabricating zeros', async () => {
  const base = { type: 'line', categories: ['A', 'B'], series: [{ values: [1, 2] }] }
  const charts = [
    { ...base, categories: ['A'] },
    { ...base, series: [{ values: [1, 2] }, { values: [3] }] },
    ...[null, undefined, NaN, Infinity, '2'].map((value) => ({ ...base, series: [{ values: [1, value] }] })),
    { ...base, type: 'not-a-chart' },
    { ...base, type: 'pie', series: [{ values: [1, 2] }, { values: [3, 4] }] },
    { ...base, type: 'doughnut', series: [{ values: [0, 0] }] },
  ]
  for (const chart of charts) {
    await assert.rejects(() => packageFor([{ title: 'Invalid chart', layout: 'chart', chart }]), /chart/)
  }
  for (const table of [
    { rows: [['A', 'B'], ['Only A']] },
    { rows: [['A'], [NaN]] },
    { rows: [['A', 'B']], column_widths: [1] },
    { rows: [['A', 'B']], column_widths: [0.2, 0.2] },
  ]) {
    await assert.rejects(() => packageFor([{ title: 'Invalid table', layout: 'table', table }]), /table/)
  }
})

test('legacy layouts retain every paragraph, including long text, extra split columns, and delimiters', async () => {
  const paragraph = 'This complete paragraph is deliberately longer than sixty characters and retains its final evidence marker END.'
  const bullets = [paragraph, 'Second complete statement.', 'Third complete statement.', 'Fourth complete statement.']
  const layouts = ['cover', 'section', 'split', 'statement', 'end', 'bullets', 'process']
  const { zip } = await packageFor(layouts.map((layout) => ({
    title: 'Authored ' + layout, layout, bullets, body: 'Additional body remains intact.',
  })))
  for (let index = 0; index < layouts.length; index += 1) {
    const slide = await zip.file(`ppt/slides/slide${index + 1}.xml`).async('string')
    for (const text of [...bullets, 'Additional body remains intact.']) assert.ok(slide.includes(text), layouts[index] + ': ' + text)
    assert.doesNotMatch(slide, /…/)
  }
  const { zip: processZip } = await packageFor([{ title: 'Process', layout: 'process', bullets: ['Inspect: http://example.test/a:b - preserve every delimiter'] }])
  assert.match(await processZip.file('ppt/slides/slide1.xml').async('string'), /http:\/\/example.test\/a:b - preserve every delimiter/)
})

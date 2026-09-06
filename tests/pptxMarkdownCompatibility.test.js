import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'

import { pptxSlidesFromArtifactArgs } from '../server/services/loop/heuristics/artifactPublishing.js'
import { PPTX_SLIDE_SCHEMA } from '../server/services/pptxArtifactContract.js'
import { assertPptxSchema } from '../server/services/pptxArtifactValidation.js'
import { buildPptxArtifactBuffer } from '../server/services/pptxArtifactFormat.js'
import { parseMarkdownSlides } from '../src/lib/presentationExport/presentationParser.js'

function normalize(markdown) {
  return pptxSlidesFromArtifactArgs({ markdown })
}

function chartMarkdown(type, rows, categories = 'A, B, C') {
  return `# Supplied chart\n<!-- chart -->\n\n\`\`\`chart\ntype: ${type}\ncategories: ${categories}\n${rows}\n\`\`\``
}

function assertContentInvalid(fn, pattern = null) {
  assert.throws(fn, (error) => error.code === 'PPTX_CONTENT_INVALID'
    && error.retryable === true && (!pattern || pattern.test(error.message)))
}

test('ordinary first pages are not coerced to covers and complete text is not clipped', () => {
  const long = `A complete sentence ${'with supporting evidence '.repeat(8)}END-OF-SENTENCE`
  const bullets = [long, ...Array.from({ length: 7 }, (_, index) => `Evidence ${index + 2}`)]
  const markdown = `# Ordinary analysis\n${bullets.map((text) => `- ${text}`).join('\n')}`
  assert.equal(parseMarkdownSlides(markdown)[0].type, 'cover', 'the browser parser has a positional cover heuristic')
  const [slide] = normalize(markdown)
  assert.equal(slide.layout, 'bullets')
  assert.deepEqual(slide.bullets, bullets)
  assert.match(slide.bullets[0], /END-OF-SENTENCE$/u)
  assert.equal(Object.hasOwn(slide, 'type'), false)
  assert.equal(Object.hasOwn(slide, 'index'), false)
  assert.deepEqual(normalize(''), [])
})

test('explicit cover, toc, section and ending tags map without inserting extra pages', () => {
  const markdown = [
    '# Product name\n<!-- cover -->\nFull subtitle',
    '# Agenda\n<!-- toc -->\n- Context\n- Evidence',
    '# Section one\n<!-- section -->\nSection explanation',
    '# Next steps\n<!-- end -->\nKeep this requested last page',
  ].join('\n---\n')
  const slides = normalize(markdown)
  assert.equal(slides.length, parseMarkdownSlides(markdown).length)
  assert.deepEqual(slides.map((slide) => slide.layout), ['cover', 'bullets', 'section', 'end'])
  assert.equal(normalize('# Cover\nAn explicitly named cover')[0].layout, 'cover')
  assert.equal(normalize('<!-- cover -->\n# Actual title\nActual subtitle')[0].title, 'Actual title')
})

test('legacy KPI data keeps negative values, zeros and every label without a five-item cut', () => {
  const [slide] = normalize('# Metrics\n<!-- data -->\n- -42% | Delta\n- 0 | Failures\n- Users: 120\nA supporting sentence')
  assert.equal(slide.layout, 'kpi')
  assert.deepEqual(slide.kpi, [
    { value: '-42%', label: 'Delta' },
    { value: '0', label: 'Failures' },
    { value: '120', label: 'Users' },
  ])
  assert.deepEqual(slide.bullets, ['A supporting sentence'])
  const all = Array.from({ length: 7 }, (_, index) => ({ value: String(index), label: `Metric ${index}` }))
  const [many] = normalize(`# All supplied metrics\n<!-- data -->\n${all.map((point) => `${point.value} | ${point.label}`).join('\n')}`)
  assert.equal(many.layout, 'table')
  assert.equal(many.table.header, false)
  assert.deepEqual(many.table.rows, all.map((point) => [point.label, point.value]))
})

test('native tables preserve empty cells, escaped pipes and source annotations', () => {
  const [slide] = normalize(`# Table\n<!-- table -->\n| Name | Left | Right |\n| --- | --- | --- |\n| Alpha | | A\\|B |\n| Beta | 0 | false |\n- Supplied source annotation`)
  assert.equal(slide.layout, 'table')
  assert.deepEqual(slide.table, {
    header: true,
    rows: [['Name', 'Left', 'Right'], ['Alpha', '', 'A|B'], ['Beta', '0', 'false']],
  })
  assert.deepEqual(slide.bullets, ['Supplied source annotation'])
  assertContentInvalid(() => normalize('# Inconsistent table\n<!-- table -->\n| A | B |\n| --- | --- |\n| only one |'), /same number/u)
  const [missing] = normalize('# Missing-value rows\n<!-- table -->\n| Name | Value |\n| --- | --- |\n| A | 1 |\n| - | - |')
  assert.deepEqual(missing.table.rows.at(-1), ['-', '-'])
})

test('split columns retain unequal content and process steps retain every description', () => {
  const markdown = [
    '# Compare\n<!-- split -->\nOverall comparison context\n**Left option**\n- Left detail\n**Right option**\n- Right detail one\n- Right detail two\n- Right detail three',
    '# Delivery\n<!-- process -->\n1. Prepare - inventory\n2. Migrate - canary\n3. Verify - regression',
  ].join('\n---\n')
  const [split, process] = normalize(markdown)
  assert.equal(split.layout, 'split')
  assert.equal(split.subtitle, 'Overall comparison context')
  assert.deepEqual(split.bullets, [
    'Left option\nLeft detail',
    'Right option\nRight detail one\nRight detail two\nRight detail three',
  ])
  assert.equal(process.layout, 'process')
  assert.deepEqual(process.bullets, ['Prepare - inventory', 'Migrate - canary', 'Verify - regression'])
  assertContentInvalid(() => normalize('# Invalid columns\n<!-- split -->\n**Only one**\n- Detail'), /two named/u)
  const singleProcess = normalize('# One process page\n<!-- process -->\n1. Prepare - inventory\n2. Migrate - canary\n3. Verify - regression')
  assert.equal(singleProcess.length, 1, 'numbered steps must not invent extra slides')
  assert.equal(singleProcess[0].layout, 'process')
  assert.equal(singleProcess[0].bullets.length, 3)
})

test('declared content pages and unmarked headings own their numbered body', () => {
  const items = ['1. Prepare', '2. Verify', '3. Deliver']
  for (const type of ['bullets', 'content', 'toc']) {
    for (const heading of [`# Steps\n<!-- ${type} -->`, `<!-- ${type} -->\n# Steps`]) {
      const slides = normalize(`${heading}\n${items.join('\n')}`)
      assert.equal(slides.length, 1, type)
      assert.equal(slides[0].title, 'Steps')
      assert.equal(slides[0].layout, 'bullets')
      assert.deepEqual(slides[0].bullets, items)
    }
  }
  for (const heading of ['# Steps', '## Steps', '###### Steps']) {
    const slides = normalize(`${heading}\n${items.join('\n')}`)
    assert.equal(slides.length, 1, heading)
    assert.equal(slides[0].title, 'Steps')
    assert.deepEqual(slides[0].bullets, ['Prepare', 'Verify', 'Deliver'])
  }
})

test('explicit page numbers retain numbered body items and every kind of preface', () => {
  const markdown = '# Deck heading\n## 1. First page\n<!-- bullets -->\n1. First step\n2. Second step\n## 2. Second page\n<!-- content -->\n1. Another step'
  const slides = normalize(markdown)
  assert.deepEqual(slides.map((slide) => slide.title), ['Deck heading', 'First page', 'Second page'])
  assert.deepEqual(slides[1].bullets, ['1. First step', '2. Second step'])
  assert.deepEqual(slides[2].bullets, ['1. Another step'])

  for (const pageTitles of [['第1页：First page', '第2页：Second page'], ['1. First page', '2. Second page']]) {
    const prefaced = normalize(`Supplied scope warning\n${pageTitles[0]}\n- First evidence\n${pageTitles[1]}\n- Second evidence`)
    assert.deepEqual(prefaced.map((slide) => slide.title), ['First page', 'Second page'])
    assert.equal(prefaced[0].subtitle, 'Supplied scope warning')
    assert.deepEqual(prefaced[0].bullets, ['First evidence'])
  }
})

test('single-page numbered bodies still reject invalid declarations and excess content', () => {
  assertContentInvalid(() => normalize('# Invalid\n<!-- unsupported -->\n1. One\n2. Two'), /does not support/u)
  assertContentInvalid(() => normalize('# Duplicate\n<!-- bullets -->\n<!-- content -->\n1. One\n2. Two'), /at most one/u)
  const items = Array.from({ length: 25 }, (_, index) => `${index + 1}. Item ${index + 1}`).join('\n')
  assertContentInvalid(() => normalize(`# Full page\n<!-- bullets -->\n${items}`), /at most 24/u)
  assertContentInvalid(() => normalize('# Empty quote\n<!-- quote -->\n>'), /non-empty/u)
})

test('quote bodies, attribution and extra explanatory text all survive normalization', () => {
  const [slide] = normalize('# Principle\n<!-- quote -->\n> Reliability beats novelty\n> Verification comes before completion\n> — Architecture review\n- Apply this to the delivery process')
  assert.deepEqual(slide.quote, {
    text: 'Reliability beats novelty\nVerification comes before completion',
    source: '— Architecture review',
  })
  assert.deepEqual(slide.bullets, ['Apply this to the delivery process'])
  assert.deepEqual(normalize('# Quote\n<!-- quote -->\nLegacy quotation\nLegacy author')[0].quote,
    { text: 'Legacy quotation', source: 'Legacy author' })
})

test('two marked quotation lines never invent attribution from the second sentence', () => {
  const text = 'Reliability beats novelty\nVerification comes before completion'
  for (const declaration of ['', '<!-- quote -->\n']) {
    const [slide] = normalize(`# Principle\n${declaration}> Reliability beats novelty\n> Verification comes before completion\n- Apply both principles`)
    assert.deepEqual(slide.quote, { text })
    assert.deepEqual(slide.bullets, ['Apply both principles'])
  }
  for (const source of ['— Architecture review', 'Source: Architecture review', '作者：审查人', '- Reviewer']) {
    const [slide] = normalize(`# Principle\n<!-- quote -->\n> Reliability beats novelty\n> ${source}`)
    assert.deepEqual(slide.quote, { text: 'Reliability beats novelty', source: source.replace(/^-\s+/u, '') })
  }
})

test('numbered single pages and full quotations survive real native PPTX rendering', async () => {
  const cases = [
    ...['bullets', 'content', 'toc'].map((type) => ({
      markdown: `# Steps\n<!-- ${type} -->\n1. Prepare\n2. Verify\n3. Deliver`,
      titles: ['Steps'], texts: ['1. Prepare', '2. Verify', '3. Deliver'],
    })),
    { markdown: '# Steps\n1. Prepare\n2. Verify\n3. Deliver', titles: ['Steps'], texts: ['Prepare', 'Verify', 'Deliver'] },
    {
      markdown: '# Principle\n<!-- quote -->\n> Reliability beats novelty\n> Verification comes before completion',
      titles: ['Principle'], texts: ['Reliability beats novelty', 'Verification comes before completion'], quotation: true,
    },
    {
      markdown: '# Deck heading\n## 1. First page\n<!-- bullets -->\n1. First step\n2. Second step\n## 2. Second page\n- Second evidence',
      titles: ['Deck heading', 'First page', 'Second page'], texts: ['1. First step', '2. Second step', 'Second evidence'],
    },
    {
      markdown: 'Supplied scope warning\n第1页：First page\n- First evidence\n第2页：Second page\n- Second evidence',
      titles: ['First page', 'Second page'], texts: ['Supplied scope warning', 'First evidence', 'Second evidence'],
    },
  ]
  for (const expected of cases) {
    const artifact = await buildPptxArtifactBuffer({ slides: normalize(expected.markdown), generatedAt: '2026-09-06T12:00:00.000Z' })
    const zip = await JSZip.loadAsync(artifact.buffer)
    const entries = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    assert.equal(entries.length, expected.titles.length, expected.markdown)
    const pages = await Promise.all(expected.titles.map((_title, index) => zip.file(`ppt/slides/slide${index + 1}.xml`).async('string')))
    expected.titles.forEach((title, index) => assert.ok(pages[index].includes(`<a:t>${title}</a:t>`), title))
    for (const text of expected.texts) assert.ok(pages.join('\n').includes(text), `missing supplied text: ${text}`)
    if (expected.quotation) {
      const shapes = pages[0].match(/<p:sp>[\s\S]*?<\/p:sp>/gu) || []
      const body = shapes.find((shape) => shape.includes(expected.texts[0]))
      assert.ok(body?.includes(expected.texts[1]), 'both quotation sentences belong to the same native text shape')
      assert.equal(shapes.filter((shape) => shape.includes(expected.texts[1])).length, 1)
    }
  }
})

test('stacked aliases normalize to the editable chart contract without filtering values', () => {
  for (const alias of ['stacked', 'stack', 'stackedbar', 'stacked_bar', 'bar-stacked']) {
    const [slide] = normalize(chartMarkdown(alias, 'Growth: 0, -2, 4\nRecovered: 1, 2, 3'))
    assert.equal(slide.layout, 'chart')
    assert.deepEqual(slide.chart, {
      type: 'bar-stacked', categories: ['A', 'B', 'C'],
      series: [{ name: 'Growth', values: [0, -2, 4] }, { name: 'Recovered', values: [1, 2, 3] }],
    })
  }
  assert.equal(normalize(chartMarkdown('column', 'Evidence: 1, 2, 3'))[0].chart.type, 'bar')
  assert.equal(normalize(chartMarkdown('doughnut', 'Evidence: 0, 2, 3'))[0].chart.type, 'doughnut')
})

test('chart captions outside its fence and bare chart grammar remain supported', () => {
  const markdown = '# Captioned chart\n<!-- chart -->\nBefore chart explanation\n```chart\ntype: line\ncategories: One, Two\nEvidence: 1, 2\n```\nAfter chart explanation'
  const [slide] = normalize(markdown)
  assert.deepEqual(slide.bullets, ['Before chart explanation', 'After chart explanation'])
  assert.deepEqual(normalize('# Bare chart\n<!-- chart -->\ntype: area\ncategories: A, B\nseries:\n"Observed": 1, 2')[0].chart,
    { type: 'area', categories: ['A', 'B'], series: [{ name: 'Observed', values: [1, 2] }] })
})

test('invalid chart tokens, missing points and unsupported types fail rather than substitute data', () => {
  for (const values of ['1, missing, 3', '1,,3', '1, 2,', 'NaN, 2, 3', '0, 1e400, 3']) {
    assertContentInvalid(() => normalize(chartMarkdown('bar', `Evidence: ${values}`)))
  }
  assertContentInvalid(() => normalize(chartMarkdown('bar', 'First: 1, 2, 3\nSecond: 4, 5')))
  assertContentInvalid(() => normalize(chartMarkdown('bar', 'Evidence: 1, 2, 3', 'A, B')))
  assertContentInvalid(() => normalize(chartMarkdown('pie', 'Evidence: -1, 2, 3')))
  for (const type of ['scatter', 'futuristic_3d_donut']) {
    assertContentInvalid(() => normalize(chartMarkdown(type, 'Evidence: 1, 2, 3')), /no substitute/u)
  }
})

test('numbered outlines and paired Markdown wrappers preserve the legacy page count', () => {
  const outline = 'Deck overview\nComplete subtitle\n\n1. First page\n- First evidence\n\n2. Second page\n- Second evidence'
  assert.equal(normalize(outline).length, parseMarkdownSlides(outline).length)
  assert.deepEqual(normalize(outline).map((slide) => slide.title), ['Deck overview', 'First page', 'Second page'])
  const wrapped = `\`\`\`markdown\n${chartMarkdown('stacked', 'Evidence: 1, 2, 3')}\n\`\`\``
  assert.equal(normalize(wrapped).length, 1)
  assert.equal(normalize(wrapped)[0].chart.type, 'bar-stacked')
  const chinese = '以下是三页方案\n第1页：分析\n- One\n第2页：证据\n- Two\n第3页：行动\n- Three'
  assert.equal(normalize(chinese).length, 3)
  assert.equal(normalize(chinese)[0].layout, 'bullets')
})

test('contract limits and Markdown image references fail explicitly without truncation or extra pages', () => {
  assertContentInvalid(() => normalize(`# Too many items\n${Array.from({ length: 25 }, (_, index) => `- Item ${index}`).join('\n')}`), /at most 24/u)
  assert.throws(() => normalize('# Unbound image\n![Required chart](https://example.test/chart.png)'),
    (error) => error.code === 'PPTX_IMAGE_REFERENCE_INVALID' && error.retryable === true)
})

test('explicit canvas input is never replaced by Markdown after its validation fails', async () => {
  const slides = [{
    title: 'Authored canvas', layout: 'canvas',
    elements: [{ type: 'text', text: 'Outside frame', x: 0.9, y: 0.1, w: 0.2, h: 0.2 }],
  }]
  const result = pptxSlidesFromArtifactArgs({ slides, markdown: '# Do not render this fallback\n- Different answer' })
  assert.equal(result, slides)
  await assert.rejects(buildPptxArtifactBuffer({ slides: result }), (error) => error.code === 'PPTX_CONTENT_INVALID')
})

test('normalized Markdown renders native editable evidence with the same page count', async () => {
  const markdown = [
    '# Ordinary report\n- First finding\n- Second finding\n- Third finding\n- Fourth finding\n- Fifth finding\n- Sixth finding',
    '# Metrics\n<!-- data -->\n-42% | Delta\n0 | Failures',
    '# Comparison\n<!-- split -->\n**Left**\n- Left evidence\n**Right**\n- Right evidence\n- Additional right evidence',
    '# Process\n<!-- process -->\n1. Prepare - inventory\n2. Migrate - canary\n3. Verify - regression',
    '# Table\n<!-- table -->\n| Name | Left | Right |\n| --- | --- | --- |\n| Alpha | | A\\|B |\n| Beta | 0 | false |',
    chartMarkdown('stacked', 'Growth: 0, -2, 4\nRecovered: 1, 2, 3'),
    '# Quote\n<!-- quote -->\n> Reliability first\n> — Architecture review',
  ].join('\n---\n')
  const slides = normalize(markdown)
  for (const [index, slide] of slides.entries()) assertPptxSchema(slide, PPTX_SLIDE_SCHEMA, `slides[${index}]`)
  const artifact = await buildPptxArtifactBuffer({
    title: 'Compatibility evidence', slides,
    design: { heading_font_size: 26, body_font_size: 14 }, generatedAt: '2026-09-06T12:00:00.000Z',
  })
  const zip = await JSZip.loadAsync(artifact.buffer)
  const slideEntries = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
  assert.equal(slideEntries.length, slides.length)
  assert.equal(slides.length, parseMarkdownSlides(markdown).length)
  const xml = (await Promise.all(slideEntries.map((name) => zip.file(name).async('string')))).join('\n')
  for (const text of ['Sixth finding', '-42%', 'Failures', 'Left evidence', 'Additional right evidence', 'Verify - regression', 'A|B', 'false', 'Reliability first', 'Architecture review']) {
    assert.ok(xml.includes(text), `missing original content: ${text}`)
  }
  assert.match(xml, /<a:tbl>/u)
  const chartEntry = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name))
  const chart = await zip.file(chartEntry).async('string')
  assert.match(chart, /<c:grouping val="stacked"\/>/u)
  assert.match(chart, /<c:v>-2<\/c:v>/u)
  assert.match(chart, /<c:v>0<\/c:v>/u)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

import { BUILTIN_ARTIFACT_TOOL_SPECS } from '../server/services/builtinArtifactToolSpecs.js'
import { buildPptxArtifactBuffer } from '../server/services/pptxArtifactFormat.js'
import { collectStaticModuleGraph } from './helpers/staticModuleGraph.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQz38NQQxwFgBTqAjXImzcIAAAAABJRU5ErkJggg==',
  'base64',
)

function preparedImage(overrides = {}) {
  return {
    buffer: Buffer.from(PNG_BYTES),
    extension: 'png',
    pixelWidth: 3,
    pixelHeight: 2,
    ...overrides,
  }
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length
}

async function loadPackage(options) {
  const result = await buildPptxArtifactBuffer(options)
  return { ...result, zip: await JSZip.loadAsync(result.buffer) }
}

test('PPTX format leaf preserves layout, theme receipt, footer, and CJK contracts', async () => {
  const { buffer, themeName, zip } = await loadPackage({
    title: 'Deck title',
    subtitle: 'Deck subtitle',
    theme: 'ocean',
    brand: 'Leaf',
    slides: [
      { title: 'Ignored cover title', layout: 'cover' },
      { title: 'First section', layout: 'section' },
      { title: 'A&B <body>', layout: 'bullets', bullets: ['One', 'Two'] },
      { title: 'Finish', layout: 'end' },
    ],
  })

  assert.equal(Buffer.isBuffer(buffer), true)
  assert.equal(themeName, 'ocean')
  for (let index = 1; index <= 4; index += 1) {
    assert.ok(zip.file(`ppt/slides/slide${index}.xml`), `slide ${index}`)
  }
  const presentation = await zip.file('ppt/presentation.xml').async('string')
  assert.match(presentation, /<p:sldSz cx="12192000" cy="6858000"\/>/)

  const slide1 = await zip.file('ppt/slides/slide1.xml').async('string')
  const slide2 = await zip.file('ppt/slides/slide2.xml').async('string')
  const slide3 = await zip.file('ppt/slides/slide3.xml').async('string')
  const slide4 = await zip.file('ppt/slides/slide4.xml').async('string')
  assert.match(slide1, /<a:t>Deck title<\/a:t>/)
  assert.doesNotMatch(slide1, /Ignored cover title/)
  assert.match(slide2, /<a:t>CHAPTER 01<\/a:t>/)
  assert.match(slide3, /<a:t>A&amp;B &lt;body&gt;<\/a:t>/)
  assert.match(slide3, /<a:t>03 \/ 04<\/a:t>/)
  assert.doesNotMatch(slide1, /01 \/ 04/)
  assert.doesNotMatch(slide2, /02 \/ 04/)
  assert.doesNotMatch(slide4, /04 \/ 04/)

  const theme = await zip.file('ppt/theme/theme1.xml').async('string')
  assert.equal(countMatches(theme, /<a:ea typeface="Microsoft YaHei"\/>/g), 2)
})

test('PPTX format leaf reproduces bytes for an explicit generatedAt', async () => {
  const options = { title: 'Reproducible', generatedAt: '2024-05-06T07:08:09.000Z', slides: [{ title: 'Cover', layout: 'cover' }] }
  const first = await buildPptxArtifactBuffer(options)
  const second = await buildPptxArtifactBuffer(options)
  assert.equal(first.buffer.equals(second.buffer), true)
  assert.equal(first.generatedAt, options.generatedAt)
  assert.equal(first.fontInjection.status, 'injected')
  const zip = await JSZip.loadAsync(first.buffer)
  const core = await zip.file('docProps/core.xml').async('string')
  const cover = await zip.file('ppt/slides/slide1.xml').async('string')
  assert.equal((core.match(/2024-05-06T07:08:09Z/g) || []).length, 2)
  assert.match(cover, /2024年5月/)
})

test('PPTX format leaf snapshots image bytes and preserves global rotation and zero coordinates', async () => {
  const mutable = Buffer.from(PNG_BYTES)
  const original = Buffer.from(mutable)
  const pending = buildPptxArtifactBuffer({
    title: 'Images',
    slides: [
      { title: 'One', layout: 'cover' },
      { title: 'Two', layout: 'bullets', bullets: ['two'] },
      { title: 'Three', layout: 'bullets', bullets: ['three'] },
    ],
    preparedImages: [
      preparedImage({ buffer: mutable, x: 0, y: 0, width: 1, height: 1 }),
      preparedImage({ targetIndex: 1 }),
      preparedImage(),
    ],
  })
  mutable.fill(0)
  const { buffer } = await pending
  const zip = await JSZip.loadAsync(buffer)

  const slide1 = await zip.file('ppt/slides/slide1.xml').async('string')
  const slide2 = await zip.file('ppt/slides/slide2.xml').async('string')
  const slide3 = await zip.file('ppt/slides/slide3.xml').async('string')
  assert.equal(countMatches(slide1, /<p:pic>/g), 2)
  assert.equal(countMatches(slide2, /<p:pic>/g), 0)
  assert.equal(countMatches(slide3, /<p:pic>/g), 1)
  const firstPicture = slide1.match(/<p:pic>[\s\S]*?<\/p:pic>/)?.[0] || ''
  assert.match(firstPicture, /<a:off x="0" y="0"\/>/)

  const mediaEntries = Object.values(zip.files).filter((entry) => /^ppt\/media\/[^/]+\.png$/.test(entry.name))
  assert.equal(mediaEntries.length, 3)
  const mediaBytes = await Promise.all(mediaEntries.map((entry) => entry.async('nodebuffer')))
  assert.equal(mediaBytes.some((bytes) => bytes.equals(original)), true)
})

test('PPTX canonical schema exposes stacked charts with bounded chart collections', () => {
  const parameters = BUILTIN_ARTIFACT_TOOL_SPECS.create_pptx.function.parameters
  const chart = parameters.properties.slides.items.properties.chart
  assert.deepEqual(chart.properties.type.enum, ['bar', 'bar-stacked', 'line', 'pie'])
  assert.equal(parameters.properties.slides.minItems, 1)
  assert.equal(parameters.properties.slides.maxItems, 100)
  assert.equal(chart.properties.categories.maxItems, 200)
  assert.equal(chart.properties.series.minItems, 1)
  assert.equal(chart.properties.series.maxItems, 20)
  assert.equal(chart.properties.series.items.properties.values.minItems, 1)
  assert.equal(chart.properties.series.items.properties.values.maxItems, 200)
  const slide = parameters.properties.slides.items.properties
  assert.equal(slide.bullets.maxItems, 5)
  assert.equal(slide.bullets.items.maxLength, 60)
  assert.equal(slide.kpi.maxItems, 4)
})

test('PPTX format leaf rejects incomplete explicit chart layouts with stable contract errors', async () => {
  const cases = [
    {
      slide: { title: 'Missing chart', layout: 'chart' },
      error: /slides\[0\]\.chart must be an object when layout is "chart"/,
    },
    {
      slide: { title: 'Missing series', layout: 'chart', chart: { type: 'bar' } },
      error: /slides\[0\]\.chart\.series must contain at least one series/,
    },
    {
      slide: { title: 'Empty values', layout: 'chart', chart: { type: 'bar', series: [{ values: [] }] } },
      error: /slides\[0\]\.chart\.series\[0\]\.values must contain at least one finite number/,
    },
  ]
  for (const { slide, error } of cases) {
    await assert.rejects(() => buildPptxArtifactBuffer({ slides: [slide] }), error)
  }
})

test('PPTX format leaf rejects explicit empty content layouts with stable contract errors', async () => {
  const cases = [
    {
      slide: { title: 'Empty KPI', layout: 'kpi', kpi: [] },
      error: /slides\[0\]\.kpi must contain at least one item with a value when layout is "kpi"/,
    },
    ...['process', 'bullets', 'split'].map((layout) => ({
      slide: { title: `Empty ${layout}`, layout, bullets: [] },
      error: new RegExp(`slides\\[0\\]\\.bullets or body must contain at least one non-empty item when layout is "${layout}"`),
    })),
  ]
  for (const { slide, error } of cases) {
    await assert.rejects(() => buildPptxArtifactBuffer({ slides: [slide] }), error)
  }
})

test('PPTX format leaf keeps empty content compatible when layout is automatic', async () => {
  const result = await buildPptxArtifactBuffer({
    generatedAt: '2024-05-06T07:08:09.000Z',
    slides: [
      { title: 'Cover' },
      { title: 'Title-only statement', bullets: [], kpi: [] },
    ],
  })
  const zip = await JSZip.loadAsync(result.buffer)
  const slide = await zip.file('ppt/slides/slide2.xml').async('string')
  assert.match(slide, /<a:t>Title-only statement<\/a:t>/)
})

test('PPTX images preserve bounded alt text in OOXML accessibility metadata', async () => {
  const alt = `Revenue & growth\u0000 ${'x'.repeat(600)}`
  const { zip } = await loadPackage({
    slides: [{ title: 'Accessible image', layout: 'cover' }],
    preparedImages: [preparedImage({ alt })],
  })
  const slide = await zip.file('ppt/slides/slide1.xml').async('string')
  const description = slide.match(/<p:cNvPr[^>]*descr="([^"]*)"/)?.[1]
  assert.ok(description)
  assert.match(description, /^Revenue &amp; growth /)
  assert.equal(description.replaceAll('&amp;', '&').length, 500)
  assert.equal(description.includes('\u0000'), false)
})

test('PPTX format leaf fails closed for malformed prepared images and out-of-range targets', async () => {
  const slides = [{ title: 'Only slide' }]
  await assert.rejects(
    () => buildPptxArtifactBuffer({ slides, preparedImages: {} }),
    /preparedImages must be an array/,
  )
  await assert.rejects(
    () => buildPptxArtifactBuffer({ slides, preparedImages: [preparedImage({ buffer: 'bytes' })] }),
    /buffer must be a non-empty Buffer/,
  )
  await assert.rejects(
    () => buildPptxArtifactBuffer({
      slides,
      preparedImages: [preparedImage({ buffer: Buffer.from('not an image') })],
    }),
    /valid PNG signature/,
  )
  await assert.rejects(
    () => buildPptxArtifactBuffer({ slides, preparedImages: [preparedImage({ extension: 'png/../xml' })] }),
    /extension must be png or jpg/,
  )
  await assert.rejects(
    () => buildPptxArtifactBuffer({ slides, preparedImages: [preparedImage({ pixelWidth: 0 })] }),
    /invalid pixel dimensions/,
  )
  await assert.rejects(
    () => buildPptxArtifactBuffer({ slides, preparedImages: [preparedImage({ targetIndex: -1 })] }),
    /targetIndex must be a positive integer/,
  )
  await assert.rejects(
    () => buildPptxArtifactBuffer({ slides, preparedImages: [preparedImage({ targetIndex: 2 })] }),
    /image target_index exceeds the 1-slide deck/,
  )
})

test('PPTX format leaf reports only an exact explicit theme and keeps inference local', async () => {
  const explicit = await buildPptxArtifactBuffer({
    title: 'Neutral',
    theme: 'forest',
    slides: [{ title: 'Cover' }],
  })
  assert.equal(explicit.themeName, 'forest')

  for (const invalidTheme of ['OCEAN', 'toString', 'constructor', '__proto__']) {
    const inferred = await loadPackage({
      title: '金融投研报告',
      theme: invalidTheme,
      slides: [{ title: 'Cover' }],
    })
    assert.equal(inferred.themeName, undefined, invalidTheme)
    const slide = await inferred.zip.file('ppt/slides/slide1.xml').async('string')
    assert.match(slide, /<a:srgbClr val="0B1A2A"\/>/, invalidTheme)
  }
})

test('PPTX format leaf has an explicit pure dependency boundary and artifactGen remains the host', () => {
  const entry = fileURLToPath(new URL('../server/services/pptxArtifactFormat.js', import.meta.url))
  const graph = collectStaticModuleGraph(entry)
  const allowedInternalFiles = new Set([
    entry,
    fileURLToPath(new URL('../server/services/officeImageLayout.js', import.meta.url)),
    fileURLToPath(new URL('../server/services/officePreparedImageValidation.js', import.meta.url)),
    fileURLToPath(new URL('../src/lib/pptCore.js', import.meta.url)),
  ].map((file) => path.resolve(file)))

  assert.deepEqual(graph.unresolvedLoads, [], 'computed module loads must be statically reviewable')
  assert.deepEqual(graph.unresolvedLocalModules, [], 'all relative dependencies must resolve')
  assert.deepEqual(
    [...graph.files].filter((file) => !allowedInternalFiles.has(path.resolve(file))),
    [],
    'new internal dependencies require an explicit leaf-boundary review',
  )
  const allowedExternalModules = new Set(['jszip', 'pptxgenjs'])
  assert.deepEqual(
    graph.externalLoads
      .filter(({ specifier }) => !allowedExternalModules.has(specifier))
      .map(({ file, kind, line, specifier }) => ({
        file: path.relative(path.dirname(entry), file).replaceAll('\\', '/'),
        kind,
        line,
        specifier,
      })),
    [],
    'the format leaf may use pptxgenjs and JSZip but no host, storage, or native IO package',
  )

  const host = readFileSync(fileURLToPath(new URL('../server/services/artifactGen.js', import.meta.url)), 'utf8')
  assert.match(host, /buildPptxArtifactBuffer/)
  assert.match(host, /prepareOfficeArtifactImages\(images, \{ userId \}\)/)
  assert.doesNotMatch(host, /(?:from|import\()[^\n]*pptxgenjs|\bfunction renderCover|injectEaFont\(/)
})

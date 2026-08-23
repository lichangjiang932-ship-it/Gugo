import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

import { buildDocxArtifactBuffer } from '../server/services/docxArtifactFormat.js'
import {
  collectStaticModuleGraph,
  extractStaticModuleLoads,
} from './helpers/staticModuleGraph.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQz38NQQxwFgBTqAjXImzcIAAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG_BYTES = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCbAVYGf//Z',
  'base64',
)

test('DOCX format leaf builds the required package and preserves heading and escaping semantics', async () => {
  const buffer = await buildDocxArtifactBuffer({
    title: 'Q&A <2026>',
    paragraphs: [
      { heading: 1, text: 'Heading & one' },
      { heading: 2, text: 'Heading <two>' },
      { heading: 3, text: 'Heading "three"' },
      'Plain > body',
    ],
  })
  const zip = await JSZip.loadAsync(buffer)

  for (const entry of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/_rels/document.xml.rels',
    'word/document.xml',
    'word/styles.xml',
  ]) {
    assert.ok(zip.file(entry), entry)
  }

  const documentXml = await zip.file('word/document.xml').async('string')
  assert.match(documentXml, /Q&amp;A &lt;2026&gt;/)
  assert.match(documentXml, /w:pStyle w:val="Heading1"[\s\S]*Heading &amp; one/)
  assert.match(documentXml, /w:pStyle w:val="Heading2"[\s\S]*Heading &lt;two&gt;/)
  assert.match(documentXml, /w:pStyle w:val="Heading3"[\s\S]*Heading &quot;three&quot;/)
  assert.match(documentXml, /Plain &gt; body/)

  const stylesXml = await zip.file('word/styles.xml').async('string')
  assert.match(stylesXml, /w:eastAsia="Microsoft YaHei"/)
})

test('DOCX format leaf replaces XML 1.0 forbidden characters before writing package parts', async () => {
  const buffer = await buildDocxArtifactBuffer({
    title: 'Bad\u0001 title',
    paragraphs: [{ text: 'Body\u0002 text' }],
    preparedImages: [{
      buffer: PNG_BYTES,
      extension: 'png',
      pixelWidth: 3,
      pixelHeight: 2,
      alt: 'Alt\u0003 text',
    }],
  })
  const zip = await JSZip.loadAsync(buffer)
  const documentXml = await zip.file('word/document.xml').async('string')

  for (const codePoint of [0x01, 0x02, 0x03, 0x08, 0x0B, 0x0C, 0x0E, 0x1F]) {
    assert.equal(documentXml.includes(String.fromCodePoint(codePoint)), false)
  }
  assert.match(documentXml, /Bad� title/)
  assert.match(documentXml, /Body� text/)
  assert.match(documentXml, /descr="Alt� text"/)
})

test('DOCX format leaf embeds prepared images at the requested paragraph with stable relationships', async () => {
  const buffer = await buildDocxArtifactBuffer({
    title: 'Images',
    paragraphs: [{ text: 'First' }, { text: 'Second' }],
    preparedImages: [{
      buffer: PNG_BYTES,
      extension: 'png',
      pixelWidth: 3,
      pixelHeight: 2,
      targetIndex: 1,
      alt: 'A&B "photo"',
      sourceName: 'photo.png',
    }],
  })
  const zip = await JSZip.loadAsync(buffer)
  const documentXml = await zip.file('word/document.xml').async('string')
  const relationshipsXml = await zip.file('word/_rels/document.xml.rels').async('string')
  const contentTypesXml = await zip.file('[Content_Types].xml').async('string')

  assert.deepEqual(await zip.file('word/media/image1.png').async('nodebuffer'), PNG_BYTES)
  assert.match(relationshipsXml, /Id="rId2"[\s\S]*Target="media\/image1\.png"/)
  assert.match(contentTypesXml, /Extension="png" ContentType="image\/png"/)
  assert.match(documentXml, /r:embed="rId2"/)
  assert.match(documentXml, /descr="A&amp;B &quot;photo&quot;"/)
  assert.ok(documentXml.indexOf('First') < documentXml.indexOf('r:embed="rId2"'))
  assert.ok(documentXml.indexOf('r:embed="rId2"') < documentXml.indexOf('Second'))
})

test('DOCX format leaf rejects malformed prepared image metadata before constructing OOXML paths', async () => {
  const base = {
    buffer: PNG_BYTES,
    extension: 'png',
    pixelWidth: 3,
    pixelHeight: 2,
  }
  await assert.rejects(
    () => buildDocxArtifactBuffer({ paragraphs: ['x'], preparedImages: [{ ...base, extension: 'png"/><Injected' }] }),
    /extension must be png or jpg/,
  )
  await assert.rejects(
    () => buildDocxArtifactBuffer({ paragraphs: ['x'], preparedImages: [{ ...base, buffer: 'not-bytes' }] }),
    /buffer must be a non-empty Buffer/,
  )
  await assert.rejects(
    () => buildDocxArtifactBuffer({ paragraphs: ['x'], preparedImages: [{ ...base, pixelWidth: 0 }] }),
    /invalid pixel dimensions/,
  )
})

test('DOCX format leaf accepts structurally valid PNG and JPEG bytes whose dimensions match metadata', async () => {
  const buffer = await buildDocxArtifactBuffer({
    paragraphs: ['Images'],
    preparedImages: [
      { buffer: PNG_BYTES, extension: 'png', pixelWidth: 3, pixelHeight: 2 },
      { buffer: JPEG_BYTES, extension: 'jpg', pixelWidth: 4, pixelHeight: 3 },
    ],
  })
  const zip = await JSZip.loadAsync(buffer)
  assert.deepEqual(await zip.file('word/media/image1.png').async('nodebuffer'), PNG_BYTES)
  assert.deepEqual(await zip.file('word/media/image2.jpg').async('nodebuffer'), JPEG_BYTES)
})

test('DOCX format leaf packages an immutable snapshot of validated image bytes', async () => {
  const mutableBytes = Buffer.from(PNG_BYTES)
  const pending = buildDocxArtifactBuffer({
    paragraphs: ['Image'],
    preparedImages: [{ buffer: mutableBytes, extension: 'png', pixelWidth: 3, pixelHeight: 2 }],
  })
  mutableBytes.fill(0)
  const zip = await JSZip.loadAsync(await pending)
  assert.deepEqual(await zip.file('word/media/image1.png').async('nodebuffer'), PNG_BYTES)
})

test('DOCX format leaf rejects disguised, truncated, mismatched, and falsely-sized image buffers', async () => {
  const preparedImage = (overrides = {}) => ({
    buffer: PNG_BYTES,
    extension: 'png',
    pixelWidth: 3,
    pixelHeight: 2,
    ...overrides,
  })
  await assert.rejects(
    () => buildDocxArtifactBuffer({ preparedImages: [preparedImage({ buffer: Buffer.from('not an image') })] }),
    /valid PNG signature/,
  )
  await assert.rejects(
    () => buildDocxArtifactBuffer({ preparedImages: [preparedImage({ buffer: PNG_BYTES.subarray(0, -5) })] }),
    /(?:truncated PNG chunk|complete PNG image structure)/,
  )
  const corruptPng = Buffer.from(PNG_BYTES)
  corruptPng[corruptPng.length - 1] ^= 0xff
  await assert.rejects(
    () => buildDocxArtifactBuffer({ preparedImages: [preparedImage({ buffer: corruptPng })] }),
    /invalid CRC/,
  )
  await assert.rejects(
    () => buildDocxArtifactBuffer({ preparedImages: [preparedImage({ extension: 'jpg' })] }),
    /valid JPEG signature/,
  )
  await assert.rejects(
    () => buildDocxArtifactBuffer({ preparedImages: [preparedImage({ pixelWidth: 4 })] }),
    /declared pixel dimensions 4x2 do not match the 3x2 PNG image/,
  )
  await assert.rejects(
    () => buildDocxArtifactBuffer({
      preparedImages: [{ buffer: JPEG_BYTES.subarray(0, -2), extension: 'jpg', pixelWidth: 4, pixelHeight: 3 }],
    }),
    /JPEG end marker/,
  )
})

test('static module graph scanner detects indirect and computed host module loading', () => {
  const source = `
    import JSZip from 'jszip'
    import sharp from 'sharp'
    export { default as Database } from 'better-sqlite3'
    import { createRequire as makeRequire } from 'node:module'
    await import(\`node:fs\`)
    await import('node:' + 'path')
    await import('node:' + unknownName)
    const load = makeRequire(import.meta.url)
    load('node:' + 'child_process')
    makeRequire(import.meta.url)('node:worker_threads')
    process.getBuiltinModule('fs')
    globalThis.process['getBuiltin' + 'Module']('node:net')
    const processAlias = process
    processAlias.getBuiltinModule('crypto')
    const { getBuiltinModule } = process
    getBuiltinModule('node:util')
    const globalProcessAlias = globalThis.process
    globalProcessAlias.getBuiltinModule('assert')
    const { getBuiltinModule: globalBuiltinLoader } = globalThis.process
    globalBuiltinLoader('node:buffer')
    processAlias.getBuiltinModule(unknownBuiltinName)
  `
  const result = extractStaticModuleLoads(source)
  const found = new Set(result.loads.map((load) => load.specifier))

  for (const specifier of [
    'jszip',
    'sharp',
    'better-sqlite3',
    'node:module',
    'node:fs',
    'node:path',
    'node:child_process',
    'node:worker_threads',
    'node:net',
    'node:crypto',
    'node:util',
    'node:assert',
    'node:buffer',
  ]) {
    assert.equal(found.has(specifier), true, specifier)
  }
  assert.deepEqual(
    result.unresolvedLoads.map(({ expression, kind }) => ({ expression, kind })),
    [
      { expression: "'node:' + unknownName", kind: 'import()' },
      { expression: 'unknownBuiltinName', kind: 'process.getBuiltinModule()' },
    ],
  )
})

test('DOCX format leaf depends only on approved pure leaves and JSZip', () => {
  const entry = fileURLToPath(new URL('../server/services/docxArtifactFormat.js', import.meta.url))
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

  const allowedExternalModules = new Set(['jszip'])
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
    'the format leaf may use JSZip but no host, storage, delivery, or native IO package',
  )
})

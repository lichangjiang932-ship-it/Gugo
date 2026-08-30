import assert from 'node:assert/strict'
import test from 'node:test'

import { PDFDocument, PDFName } from 'pdf-lib'

import {
  MAX_HTML_ARTIFACT_BYTES,
  resolveHtmlArtifactSource,
  validateHtmlArtifactSource,
} from '../server/services/htmlArtifactFormat.js'
import {
  buildPdfArtifactBuffer,
  normalizePdfArtifactInput,
} from '../server/services/pdfArtifactFormat.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQz38NQQxwFgBTqAjXImzcIAAAAABJRU5ErkJggg==',
  'base64',
)

test('HTML format leaf resolves fenced multi-file input before validation', () => {
  const source = resolveHtmlArtifactSource({
    files: {
      'index.html': '```html\n<!doctype html><html><head></head><body><main><h1>Local page</h1></main></body></html>\n```',
      'styles.css': 'body { color: #123456; }',
      'app.js': 'document.body.dataset.ready = "1";',
    },
  })

  assert.match(source, /<style>\s*body \{ color: #123456; \}\s*<\/style>/)
  assert.match(source, /<script>\s*document\.body\.dataset\.ready = "1";\s*<\/script>/)
  assert.equal(validateHtmlArtifactSource(source), source)
  assert.equal(MAX_HTML_ARTIFACT_BYTES, 2 * 1024 * 1024)
})

test('PDF format leaf snapshots normalized content and returns a real PDF buffer', async () => {
  const blocks = [{ type: 'heading', text: '  Original heading  ' }]
  const input = normalizePdfArtifactInput({ title: '  Report  ', blocks })
  blocks[0].type = 'paragraph'
  blocks[0].text = 'Mutated heading'

  assert.deepEqual(input, {
    normalizedTitle: 'Report',
    contentBlocks: [{ type: 'heading', text: 'Original heading' }],
  })

  const result = await buildPdfArtifactBuffer(input)
  assert.equal(result.buffer.subarray(0, 5).toString(), '%PDF-')
  assert.equal(result.pageCount, 1)
  const document = await PDFDocument.load(result.buffer, { updateMetadata: false })
  assert.equal(document.getTitle(), 'Report')
})

test('PDF format leaf validates and snapshots prepared image bytes', async () => {
  const mutable = Buffer.from(PNG_BYTES)
  const pending = buildPdfArtifactBuffer({
    normalizedTitle: 'Image report',
    preparedImages: [{
      buffer: mutable,
      extension: 'png',
      mimeType: 'image/png',
      pixelWidth: 3,
      pixelHeight: 2,
    }],
  })
  mutable.fill(0)

  const result = await pending
  const document = await PDFDocument.load(result.buffer, { updateMetadata: false })
  const xObjects = document.getPage(0).node.Resources().lookup(PDFName.of('XObject'))
  assert.equal(result.pageCount, 1)
  assert.ok(xObjects)

  await assert.rejects(
    () => buildPdfArtifactBuffer({ contentBlocks: [], preparedImages: 'not-an-array' }),
    /preparedImages must be an array/,
  )
  await assert.rejects(
    () => buildPdfArtifactBuffer({
      contentBlocks: [],
      preparedImages: [{ buffer: 'not-bytes', extension: 'png', pixelWidth: 3, pixelHeight: 2 }],
    }),
    /buffer must be a non-empty Buffer/,
  )
})

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import sharp from 'sharp'
import { JSDOM } from 'jsdom'
import { PPTX_PREVIEW_BYTE_LIMITS, readPptxZipPart, readPptxXmlText } from '../src/lib/pptxPreviewArchive.js'
import { PPTX_PREVIEW_IMAGE_LIMITS, inspectPptxRasterImage } from '../src/lib/pptxPreviewRaster.js'
import { createPptxXmlReader } from '../src/lib/pptxPreviewXml.js'
import { readPptxFilePreview } from '../src/lib/pptxFilePreview.js'
import { parsePptxPreview } from '../src/lib/directFilePreview.js'

const dom = new JSDOM('')
after(() => dom.window.close())
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438DwHwAGgAJ/EEwb4QAAAABJRU5ErkJggg=='

async function tinyImage(format, options = {}) {
  // Only these genuine 2x3 fixtures are encoded. Malicious dimensions below
  // are headers only and are NEVER submitted to an image decoder or browser.
  return sharp({ create: { width: 2, height: 3, channels: 3, background: { r: 255, g: 128, b: 0 } } })[format](options).toBuffer()
}

async function forgedSizeZip(name, payload) {
  const source = new JSZip()
  source.file(name, payload, { createFolders: false })
  const buffer = await source.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const central = buffer.indexOf(Buffer.from([80, 75, 1, 2]))
  assert.ok(central >= 0)
  const local = buffer.readUInt32LE(central + 42)
  buffer.writeUInt32LE(1, central + 24)
  buffer.writeUInt32LE(1, local + 22)
  return { buffer, zip: await JSZip.loadAsync(buffer) }
}

function boundedEntry(chunks, declared = 0) {
  const handlers = new Map()
  const state = { pauses: 0, emitted: 0, asyncCalls: 0 }
  const stream = {
    on(name, callback) { handlers.set(name, callback); return this },
    pause() { state.pauses += 1; return this },
    resume() {
      for (const chunk of chunks) {
        if (state.pauses) break
        state.emitted += 1
        handlers.get('data')(chunk)
      }
      if (!state.pauses) handlers.get('end')()
      return this
    },
  }
  return { state, _data: { uncompressedSize: declared },
    async() { state.asyncCalls += 1; throw new Error('whole-entry accumulation is forbidden') },
    internalStream(type) { assert.equal(type, 'uint8array'); return stream },
  }
}

test('bounded archive reads reject at the first oversized actual chunk and pause before retaining the rest', async () => {
  const entry = boundedEntry([new Uint8Array(700), new Uint8Array(700), new Uint8Array(700)], 1)
  const budget = { bytes: 0, limit: 8192 }
  await assert.rejects(readPptxZipPart(entry, { limit: 1024, budget, label: 'XML' }), /XML exceeds the preview limit/)
  assert.deepEqual(entry.state, { pauses: 1, emitted: 2, asyncCalls: 0 })
  assert.equal(budget.bytes, 1400)
})

test('XML and image total budgets charge actual chunks, not declared ZIP sizes or text character counts', async () => {
  const budget = { bytes: 0, limit: 10 }
  const first = boundedEntry([new Uint8Array(6)], 1)
  assert.equal((await readPptxZipPart(first, { limit: 8, budget, label: 'image' })).byteLength, 6)
  const second = boundedEntry([new Uint8Array(6)], 1)
  await assert.rejects(readPptxZipPart(second, { limit: 8, budget, label: 'image' }), /image exceeds/)
  assert.equal(second.state.pauses, 1)
  assert.equal(budget.bytes, 12)
  const unicode = boundedEntry([new TextEncoder().encode('\u4e16\u754c\u6587')], 1)
  await assert.rejects(readPptxXmlText(unicode, { bytes: 0, limit: 8 }), /XML exceeds/)
  assert.equal(unicode.state.asyncCalls, 0)
})

test('real DEFLATE with forged local and central uncompressed sizes cannot bypass actual-byte limits', async () => {
  const { zip } = await forgedSizeZip('payload.xml', Buffer.alloc(64 * 1024, 97))
  const entry = zip.file('payload.xml')
  assert.equal(entry._data.uncompressedSize, 1)
  entry.async = () => assert.fail('PPTX previews must not call the accumulating ZIP API')
  let pauses = 0
  const internalStream = entry.internalStream.bind(entry)
  entry.internalStream = (type) => {
    const stream = internalStream(type)
    const pause = stream.pause.bind(stream)
    stream.pause = () => { pauses += 1; return pause() }
    return stream
  }
  await assert.rejects(readPptxZipPart(entry, { limit: 1024, budget: { bytes: 0, limit: 2048 }, label: 'XML' }), /XML exceeds the preview limit/)
  assert.equal(pauses, 1)
})

test('the real XML reader and no-DOM outline path enforce the same 8MiB inflate cap before XML parsing', async () => {
  const name = 'ppt/slides/slide1.xml'
  const { zip, buffer } = await forgedSizeZip(name, Buffer.alloc(PPTX_PREVIEW_BYTE_LIMITS.xmlPart + 1024, 97))
  let parses = 0
  class ForbiddenParser { constructor() { parses += 1 } }
  const reader = createPptxXmlReader(zip, ForbiddenParser)
  await assert.rejects(reader(name), /XML exceeds the preview limit/)
  assert.equal(parses, 0)
  await assert.rejects(parsePptxPreview(buffer), /XML exceeds the preview limit/)
})

test('complete tiny PNG, baseline/progressive JPEG, single-frame GIF, and lossy/lossless WebP remain accepted', async () => {
  for (const [format, options] of [['png', {}], ['jpeg', {}], ['jpeg', { progressive: true }], ['gif', {}], ['webp', {}], ['webp', { lossless: true }]]) {
    const bytes = await tinyImage(format, options)
    const budget = { pixels: 0 }
    const image = inspectPptxRasterImage(bytes, budget)
    assert.equal(image.mime, `image/${format}`)
    assert.deepEqual([image.width, image.height, image.pixels, budget.pixels], [2, 3, 6, 6])
  }
})

function hugeHeaders() {
  const png = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12)
  png.writeUInt32BE(1048576, 16)
  png.writeUInt32BE(1048576, 20)
  png[24] = 8
  png[25] = 6
  const gif = Buffer.alloc(14)
  gif.write('GIF89a')
  gif.writeUInt16LE(65535, 6)
  gif.writeUInt16LE(65535, 8)
  gif[13] = 0x3b
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 255, 255, 255, 255, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217])
  const webp = Buffer.alloc(30)
  webp.write('RIFF')
  webp.writeUInt32LE(22, 4)
  webp.write('WEBPVP8X', 8)
  webp.writeUInt32LE(10, 16)
  webp.fill(255, 24, 30)
  return [png, gif, jpeg, webp]
}

test('the four tiny giant-dimension header probes are rejected without invoking any image decoder', () => {
  for (const bytes of hugeHeaders()) {
    assert.ok(bytes.length <= 33)
    assert.throws(() => inspectPptxRasterImage(bytes), /dimensions exceed/)
  }
})

test('truncated, header-only, corrupt PNG CRC, and unsupported/active image formats are rejected', async () => {
  for (const format of ['png', 'jpeg', 'gif', 'webp']) {
    const bytes = await tinyImage(format)
    assert.throws(() => inspectPptxRasterImage(bytes.subarray(0, bytes.length - 1)), /PPTX raster image/)
    assert.throws(() => inspectPptxRasterImage(bytes.subarray(0, 12)), /PPTX raster image/)
  }
  const corruptPng = Buffer.from(pixel, 'base64')
  corruptPng[45] ^= 1
  assert.throws(() => inspectPptxRasterImage(corruptPng), /PPTX raster image/)
  assert.throws(() => inspectPptxRasterImage(new TextEncoder().encode('<svg onload="alert(1)"/>')), /PPTX raster image/)
})

test('both maximum image edge and decoded pixel area are checked before accepting PNG image data', () => {
  for (const [width, height] of [[8193, 1], [4096, 4096]]) {
    const bytes = Buffer.from(pixel, 'base64')
    bytes.writeUInt32BE(width, 16)
    bytes.writeUInt32BE(height, 20)
    assert.throws(() => inspectPptxRasterImage(bytes), /dimensions exceed/)
  }
})

test('deck-wide decoded-pixel budget is enforced before data URLs can be constructed', async () => {
  const bytes = await tinyImage('png')
  const budget = { pixels: PPTX_PREVIEW_IMAGE_LIMITS.totalPixels - 6 }
  inspectPptxRasterImage(bytes, budget)
  assert.equal(budget.pixels, PPTX_PREVIEW_IMAGE_LIMITS.totalPixels)
  assert.throws(() => inspectPptxRasterImage(bytes, budget), /total image pixels exceed/)
  assert.equal(budget.pixels, PPTX_PREVIEW_IMAGE_LIMITS.totalPixels)
})

test('WebP extended canvas cannot hide oversized or mismatching dimensions in the actual image frame', async () => {
  const source = await tinyImage('webp', { lossless: true })
  const imageChunk = source.subarray(12)
  const prefix = Buffer.alloc(30)
  prefix.write('RIFF')
  prefix.writeUInt32LE(22 + imageChunk.length, 4)
  prefix.write('WEBPVP8X', 8)
  prefix.writeUInt32LE(10, 16)
  const mismatched = Buffer.concat([prefix, imageChunk])
  assert.throws(() => inspectPptxRasterImage(mismatched), /PPTX raster image/)
  prefix[24] = 1
  prefix[27] = 2
  const hugeFrame = Buffer.concat([prefix, imageChunk])
  // VP8L's own dimensions, not VP8X's 2x3 canvas, declare 16384x16384.
  hugeFrame.writeUInt32LE(0x0fffffff, 39)
  assert.throws(() => inspectPptxRasterImage(hugeFrame), /dimensions exceed/)
})

test('bad embedded images downgrade only their slide and never create a data URI', async () => {
  const pptx = new PptxGenJS()
  const first = pptx.addSlide()
  first.addText('Unsafe image fallback', { x: 1, y: 1, w: 6, h: 1 })
  first.addImage({ data: `image/png;base64,${pixel}`, x: 1, y: 2, w: 1, h: 1 })
  pptx.addSlide().addText('Still previewable', { x: 1, y: 1, w: 6, h: 1 })
  const source = await pptx.write({ outputType: 'nodebuffer' })
  const originalBtoa = globalThis.btoa
  let conversions = 0
  globalThis.btoa = (...args) => { conversions += 1; return originalBtoa(...args) }
  try {
    for (const unsafe of [...hugeHeaders(), Buffer.from(pixel, 'base64').subarray(0, 33)]) {
      const zip = await JSZip.loadAsync(source)
      const media = Object.values(zip.files).find((entry) => entry.name.startsWith('ppt/media/') && !entry.dir)
      zip.file(media.name, unsafe)
      const result = await readPptxFilePreview(zip, { Parser: dom.window.DOMParser })
      assert.equal(result.slides[0].layout, null)
      assert.ok(result.slides[1].layout)
      assert.doesNotMatch(JSON.stringify(result), /data:image/)
    }
    assert.equal(conversions, 0)
  } finally { globalThis.btoa = originalBtoa }
})

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import JSZip from 'jszip'
import sharp from 'sharp'

import { buildPptxArtifactBuffer } from '../server/services/pptxArtifactFormat.js'
import { validateGeneratedArtifactOffice } from '../server/services/generatedArtifactOfficeValidation.js'
import { crc32 } from '../server/services/generatedArtifactImageValidation.js'

const ACTIVE_CONTENT_ERROR = 'ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN'
const MIB = 1024 * 1024
const PRESENTATION_RELS = 'ppt/_rels/presentation.xml.rels'
const SLIDE_RELS = 'ppt/slides/_rels/slide1.xml.rels'
const ROOT_RELS = '_rels/.rels'
const PRINTER_PART = 'ppt/printerSettings/printerSettings1.bin'
const PRINTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.printerSettings'
const PRINTER_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings'
const THUMBNAIL_RELATIONSHIP = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail'

// The fixtures are generated entirely in memory. No application database,
// user-authored presentation/script, filesystem output or network is involved.
const { buffer: basePptx } = await buildPptxArtifactBuffer({
  title: 'Passive metadata fixture',
  generatedAt: '2026-01-01T00:00:00.000Z',
  slides: [{ title: 'Fixture slide', layout: 'bullets', bullets: ['Safe fixture content'] }],
})
const png = await sharp({
  create: { width: 3, height: 2, channels: 4, background: '#3178c6' },
}).png().toBuffer()
const jpeg = await sharp({
  create: { width: 3, height: 2, channels: 3, background: '#3178c6' },
}).jpeg().toBuffer()

function opaquePrinterBytes(size = 9_395) {
  const bytes = Buffer.alloc(size)
  // Printer settings are OS/driver-specific, not necessarily Windows DEVMODE.
  Buffer.from('0200000001000000', 'hex').copy(bytes)
  return bytes
}

function xmlAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

async function appendXml(zip, name, closingTag, element) {
  const entry = zip.file(name)
  assert.ok(entry, `fixture requires ${name}`)
  const source = await entry.async('string')
  assert.ok(source.includes(closingTag), `fixture requires ${closingTag}`)
  zip.file(name, source.replace(closingTag, `${element}${closingTag}`))
}

function sourceDirectory(relsName) {
  if (relsName === ROOT_RELS) return ''
  return path.posix.dirname(relsName.replace('/_rels/', '/').replace(/\.rels$/, ''))
}

async function addRelationship(zip, {
  relsName, id, type, partName, target = null, targetMode = '',
}) {
  const relativeTarget = target ?? path.posix.relative(sourceDirectory(relsName), partName)
  const mode = targetMode ? ` TargetMode="${xmlAttribute(targetMode)}"` : ''
  await appendXml(zip, relsName, '</Relationships>',
    `<Relationship Id="${xmlAttribute(id)}" Type="${xmlAttribute(type)}" Target="${xmlAttribute(relativeTarget)}"${mode}/>`)
}

async function addPassivePart(zip, {
  partName, bytes, contentType, relsName, relationshipType,
  relationCount = 1, target = null, targetMode = '',
}) {
  zip.file(partName, Buffer.from(bytes))
  await appendXml(zip, '[Content_Types].xml', '</Types>',
    `<Override PartName="/${xmlAttribute(partName)}" ContentType="${xmlAttribute(contentType)}"/>`)
  const id = `rIdPassive${partName.replace(/[^a-z0-9]/gi, '')}`
  for (let index = 0; index < relationCount; index += 1) {
    await addRelationship(zip, {
      relsName, id: `${id}${index}`, type: relationshipType, partName, target, targetMode,
    })
  }
}

function addPrinter(zip, options = {}) {
  return addPassivePart(zip, {
    partName: PRINTER_PART,
    bytes: opaquePrinterBytes(),
    contentType: PRINTER_CONTENT_TYPE,
    relsName: PRESENTATION_RELS,
    relationshipType: PRINTER_RELATIONSHIP,
    ...options,
  })
}

function addThumbnail(zip, options = {}) {
  return addPassivePart(zip, {
    partName: 'docProps/thumbnail.png',
    bytes: png,
    contentType: 'image/png',
    relsName: ROOT_RELS,
    relationshipType: THUMBNAIL_RELATIONSHIP,
    ...options,
  })
}

async function pptxWith(mutate) {
  const zip = await JSZip.loadAsync(basePptx)
  await mutate(zip)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function expectActiveRejection(mutate) {
  await assert.rejects(validateGeneratedArtifactOffice(await pptxWith(mutate), 'pptx'), {
    code: ACTIVE_CONTENT_ERROR,
  })
}

function pngChunk(type, bytes) {
  const chunk = Buffer.alloc(bytes.length + 12)
  chunk.writeUInt32BE(bytes.length, 0)
  chunk.write(type, 4, 'ascii')
  bytes.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}

function pngAtByteLimit(byteLength) {
  // A private ancillary chunk pads a still-valid PNG, rather than appending
  // invalid trailing bytes that would confuse the size-boundary assertion.
  const padding = pngChunk('teSt', Buffer.alloc(byteLength - png.length - 12))
  return Buffer.concat([png.subarray(0, -12), padding, png.subarray(-12)])
}

function pngWithUndecodablePixels() {
  const chunks = [png.subarray(0, 8)]
  let inserted = false
  for (let offset = 8; offset < png.length;) {
    const end = offset + 12 + png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    if (type !== 'IDAT') chunks.push(png.subarray(offset, end))
    else if (!inserted) {
      // Valid PNG chunk CRC and zlib stream, but too few scanline bytes for
      // the declared image: metadata-only inspection must not accept this.
      chunks.push(pngChunk('IDAT', deflateSync(Buffer.from([0]))))
      inserted = true
    }
    offset = end
  }
  assert.equal(inserted, true)
  return Buffer.concat(chunks)
}

test('the passive-metadata baseline is a valid standard in-memory PPTX', async () => {
  const result = await validateGeneratedArtifactOffice(basePptx, 'pptx')
  assert.ok(result.entryCount > 0)
})

test('PPTX accepts a uniquely bound Mac-like opaque printer-settings part', async () => {
  const bytes = await pptxWith((zip) => addPrinter(zip))
  const result = await validateGeneratedArtifactOffice(bytes, 'pptx')
  assert.ok(result.entryCount > 0)
})

test('PPTX accepts the exact OOXML Strict printer-settings relationship', async () => {
  const bytes = await pptxWith((zip) => addPrinter(zip, {
    relationshipType: 'http://purl.oclc.org/ooxml/officeDocument/relationships/printerSettings',
  }))
  await validateGeneratedArtifactOffice(bytes, 'pptx')
})

test('PPTX printer settings use bounded opaque bytes, not a DEVMODE or whole-payload magic heuristic', async () => {
  const printer = opaquePrinterBytes(MIB)
  Buffer.from('MZ').copy(printer, 64)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(printer, 128)
  const bytes = await pptxWith((zip) => addPrinter(zip, {
    partName: 'ppt/printerSettings/printerSettings27.bin', bytes: printer,
  }))
  await validateGeneratedArtifactOffice(bytes, 'pptx')
})

for (const [extension, bytes, contentType] of [
  ['png', png, 'image/png'], ['jpg', jpeg, 'image/jpeg'], ['jpeg', jpeg, 'image/jpeg'],
]) {
  test(`PPTX accepts a real root-bound ${extension} thumbnail with an opaque printer part`, async () => {
    const buffer = await pptxWith(async (zip) => {
      await addPrinter(zip)
      await addThumbnail(zip, { partName: `docProps/thumbnail.${extension}`, bytes, contentType })
    })
    await validateGeneratedArtifactOffice(buffer, 'pptx')
  })
}

test('PPTX accepts a structurally valid thumbnail exactly at the 4 MiB byte limit', async () => {
  const thumbnail = pngAtByteLimit(4 * MIB)
  assert.equal(thumbnail.length, 4 * MIB)
  const buffer = await pptxWith((zip) => addThumbnail(zip, { bytes: thumbnail }))
  await validateGeneratedArtifactOffice(buffer, 'pptx')
})

test('PPTX accepts a thumbnail exactly at the 4096-pixel edge limit', async () => {
  const bytes = await sharp({
    create: { width: 4096, height: 1, channels: 3, background: '#3178c6' },
  }).png().toBuffer()
  await validateGeneratedArtifactOffice(await pptxWith((zip) => addThumbnail(zip, { bytes })), 'pptx')
})

for (const dimensions of [{ width: 4097, height: 1 }, { width: 1, height: 4097 }]) {
  test(`PPTX rejects a ${dimensions.width}x${dimensions.height} thumbnail beyond the 4096-pixel edge limit`, async () => {
    const bytes = await sharp({ create: { ...dimensions, channels: 3, background: '#3178c6' } }).png().toBuffer()
    await expectActiveRejection((zip) => addThumbnail(zip, { bytes }))
  })
}

for (const [label, options] of [
  ['arbitrary bin name', { partName: 'ppt/printerSettings/opaque.bin' }],
  ['zero index', { partName: 'ppt/printerSettings/printerSettings0.bin' }],
  ['zero-padded index', { partName: 'ppt/printerSettings/printerSettings01.bin' }],
  ['wrong directory', { partName: 'ppt/media/printerSettings1.bin' }],
  ['wrong content type', { contentType: 'application/xml' }],
  ['wrong package-level source', { relsName: ROOT_RELS }],
  ['wrong slide source', { relsName: SLIDE_RELS }],
  ['wrong relationship kind', { relationshipType: PRINTER_RELATIONSHIP.replace(/printerSettings$/, 'image') }],
  ['unknown relationship namespace', { relationshipType: 'https://attacker.invalid/officeDocument/relationships/printerSettings' }],
  ['unreferenced part', { relationCount: 0 }],
  ['multiply referenced part', { relationCount: 2 }],
  ['external relationship', { target: 'https://fixture.invalid/printer.bin', targetMode: 'External' }],
  ['empty payload', { bytes: Buffer.alloc(0) }],
  ['payload over 1 MiB', { bytes: opaquePrinterBytes(MIB + 1) }],
]) {
  test(`PPTX printer settings reject ${label}`, async () => {
    await expectActiveRejection((zip) => addPrinter(zip, options))
  })
}

test('PPTX rejects multiple otherwise valid printer-settings parts', async () => {
  await expectActiveRejection(async (zip) => {
    await addPrinter(zip)
    await addPrinter(zip, { partName: 'ppt/printerSettings/printerSettings2.bin' })
  })
})

test('PPTX printer content types cannot label an otherwise allowed non-printer part', async () => {
  await expectActiveRejection((zip) => addPassivePart(zip, {
    partName: 'ppt/media/image900.png',
    bytes: png,
    contentType: PRINTER_CONTENT_TYPE,
    relsName: SLIDE_RELS,
    relationshipType: PRINTER_RELATIONSHIP.replace(/printerSettings$/, 'image'),
  }))
})

for (const [label, magic] of [
  ['DOS/PE', '4d5a'], ['OLE compound file', 'd0cf11e0a1b11ae1'],
  ['ZIP local header', '504b0304'], ['ZIP empty archive', '504b0506'], ['ELF', '7f454c46'],
]) {
  test(`PPTX printer settings reject a ${label} container disguised as passive bytes`, async () => {
    const bytes = Buffer.concat([Buffer.from(magic, 'hex'), Buffer.alloc(128)])
    await expectActiveRejection((zip) => addPrinter(zip, { bytes }))
  })
}

for (const [label, options] of [
  ['non-thumbnail filename', { partName: 'docProps/preview.png' }],
  ['wrong part location', { partName: 'ppt/media/thumbnail.png' }],
  ['PNG declared as JPEG', { contentType: 'image/jpeg' }],
  ['JPEG declared as PNG', { partName: 'docProps/thumbnail.jpeg', bytes: jpeg, contentType: 'image/png' }],
  ['wrong presentation-level source', { relsName: PRESENTATION_RELS }],
  ['wrong slide source', { relsName: SLIDE_RELS }],
  ['wrong relationship kind', { relationshipType: PRINTER_RELATIONSHIP.replace(/printerSettings$/, 'image') }],
  ['officeDocument thumbnail masquerading as package metadata', { relationshipType: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/thumbnail' }],
  ['unreferenced part', { relationCount: 0 }],
  ['multiply referenced part', { relationCount: 2 }],
  ['external relationship', { target: 'https://fixture.invalid/thumbnail.png', targetMode: 'External' }],
  ['empty image', { bytes: Buffer.alloc(0) }],
  ['image over 4 MiB', { bytes: pngAtByteLimit(4 * MIB + 1) }],
]) {
  test(`PPTX thumbnails reject ${label}`, async () => {
    await expectActiveRejection((zip) => addThumbnail(zip, options))
  })
}

test('PPTX rejects multiple otherwise valid package thumbnails', async () => {
  await expectActiveRejection(async (zip) => {
    await addThumbnail(zip)
    await addThumbnail(zip, { partName: 'docProps/thumbnail.jpeg', bytes: jpeg, contentType: 'image/jpeg' })
  })
})

for (const [label, options] of [
  ['non-image bytes', { bytes: Buffer.from('not an image') }],
  ['valid PNG CRC but undecodable pixels', { bytes: pngWithUndecodablePixels() }],
  ['truncated JPEG', { partName: 'docProps/thumbnail.jpeg', contentType: 'image/jpeg', bytes: jpeg.subarray(0, 30) }],
  ['actual image format mismatch', { partName: 'docProps/thumbnail.jpeg', contentType: 'image/jpeg', bytes: png }],
]) {
  test(`PPTX thumbnail decoding rejects ${label}`, async () => {
    await assert.rejects(validateGeneratedArtifactOffice(await pptxWith((zip) => addThumbnail(zip, options)), 'pptx'),
      (error) => /^ARTIFACT_FORMAT_IMAGE_/u.test(String(error?.code || '')))
  })
}

test('passive metadata does not relax slide structure validation even when ZIP CRC passes', async () => {
  const bytes = await pptxWith(async (zip) => {
    await addPrinter(zip)
    await addThumbnail(zip)
    zip.remove('ppt/slides/slide1.xml')
  })
  await JSZip.loadAsync(bytes, { checkCRC32: true })
  await assert.rejects(validateGeneratedArtifactOffice(bytes, 'pptx'), { code: 'ARTIFACT_FORMAT_STRUCTURE_INVALID' })
})

for (const partName of ['ppt/vbaProject.bin', 'ppt/activeX/activeX1.xml', 'ppt/embeddings/oleObject1.bin']) {
  test(`passive metadata support still forbids ${partName}`, async () => {
    await expectActiveRejection(async (zip) => {
      await addPrinter(zip)
      await addThumbnail(zip)
      zip.file(partName, Buffer.from('forbidden fixture part'))
    })
  })
}

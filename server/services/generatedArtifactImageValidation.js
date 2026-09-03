import zlib from 'node:zlib'
import sharp from 'sharp'

import {
  GeneratedArtifactFormatError,
  invalid,
} from './generatedArtifactFormatValidationError.js'

const MAX_ZIP_EXPANDED_BYTES = 512 * 1024 * 1024
const MAX_IMAGE_PIXELS = 100_000_000

let crcTable = null
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let value = 0; value < 256; value += 1) {
      let crc = value
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
      crcTable[value] = crc >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function validatePng(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The PNG signature is invalid.')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = 0
  let interlace = -1
  let sawHeader = false
  let sawEnd = false
  const imageData = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The PNG contains a truncated chunk.')
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const payload = bytes.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      invalid('ARTIFACT_FORMAT_IMAGE_INVALID', `PNG chunk ${type} failed its CRC check.`)
    }
    if (!sawHeader && type !== 'IHDR') invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'PNG IHDR is not the first chunk.')
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The PNG IHDR chunk is invalid.')
      sawHeader = true
      width = payload.readUInt32BE(0)
      height = payload.readUInt32BE(4)
      bitDepth = payload[8]
      colorType = payload[9]
      interlace = payload[12]
    } else if (type === 'IDAT') imageData.push(payload)
    else if (type === 'IEND') {
      if (length !== 0) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The PNG IEND chunk is invalid.')
      sawEnd = true
      offset = end
      break
    }
    offset = end
  }
  if (!sawHeader || !sawEnd || imageData.length === 0 || offset !== bytes.length
    || width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS
    || ![0, 2, 3, 4, 6].includes(colorType) || ![1, 2, 4, 8, 16].includes(bitDepth)
    || ![0, 1].includes(interlace)) {
    invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The PNG structure or dimensions are invalid.')
  }
  try {
    const expanded = zlib.inflateSync(Buffer.concat(imageData), { maxOutputLength: MAX_ZIP_EXPANDED_BYTES })
    if (expanded.length === 0) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The PNG image data is empty.')
  } catch (cause) {
    if (cause instanceof GeneratedArtifactFormatError) throw cause
    invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The PNG image data cannot be decompressed.', cause)
  }
  return { width, height }
}

function validateJpeg(bytes) {
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The JPEG signature is invalid.')
  let offset = 2
  let width = 0
  let height = 0
  let sawScan = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The JPEG marker stream is invalid.')
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    offset += 1
    if (marker === 0xd9) {
      if (!sawScan || !width || !height || offset !== bytes.length) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The JPEG image is incomplete.')
      return { width, height }
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    if (offset + 2 > bytes.length) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The JPEG segment is truncated.')
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The JPEG segment length is invalid.')
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The JPEG frame header is invalid.')
      height = bytes.readUInt16BE(offset + 3)
      width = bytes.readUInt16BE(offset + 5)
      if (!width || !height || width * height > MAX_IMAGE_PIXELS) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The JPEG dimensions are invalid.')
    }
    offset += length
    if (marker !== 0xda) continue
    sawScan = true
    while (offset < bytes.length - 1) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      let next = offset + 1
      while (bytes[next] === 0xff) next += 1
      if (bytes[next] === 0x00 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) {
        offset = next + 1
        continue
      }
      break
    }
  }
  invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The JPEG end marker is missing.')
}

function validateWebp(bytes) {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The WebP RIFF container is invalid.')
  }
  let offset = 12
  let width = 0
  let height = 0
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + length
    if (end > bytes.length) invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The WebP contains a truncated chunk.')
    if (type === 'VP8X' && length >= 10) {
      width = 1 + bytes.readUIntLE(start + 4, 3)
      height = 1 + bytes.readUIntLE(start + 7, 3)
    } else if (type === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
      const bits = bytes.readUInt32LE(start + 1)
      width = 1 + (bits & 0x3fff)
      height = 1 + ((bits >>> 14) & 0x3fff)
    } else if (type === 'VP8 ' && length >= 10
      && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      width = bytes.readUInt16LE(start + 6) & 0x3fff
      height = bytes.readUInt16LE(start + 8) & 0x3fff
    }
    offset = end + (length % 2)
  }
  if (offset !== bytes.length || !width || !height || width * height > MAX_IMAGE_PIXELS) {
    invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The WebP bitstream or dimensions are invalid.')
  }
  return { width, height }
}

export async function validateGeneratedArtifactImage(bytes, extension) {
  const expectedFormat = extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension
  const structure = extension === 'png' ? validatePng(bytes)
    : extension === 'jpg' || extension === 'jpeg' ? validateJpeg(bytes)
      : extension === 'webp' ? validateWebp(bytes)
        : invalid('ARTIFACT_FORMAT_UNSUPPORTED', 'Only generated PNG, JPEG, and WebP images are supported.')
  try {
    const options = {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    }
    const metadata = await sharp(bytes, options).metadata()
    const width = Number(metadata.width)
    const height = Number(metadata.pageHeight || metadata.height)
    const pages = Number(metadata.pages || 1)
    if (metadata.format !== expectedFormat || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || !Number.isSafeInteger(pages) || width <= 0 || height <= 0 || pages <= 0
      || width * height * pages > MAX_IMAGE_PIXELS) {
      invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The image codec, dimensions, or page count is invalid.')
    }
    const decoded = await sharp(bytes, options).raw().toBuffer({ resolveWithObject: true })
    if (!decoded?.data?.length || decoded.info?.width <= 0 || decoded.info?.height <= 0) {
      invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The image contains no decodable pixels.')
    }
    return { width, height, pages, decodedBytes: decoded.data.length, ...structure }
  } catch (cause) {
    if (cause instanceof GeneratedArtifactFormatError) throw cause
    invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'The image pixels cannot be decoded.', cause)
  }
}

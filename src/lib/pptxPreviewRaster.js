// Inspect containers, not pixels. Nothing reaches <image> until its static
// frame dimensions and the deck's decoded-pixel budget have been checked.
export const PPTX_PREVIEW_IMAGE_LIMITS = Object.freeze({ edge: 8192, pixels: 16000000, totalPixels: 48000000 })
const MAX_PARTS = 4096

function invalidImage() { throw new Error('Unsupported or incomplete PPTX raster image') }
function ascii(bytes, offset, length) { return String.fromCharCode(...bytes.subarray(offset, offset + length)) }
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > PPTX_PREVIEW_IMAGE_LIMITS.edge || height > PPTX_PREVIEW_IMAGE_LIMITS.edge
    || width * height > PPTX_PREVIEW_IMAGE_LIMITS.pixels) throw new Error('PPTX image dimensions exceed the preview limit')
  return { width, height, pixels: width * height }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes, start, end) {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngHeader(bytes, offset) {
  const data = view(bytes)
  const result = dimensions(data.getUint32(offset), data.getUint32(offset + 4))
  const depth = bytes[offset + 8]
  const color = bytes[offset + 9]
  const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
  if (!validDepths[color]?.includes(depth) || bytes[offset + 10] !== 0 || bytes[offset + 11] !== 0
    || bytes[offset + 12] > 1) invalidImage()
  return { ...result, color }
}

function inspectPng(bytes) {
  const data = view(bytes)
  let header = null
  let imageBytes = 0
  let palette = false
  let imageEnded = false
  let offset = 8
  for (let count = 0; count < MAX_PARTS && offset + 12 <= bytes.length; count += 1) {
    const length = data.getUint32(offset)
    const type = ascii(bytes, offset + 4, 4)
    const body = offset + 8
    if (length > bytes.length - offset - 12 || !/^[a-z]{4}$/i.test(type)) invalidImage()
    if (offset === 8 && type !== 'IHDR') invalidImage()
    if (type === 'IHDR') {
      if (header || length !== 13) invalidImage()
      header = pngHeader(bytes, body)
    } else if (!header) invalidImage()
    // Animated frames and compressed auxiliary metadata have separate decode
    // costs; this bounded basic viewer deliberately does not pass them on.
    if (['acTL', 'fcTL', 'fdAT', 'iCCP', 'zTXt', 'iTXt'].includes(type)) invalidImage()
    if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) invalidImage()
    if (type === 'PLTE') {
      if (palette || imageBytes || length < 3 || length > 768 || length % 3) invalidImage()
      palette = true
    }
    if (type === 'IDAT') {
      if (imageEnded || (header.color === 3 && !palette)) invalidImage()
      imageBytes += length
    } else if (imageBytes) imageEnded = true
    if (crc32(bytes, offset + 4, body + length) !== data.getUint32(body + length)) invalidImage()
    offset += length + 12
    if (type === 'IEND') {
      if (length !== 0 || !imageBytes || offset !== bytes.length) invalidImage()
      return { mime: 'image/png', ...header }
    }
  }
  return invalidImage()
}

function skipGifBlocks(bytes, start) {
  let offset = start
  let length = 0
  for (let count = 0; count < MAX_PARTS && offset < bytes.length; count += 1) {
    const size = bytes[offset++]
    if (!size) return { offset, length }
    if (size > bytes.length - offset) invalidImage()
    offset += size
    length += size
  }
  return invalidImage()
}

function inspectGif(bytes) {
  if (bytes.length < 14) invalidImage()
  const data = view(bytes)
  const result = dimensions(data.getUint16(6, true), data.getUint16(8, true))
  const globalPalette = Boolean(bytes[10] & 128)
  let offset = 13 + (globalPalette ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0)
  let frames = 0
  for (let count = 0; count < MAX_PARTS && offset < bytes.length; count += 1) {
    const marker = bytes[offset++]
    if (marker === 0x3b) {
      if (frames !== 1 || offset !== bytes.length) invalidImage()
      return { mime: 'image/gif', ...result }
    }
    if (marker === 0x21) {
      const label = bytes[offset++]
      if (label === 0xf9) {
        if (offset + 6 > bytes.length || bytes[offset] !== 4 || bytes[offset + 5] !== 0) invalidImage()
        offset += 6
      } else if (label === 0xfe) offset = skipGifBlocks(bytes, offset).offset
      else invalidImage()
      continue
    }
    if (marker !== 0x2c || ++frames !== 1 || offset + 9 > bytes.length) invalidImage()
    const x = data.getUint16(offset, true)
    const y = data.getUint16(offset + 2, true)
    const frame = dimensions(data.getUint16(offset + 4, true), data.getUint16(offset + 6, true))
    const packed = bytes[offset + 8]
    if (x + frame.width > result.width || y + frame.height > result.height || (packed & 0x18)) invalidImage()
    const localPalette = Boolean(packed & 128)
    if (!globalPalette && !localPalette) invalidImage()
    offset += 9 + (localPalette ? 3 * 2 ** ((packed & 7) + 1) : 0)
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) invalidImage()
    const blocks = skipGifBlocks(bytes, offset + 1)
    if (!blocks.length) invalidImage()
    offset = blocks.offset
  }
  return invalidImage()
}

function jpegTable(bytes, start, end, huffman) {
  let offset = start
  while (offset < end) {
    const type = bytes[offset++]
    if ((type & 15) > 3 || type >> 4 > 1) invalidImage()
    if (!huffman) offset += (type >> 4 ? 2 : 1) * 64
    else {
      if (offset + 16 > end) invalidImage()
      let symbols = 0
      for (let index = 0; index < 16; index += 1) symbols += bytes[offset + index]
      if (symbols > 256 || symbols < 1) invalidImage()
      offset += 16 + symbols
    }
    if (offset > end) invalidImage()
  }
  if (offset === start) invalidImage()
}

function jpegFrame(bytes, start, length) {
  const data = view(bytes)
  if (length < 11 || bytes[start] !== 8) invalidImage()
  const result = dimensions(data.getUint16(start + 3), data.getUint16(start + 1))
  const components = bytes[start + 5]
  if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalidImage()
  const ids = new Set()
  for (let index = start + 6; index < start + length - 2; index += 3) {
    const sampling = bytes[index + 1]
    if (ids.has(bytes[index]) || (sampling >> 4) < 1 || (sampling >> 4) > 4
      || (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[index + 2] > 3) invalidImage()
    ids.add(bytes[index])
  }
  return { ...result, components }
}

function jpegScanEnd(bytes, start) {
  let offset = start
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 255) { offset += 1; continue }
    const next = bytes[offset + 1]
    if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue }
    if (next === 255) { offset += 1; continue }
    if (offset === start) invalidImage()
    return offset
  }
  return invalidImage()
}

function inspectJpeg(bytes) {
  const data = view(bytes)
  let frame = null
  let quantization = false
  let huffman = false
  let scans = 0
  let offset = 2
  for (let count = 0; count < MAX_PARTS && offset + 1 < bytes.length; count += 1) {
    if (bytes[offset++] !== 255) invalidImage()
    while (bytes[offset] === 255) offset += 1
    const marker = bytes[offset++]
    if (marker === 0xd9) {
      if (!frame || !scans || offset !== bytes.length) invalidImage()
      return { mime: 'image/jpeg', ...frame }
    }
    if (offset + 2 > bytes.length) invalidImage()
    const length = data.getUint16(offset)
    const body = offset + 2
    const end = offset + length
    if (length < 2 || end > bytes.length) invalidImage()
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || scans) invalidImage()
      frame = jpegFrame(bytes, body, length)
    } else if (marker === 0xdb || marker === 0xc4) {
      jpegTable(bytes, body, end, marker === 0xc4)
      if (marker === 0xdb) quantization = true
      else huffman = true
    } else if (marker === 0xda) {
      if (!frame || !quantization || !huffman || ++scans > 64 || bytes[body] < 1
        || bytes[body] > frame.components || length !== 6 + 2 * bytes[body]) invalidImage()
      offset = jpegScanEnd(bytes, end)
      continue
    } else if (marker === 0xdd) {
      if (length !== 4) invalidImage()
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) invalidImage()
    offset = end
  }
  return invalidImage()
}

function webpFrame(bytes, start, length, lossless) {
  const data = view(bytes)
  if (lossless) {
    if (length < 6 || bytes[start] !== 0x2f) invalidImage()
    const bits = data.getUint32(start + 1, true)
    if (bits >>> 29) invalidImage()
    return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (length < 11 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) invalidImage()
  const tag = bytes[start] | bytes[start + 1] << 8 | bytes[start + 2] << 16
  if ((tag & 1) || !(tag & 16) || ((tag >> 1) & 7) > 3 || (tag >>> 5) > length - 10 || !(tag >>> 5)) invalidImage()
  return dimensions(data.getUint16(start + 6, true) & 0x3fff, data.getUint16(start + 8, true) & 0x3fff)
}

function inspectWebp(bytes) {
  const data = view(bytes)
  if (bytes.length < 20 || data.getUint32(4, true) + 8 !== bytes.length) invalidImage()
  let canvas = null
  let frame = null
  let flags = 0
  let offset = 12
  const metadata = new Set()
  for (let count = 0; count < MAX_PARTS && offset + 8 <= bytes.length; count += 1) {
    const type = ascii(bytes, offset, 4)
    const length = data.getUint32(offset + 4, true)
    const body = offset + 8
    const end = body + length
    if (end + (length & 1) > bytes.length || ((length & 1) && bytes[end] !== 0)) invalidImage()
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || (bytes[body] & 0xc3) || bytes[body + 1] || bytes[body + 2] || bytes[body + 3]) invalidImage()
      flags = bytes[body]
      const width = bytes[body + 4] | bytes[body + 5] << 8 | bytes[body + 6] << 16
      const height = bytes[body + 7] | bytes[body + 8] << 8 | bytes[body + 9] << 16
      canvas = dimensions(width + 1, height + 1)
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (frame) invalidImage()
      frame = webpFrame(bytes, body, length, type === 'VP8L')
    } else if (['ICCP', 'EXIF', 'XMP '].includes(type)) {
      if (!canvas || metadata.has(type) || !length) invalidImage()
      metadata.add(type)
    } else invalidImage()
    offset = end + (length & 1)
  }
  if (offset !== bytes.length || !frame || (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))) invalidImage()
  for (const [name, flag] of [['ICCP', 32], ['EXIF', 8], ['XMP ', 4]]) {
    if (Boolean(flags & flag) !== metadata.has(name)) invalidImage()
  }
  return { mime: 'image/webp', ...frame }
}

export function inspectPptxRasterImage(bytes, budget = { pixels: 0 }) {
  let result
  if (bytes.length >= 8 && bytes[0] === 137 && ascii(bytes, 1, 3) === 'PNG'
    && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) result = inspectPng(bytes)
  else if (bytes[0] === 255 && bytes[1] === 216) result = inspectJpeg(bytes)
  else if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) result = inspectGif(bytes)
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') result = inspectWebp(bytes)
  else invalidImage()
  if (budget.pixels + result.pixels > PPTX_PREVIEW_IMAGE_LIMITS.totalPixels) throw new Error('PPTX total image pixels exceed the preview limit')
  budget.pixels += result.pixels
  return result
}

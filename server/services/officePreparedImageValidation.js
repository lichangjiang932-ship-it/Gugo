const MAX_OFFICE_IMAGES = 50
const MAX_OFFICE_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_OFFICE_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_OFFICE_IMAGE_PIXELS = 80_000_000
const MAX_OFFICE_IMAGE_TOTAL_PIXELS = 160_000_000
const MAX_OFFICE_IMAGE_SEGMENTS = 10_000
const OFFICE_IMAGE_EXTENSIONS = new Set(['jpg', 'png'])
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BIT_DEPTHS = Object.freeze({
  0: new Set([1, 2, 4, 8, 16]),
  2: new Set([8, 16]),
  3: new Set([1, 2, 4, 8]),
  4: new Set([8, 16]),
  6: new Set([8, 16]),
})

let pngCrcTable = null
function pngCrc32(bytes) {
  if (!pngCrcTable) {
    pngCrcTable = new Uint32Array(256)
    for (let value = 0; value < 256; value += 1) {
      let crc = value
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
      pngCrcTable[value] = crc >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ pngCrcTable[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function invalidPreparedImage(index, detail) {
  throw new Error(`preparedImages[${index}].buffer ${detail}`)
}

function inspectPng(buffer, index) {
  if (buffer.length < 45 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    invalidPreparedImage(index, 'does not contain a valid PNG signature')
  }
  let offset = PNG_SIGNATURE.length
  let segmentCount = 0
  let width = 0
  let height = 0
  let colorType = -1
  let sawHeader = false
  let sawPalette = false
  let sawImageData = false
  let imageDataEnded = false
  let imageDataBytes = 0
  let sawEnd = false
  while (offset + 12 <= buffer.length) {
    segmentCount += 1
    if (segmentCount > MAX_OFFICE_IMAGE_SEGMENTS) invalidPreparedImage(index, 'contains too many PNG chunks')
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > buffer.length) invalidPreparedImage(index, 'contains a truncated PNG chunk')
    const typeBytes = buffer.subarray(offset + 4, offset + 8)
    const type = typeBytes.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) invalidPreparedImage(index, 'contains an invalid PNG chunk type')
    const payload = buffer.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length)
    if (pngCrc32(buffer.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      invalidPreparedImage(index, `contains a PNG ${type} chunk with an invalid CRC`)
    }
    if (!sawHeader && type !== 'IHDR') invalidPreparedImage(index, 'does not start with a PNG IHDR chunk')
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) invalidPreparedImage(index, 'contains an invalid PNG IHDR chunk')
      sawHeader = true
      width = payload.readUInt32BE(0)
      height = payload.readUInt32BE(4)
      const bitDepth = payload[8]
      colorType = payload[9]
      const supportedDepths = PNG_BIT_DEPTHS[colorType]
      if (!width || !height || width * height > MAX_OFFICE_IMAGE_PIXELS
        || !supportedDepths?.has(bitDepth) || payload[10] !== 0 || payload[11] !== 0
        || ![0, 1].includes(payload[12])) {
        invalidPreparedImage(index, 'contains invalid PNG dimensions or encoding metadata')
      }
    } else if (type === 'PLTE') {
      if (sawPalette || sawImageData || [0, 4].includes(colorType)
        || length < 3 || length > 768 || length % 3 !== 0) {
        invalidPreparedImage(index, 'contains an invalid PNG palette')
      }
      sawPalette = true
    } else if (type === 'IDAT') {
      if (imageDataEnded) invalidPreparedImage(index, 'contains non-consecutive PNG image data')
      sawImageData = true
      imageDataBytes += length
    } else {
      if (sawImageData) imageDataEnded = true
      if (type === 'IEND') {
        if (length !== 0) invalidPreparedImage(index, 'contains an invalid PNG IEND chunk')
        sawEnd = true
        offset = end
        break
      }
      if ((typeBytes[0] & 0x20) === 0) invalidPreparedImage(index, `contains unsupported critical PNG chunk ${type}`)
    }
    offset = end
  }
  if (!sawHeader || !sawImageData || imageDataBytes === 0 || !sawEnd || offset !== buffer.length
    || (colorType === 3 && !sawPalette)) {
    invalidPreparedImage(index, 'does not contain a complete PNG image structure')
  }
  return { width, height }
}

function isJpegFrameMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
}

function inspectJpeg(buffer, index) {
  if (buffer.length < 12 || buffer.readUInt16BE(0) !== 0xffd8) {
    invalidPreparedImage(index, 'does not contain a valid JPEG signature')
  }
  let offset = 2
  let segmentCount = 0
  let width = 0
  let height = 0
  let sawFrame = false
  let sawScan = false
  let scanBytes = 0
  while (offset < buffer.length) {
    segmentCount += 1
    if (segmentCount > MAX_OFFICE_IMAGE_SEGMENTS) invalidPreparedImage(index, 'contains too many JPEG segments')
    if (buffer[offset] !== 0xff) invalidPreparedImage(index, 'contains an invalid JPEG marker stream')
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) invalidPreparedImage(index, 'contains a truncated JPEG marker')
    const marker = buffer[offset]
    offset += 1
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || scanBytes === 0 || offset !== buffer.length) {
        invalidPreparedImage(index, 'does not contain a complete JPEG image structure')
      }
      return { width, height }
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      invalidPreparedImage(index, 'contains an unexpected standalone JPEG marker')
    }
    if (offset + 2 > buffer.length) invalidPreparedImage(index, 'contains a truncated JPEG segment')
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) invalidPreparedImage(index, 'contains an invalid JPEG segment length')
    if (isJpegFrameMarker(marker)) {
      if (sawFrame || length < 8) invalidPreparedImage(index, 'contains an invalid JPEG frame header')
      const componentCount = buffer[offset + 7]
      if (componentCount <= 0 || length !== 8 + (3 * componentCount)) {
        invalidPreparedImage(index, 'contains an invalid JPEG frame component table')
      }
      height = buffer.readUInt16BE(offset + 3)
      width = buffer.readUInt16BE(offset + 5)
      if (!width || !height || width * height > MAX_OFFICE_IMAGE_PIXELS) {
        invalidPreparedImage(index, 'contains invalid JPEG dimensions')
      }
      sawFrame = true
    }
    if (marker === 0xda) {
      if (!sawFrame || length < 8) invalidPreparedImage(index, 'contains a JPEG scan before its frame header')
      const componentCount = buffer[offset + 2]
      if (componentCount <= 0 || length !== 6 + (2 * componentCount)) {
        invalidPreparedImage(index, 'contains an invalid JPEG scan header')
      }
    }
    offset += length
    if (marker !== 0xda) continue
    sawScan = true
    const scanStart = offset
    while (offset < buffer.length - 1) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      let next = offset + 1
      while (next < buffer.length && buffer[next] === 0xff) next += 1
      if (next >= buffer.length) break
      if (buffer[next] === 0x00 || (buffer[next] >= 0xd0 && buffer[next] <= 0xd7)) {
        offset = next + 1
        continue
      }
      break
    }
    scanBytes += offset - scanStart
    if (offset >= buffer.length - 1) invalidPreparedImage(index, 'does not contain a JPEG end marker')
  }
  invalidPreparedImage(index, 'does not contain a JPEG end marker')
}

function inspectPreparedImage(buffer, extension, index) {
  return extension === 'png' ? inspectPng(buffer, index) : inspectJpeg(buffer, index)
}
export function validatePreparedOfficeImages(preparedImages, {
  targetCount = null,
  targetKind = 'item',
} = {}) {
  if (!Array.isArray(preparedImages)) throw new TypeError('preparedImages must be an array')
  if (preparedImages.length > MAX_OFFICE_IMAGES) {
    throw new Error(`preparedImages cannot exceed ${MAX_OFFICE_IMAGES} entries`)
  }
  const normalizedTargetCount = targetCount == null ? null : Number(targetCount)
  if (normalizedTargetCount != null
    && (!Number.isSafeInteger(normalizedTargetCount) || normalizedTargetCount <= 0)) {
    throw new TypeError('targetCount must be a positive integer')
  }

  let totalBytes = 0
  let totalPixels = 0
  const validated = preparedImages.map((image, index) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      throw new TypeError(`preparedImages[${index}] must be an object`)
    }
    if (!Buffer.isBuffer(image.buffer) || image.buffer.length <= 0
      || image.buffer.length > MAX_OFFICE_IMAGE_BYTES) {
      throw new Error(
        `preparedImages[${index}].buffer must be a non-empty Buffer within the 25 MB limit`,
      )
    }
    totalBytes += image.buffer.length
    if (totalBytes > MAX_OFFICE_IMAGE_TOTAL_BYTES) {
      throw new Error('preparedImages exceed the 100 MB total limit')
    }

    const extension = String(image.extension || '').toLowerCase()
    if (!OFFICE_IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(`preparedImages[${index}].extension must be png or jpg`)
    }
    const pixelWidth = Number(image.pixelWidth)
    const pixelHeight = Number(image.pixelHeight)
    if (!Number.isSafeInteger(pixelWidth) || !Number.isSafeInteger(pixelHeight)
      || pixelWidth <= 0 || pixelHeight <= 0
      || pixelWidth * pixelHeight > MAX_OFFICE_IMAGE_PIXELS) {
      throw new Error(`preparedImages[${index}] has invalid pixel dimensions`)
    }
    totalPixels += pixelWidth * pixelHeight
    if (totalPixels > MAX_OFFICE_IMAGE_TOTAL_PIXELS) {
      throw new Error('preparedImages exceed the 160 million-pixel total limit')
    }
    const targetIndex = image.targetIndex == null ? null : Number(image.targetIndex)
    if (targetIndex != null && (!Number.isSafeInteger(targetIndex) || targetIndex <= 0)) {
      throw new Error(`preparedImages[${index}].targetIndex must be a positive integer`)
    }
    if (targetIndex != null && normalizedTargetCount != null && targetIndex > normalizedTargetCount) {
      throw new Error(
        `image target_index exceeds the ${normalizedTargetCount}-${String(targetKind || 'item')}`,
      )
    }
    return { image, extension, pixelWidth, pixelHeight, targetIndex }
  })

  return validated.map(({ image, extension, pixelWidth, pixelHeight, targetIndex }, index) => {
    const buffer = Buffer.from(image.buffer)
    const inspected = inspectPreparedImage(buffer, extension, index)
    if (pixelWidth !== inspected.width || pixelHeight !== inspected.height) {
      throw new Error(
        `preparedImages[${index}] declared pixel dimensions ${pixelWidth}x${pixelHeight}`
        + ` do not match the ${inspected.width}x${inspected.height} ${extension.toUpperCase()} image`,
      )
    }
    return Object.freeze({
      ...image,
      buffer,
      extension,
      pixelWidth,
      pixelHeight,
      targetIndex,
    })
  })
}

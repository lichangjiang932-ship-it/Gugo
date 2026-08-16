import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const MAX_OFFICE_IMAGES = 50
const MAX_OFFICE_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_OFFICE_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_OFFICE_IMAGE_PIXELS = 80_000_000
const SUPPORTED_RASTER_FORMATS = new Set(['avif', 'gif', 'heif', 'jpeg', 'jpg', 'png', 'tiff', 'webp'])

function finitePositive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function normalizedPlacement(entry = {}) {
  const targetIndex = Number(entry.target_index)
  return {
    alt: String(entry.alt || '').trim().slice(0, 500),
    targetIndex: Number.isInteger(targetIndex) && targetIndex > 0 ? targetIndex : null,
    anchor: String(entry.anchor || '').trim().toUpperCase().slice(0, 16),
    x: Number.isFinite(Number(entry.x)) && Number(entry.x) >= 0 ? Number(entry.x) : null,
    y: Number.isFinite(Number(entry.y)) && Number(entry.y) >= 0 ? Number(entry.y) : null,
    width: finitePositive(entry.width, null),
    height: finitePositive(entry.height, null),
  }
}

/**
 * Convert already-authorized local raster inputs into stable Office-compatible
 * bytes. Raw model paths are intentionally rejected here: callers must first
 * resolve them through resolveForFileTool and pass sourcePath.
 */
export async function prepareOfficeArtifactImages(images = []) {
  if (!Array.isArray(images)) throw new Error('images must be an array')
  if (images.length > MAX_OFFICE_IMAGES) throw new Error(`images cannot exceed ${MAX_OFFICE_IMAGES} entries`)

  let totalInputBytes = 0
  const prepared = []
  for (let index = 0; index < images.length; index += 1) {
    const entry = images[index] || {}
    const sourcePath = String(entry.sourcePath || '').trim()
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      throw new Error(`images[${index}].path was not resolved through authorized local-file access`)
    }
    const stat = await fs.promises.stat(sourcePath)
    if (!stat.isFile()) throw new Error(`images[${index}].path must reference a file`)
    if (stat.size <= 0) throw new Error(`images[${index}].path is empty`)
    if (stat.size > MAX_OFFICE_IMAGE_BYTES) throw new Error(`images[${index}].path exceeds the 25 MB limit`)
    totalInputBytes += stat.size
    if (totalInputBytes > MAX_OFFICE_IMAGE_TOTAL_BYTES) throw new Error('office image inputs exceed the 100 MB total limit')

    const pipeline = sharp(sourcePath, { animated: false, limitInputPixels: MAX_OFFICE_IMAGE_PIXELS }).rotate()
    const metadata = await pipeline.metadata()
    if (!metadata.width || !metadata.height || !SUPPORTED_RASTER_FORMATS.has(String(metadata.format || '').toLowerCase())) {
      throw new Error(`images[${index}].path is not a supported raster image`)
    }
    const jpeg = metadata.format === 'jpeg' || metadata.format === 'jpg'
    const buffer = jpeg
      ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer()
    const outputMetadata = await sharp(buffer).metadata()
    const extension = jpeg ? 'jpg' : 'png'
    const mimeType = jpeg ? 'image/jpeg' : 'image/png'
    prepared.push({
      ...normalizedPlacement(entry),
      buffer,
      extension,
      mimeType,
      dataUri: `data:${mimeType};base64,${buffer.toString('base64')}`,
      pixelWidth: outputMetadata.width,
      pixelHeight: outputMetadata.height,
      sourceName: path.basename(sourcePath),
    })
  }
  return prepared
}

export function officeImageSize(image, { defaultWidth = 4, maxWidth = 10, maxHeight = 6 } = {}) {
  const ratio = finitePositive(image?.pixelWidth, 1) / finitePositive(image?.pixelHeight, 1)
  let width = finitePositive(image?.width, defaultWidth)
  let height = finitePositive(image?.height, width / ratio)
  if (width > maxWidth) {
    height *= maxWidth / width
    width = maxWidth
  }
  if (height > maxHeight) {
    width *= maxHeight / height
    height = maxHeight
  }
  return { width, height }
}

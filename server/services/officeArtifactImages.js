import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

import { resolveForFileTool } from '../adapters/fsShellTools.js'

export { officeImageSize } from './officeImageLayout.js'

const MAX_OFFICE_IMAGES = 50
const MAX_OFFICE_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_OFFICE_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_OFFICE_IMAGE_PIXELS = 80_000_000
const MAX_OFFICE_IMAGE_TOTAL_PIXELS = 160_000_000
const SUPPORTED_RASTER_FORMATS = new Set(['avif', 'gif', 'heif', 'jpeg', 'jpg', 'png', 'tiff', 'webp'])
const authorizedOfficeImageInputs = new WeakMap()

function normalizedUserId(value) {
  const userId = String(value || '').trim()
  return userId || null
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  })
}

function sameFileIdentity(stat, expected) {
  const current = fileIdentity(stat)
  return current.dev === expected.dev
    && current.ino === expected.ino
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs
}

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
 * Resolve raw tool image paths through the authoritative local-file access
 * gate. The returned objects carry a module-private identity; copying or
 * reconstructing their sourcePath does not preserve that authority.
 */
export function resolveOfficeArtifactImageInputs(images = [], { userId = null } = {}) {
  if (!Array.isArray(images)) throw new Error('images must be an array')
  if (images.length > MAX_OFFICE_IMAGES) throw new Error(`images cannot exceed ${MAX_OFFICE_IMAGES} entries`)

  const resolved = images.map((entry, index) => {
    const rawPath = String(entry?.path || '').trim()
    if (!rawPath) throw new Error(`images[${index}].path is required`)
    const ownerId = normalizedUserId(userId)
    const source = resolveForFileTool(rawPath, { userId: ownerId })
    const sourcePath = fs.realpathSync(source.fullPath)
    const stat = fs.statSync(sourcePath)
    if (!stat.isFile()) throw new Error(`images[${index}].path must reference a file`)
    const authorized = Object.freeze({
      sourcePath,
      alt: entry?.alt,
      target_index: entry?.target_index,
      anchor: entry?.anchor,
      x: entry?.x,
      y: entry?.y,
      width: entry?.width,
      height: entry?.height,
    })
    authorizedOfficeImageInputs.set(authorized, {
      ownerId,
      sourcePath,
      identity: fileIdentity(stat),
      state: 'fresh',
    })
    return authorized
  })
  return Object.freeze(resolved)
}

/**
 * Convert local raster inputs carrying an authorization identity into stable
 * Office-compatible bytes. Raw paths and copied sourcePath objects are
 * intentionally rejected.
 */
export async function prepareOfficeArtifactImages(images = [], { userId = null } = {}) {
  if (!Array.isArray(images)) throw new Error('images must be an array')
  if (images.length > MAX_OFFICE_IMAGES) throw new Error(`images cannot exceed ${MAX_OFFICE_IMAGES} entries`)

  const ownerId = normalizedUserId(userId)
  const authorizations = images.map((entry, index) => {
    const authorization = authorizedOfficeImageInputs.get(entry)
    if (!authorization) {
      throw new Error(`images[${index}].path was not resolved through authorized local-file access`)
    }
    if (authorization.state !== 'fresh') {
      throw new Error(`images[${index}].authorization has already been consumed`)
    }
    if (authorization.ownerId !== ownerId) {
      throw new Error(`images[${index}].authorization belongs to a different user`)
    }
    return authorization
  })
  for (let index = 0; index < authorizations.length; index += 1) {
    const authorization = authorizations[index]
    const currentSource = resolveForFileTool(authorization.sourcePath, { userId: ownerId })
    const canonicalSource = fs.realpathSync(currentSource.fullPath)
    if (canonicalSource !== authorization.sourcePath) {
      throw new Error(`images[${index}].path changed after authorization`)
    }
  }
  for (const authorization of authorizations) authorization.state = 'consuming'

  let totalInputBytes = 0
  let totalInputPixels = 0
  const prepared = []
  try {
    for (let index = 0; index < images.length; index += 1) {
      const entry = images[index] || {}
      const authorization = authorizations[index]
      const sourcePath = String(entry.sourcePath || '').trim()
      if (!sourcePath || !path.isAbsolute(sourcePath)) {
        throw new Error(`images[${index}].path was not resolved through authorized local-file access`)
      }
      const handle = await fs.promises.open(sourcePath, 'r')
      let inputBytes
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) throw new Error(`images[${index}].path must reference a file`)
        if (!sameFileIdentity(stat, authorization.identity)) {
          throw new Error(`images[${index}].path changed after authorization`)
        }
        if (stat.size <= 0) throw new Error(`images[${index}].path is empty`)
        if (stat.size > MAX_OFFICE_IMAGE_BYTES) throw new Error(`images[${index}].path exceeds the 25 MB limit`)
        totalInputBytes += stat.size
        if (totalInputBytes > MAX_OFFICE_IMAGE_TOTAL_BYTES) throw new Error('office image inputs exceed the 100 MB total limit')
        inputBytes = await handle.readFile()
        const statAfterRead = await handle.stat()
        if (!sameFileIdentity(statAfterRead, authorization.identity)) {
          throw new Error(`images[${index}].path changed after authorization`)
        }
      } finally {
        await handle.close()
      }

      const pipeline = sharp(inputBytes, { animated: false, limitInputPixels: MAX_OFFICE_IMAGE_PIXELS }).rotate()
      const metadata = await pipeline.metadata()
      if (!metadata.width || !metadata.height || !SUPPORTED_RASTER_FORMATS.has(String(metadata.format || '').toLowerCase())) {
        throw new Error(`images[${index}].path is not a supported raster image`)
      }
      totalInputPixels += metadata.width * metadata.height
      if (totalInputPixels > MAX_OFFICE_IMAGE_TOTAL_PIXELS) {
        throw new Error('office image inputs exceed the 160 million-pixel total limit')
      }
      const jpeg = metadata.format === 'jpeg' || metadata.format === 'jpg'
      const buffer = jpeg
        ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
        : await pipeline.png({ compressionLevel: 9 }).toBuffer()
      if (buffer.length <= 0 || buffer.length > MAX_OFFICE_IMAGE_BYTES) {
        throw new Error(`images[${index}].path produced an invalid or oversized Office image`)
      }
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
  } finally {
    for (const authorization of authorizations) authorization.state = 'consumed'
  }
}

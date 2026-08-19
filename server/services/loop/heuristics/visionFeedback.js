import fs from 'node:fs'
import path from 'node:path'

export const VISION_FEEDBACK_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const VISION_FEEDBACK_FORMAT_MIMES = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
})
export const VISION_FEEDBACK_EXT_MIMES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
})

export function resolveVisionFeedbackMaxBytes() {
  const raw = Number(process.env.VISION_FEEDBACK_MAX_BYTES)
  return Number.isInteger(raw) && raw > 0 ? raw : 2 * 1024 * 1024
}

export function visionFeedbackMime(name, result) {
  const explicit = String(result?.imageMime || result?.image?.mimeType || '').toLowerCase()
  if (VISION_FEEDBACK_MIMES.has(explicit)) return explicit
  if (name === 'image_transform') {
    return VISION_FEEDBACK_FORMAT_MIMES[String(result?.format || '').toLowerCase()] || null
  }
  const extension = path.extname(String(result?.fullPath || result?.output_path || result?.path || '')).toLowerCase()
  return VISION_FEEDBACK_EXT_MIMES[extension] || null
}

export function stripLocalInternalFields(result) {
  if (!result || typeof result !== 'object') return result
  if (!('fullPath' in result) && !('imageMime' in result)) return result
  const next = { ...result }
  delete next.fullPath
  delete next.imageMime
  return next
}

/**
 * Attach a bounded base64 image so the model can visually verify tool output.
 * The absolute fullPath is never exposed to the model or persisted.
 */
export async function attachVisionFeedback({ name, result, buffer = null }) {
  if (result?.ok !== true) return result
  const mimeType = visionFeedbackMime(name, result)
  if (!mimeType || !VISION_FEEDBACK_MIMES.has(mimeType)) return stripLocalInternalFields(result)
  const maxBytes = resolveVisionFeedbackMaxBytes()
  let bytes = buffer
  if (!bytes && result?.fullPath) {
    try {
      const stat = await fs.promises.stat(result.fullPath)
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return stripLocalInternalFields(result)
      bytes = await fs.promises.readFile(result.fullPath)
    } catch {
      return stripLocalInternalFields(result)
    }
  }
  const stripped = stripLocalInternalFields(result)
  if (!bytes || bytes.length <= 0 || bytes.length > maxBytes) return stripped
  return { ...stripped, image: { data: bytes.toString('base64'), mimeType, bytes: bytes.length } }
}

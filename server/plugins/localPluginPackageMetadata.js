import fs from 'node:fs'
import { TextDecoder } from 'node:util'

function metadataError(code, message, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.retryable = false
  return error
}

export function sameFileMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

export function readBoundedJson(filePath, maxBytes, code, {
  missingCode = code,
  requireCanonical = true,
} = {}) {
  let descriptor
  try {
    const before = fs.lstatSync(filePath)
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
      throw metadataError(code, 'required metadata is not a bounded regular file')
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0),
    )
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || !sameFileMetadata(before, opened)) {
      throw metadataError(code, 'required metadata changed before it could be read')
    }
    const chunks = []
    let totalBytes = 0
    while (true) {
      const remaining = maxBytes + 1 - totalBytes
      if (remaining <= 0) {
        throw metadataError(code, 'required metadata exceeds its size limit')
      }
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, remaining))
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      chunks.push(chunk.subarray(0, bytesRead))
    }
    if (totalBytes > maxBytes) {
      throw metadataError(code, 'required metadata exceeds its size limit')
    }
    const after = fs.fstatSync(descriptor)
    const current = fs.lstatSync(filePath)
    if (!sameFileMetadata(opened, after) || !sameFileMetadata(after, current)) {
      throw metadataError(code, 'required metadata changed while it was being read')
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes))
    const parsed = JSON.parse(text)
    if (requireCanonical && `${JSON.stringify(parsed)}\n` !== text) {
      throw metadataError(code, 'required metadata is not canonical JSON')
    }
    return parsed
  } catch (error) {
    if (error?.code === code || error?.code === missingCode) throw error
    if (error?.code === 'ENOENT' && missingCode !== code) {
      throw metadataError(
        missingCode,
        'required metadata disappeared while it was being read',
        409,
      )
    }
    throw metadataError(code, `required metadata is missing: ${error?.message || error}`)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

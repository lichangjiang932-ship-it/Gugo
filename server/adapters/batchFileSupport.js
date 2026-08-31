import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_ENTRIES = 100_000
const DEFAULT_MAX_CENTRAL_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_EXTRACTED_BYTES = 10 * 1024 * 1024 * 1024
const DEFAULT_MAX_COMPRESSION_RATIO = 1_000

export function toolError(message, statusCode = 400, code = 'BATCH_FILE_ERROR', details = {}) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  Object.assign(error, details)
  return error
}

function numericLimit(name, fallback, { minimum = 1 } = {}) {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw toolError(`${name} 必须是大于或等于 ${minimum} 的整数`, 500, 'BATCH_FILE_LIMIT_CONFIG_INVALID')
  }
  return value
}

export function maxEntries() {
  return numericLimit('BATCH_FILE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES)
}

export function maxCentralBytes() {
  return numericLimit('BATCH_FILE_MAX_ZIP_METADATA_BYTES', DEFAULT_MAX_CENTRAL_BYTES)
}

export function maxExtractedBytes() {
  return numericLimit('BATCH_FILE_MAX_EXTRACTED_BYTES', DEFAULT_MAX_EXTRACTED_BYTES)
}

export function maxCompressionRatio() {
  return numericLimit('BATCH_FILE_MAX_COMPRESSION_RATIO', DEFAULT_MAX_COMPRESSION_RATIO)
}

export function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw toolError(`${name} 为必填字符串`, 400, 'BATCH_FILE_INVALID_ARGUMENT')
  }
  return value.trim()
}

export function pathKey(value) {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw toolError('批量文件操作已取消', 499, 'BATCH_FILE_CANCELLED')
}

export function assertRegularOrDirectory(fullPath, stat, label) {
  if (stat.isSymbolicLink()) {
    throw toolError(`不支持符号链接：${label}`, 422, 'BATCH_FILE_SYMLINK_UNSUPPORTED')
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw toolError(`仅支持普通文件和目录：${label}`, 422, 'BATCH_FILE_TYPE_UNSUPPORTED')
  }
}

export function tempSibling(target, suffix = '.tmp') {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}${suffix}`)
}

export function publishTempFile(tempPath, targetPath, { overwrite = false } = {}) {
  try {
    if (overwrite) fs.renameSync(tempPath, targetPath)
    else {
      fs.linkSync(tempPath, targetPath)
      fs.unlinkSync(tempPath)
    }
  } catch (cause) {
    throw toolError(
      `无法原子发布输出：${targetPath}`,
      cause?.code === 'EEXIST' ? 409 : 500,
      cause?.code === 'EEXIST' ? 'BATCH_FILE_OUTPUT_EXISTS' : 'BATCH_FILE_WRITE_FAILED',
      { cause },
    )
  } finally {
    try { fs.unlinkSync(tempPath) } catch { /* moved or best effort */ }
  }
}

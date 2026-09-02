import fs from 'node:fs'
import { createExtractorFromFile } from 'node-unrar-js'
import {
  maxCentralBytes,
  maxCompressionRatio,
  maxEntries,
  maxExtractedBytes,
  requireString,
  throwIfAborted,
  toolError,
} from './batchFileSupport.js'
import {
  assertNoArchivePathConflicts,
  normalizeArchivePath,
} from './batchArchiveZip.js'
import { resolveForFileTool } from './fsShellTools.js'

const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const ZIP32_MAX = 0xffffffff
const RAR4_SIGNATURE = Buffer.from('526172211a0700', 'hex')
const RAR5_SIGNATURE = Buffer.from('526172211a070100', 'hex')

// node-unrar-js keeps one WASM singleton and swaps its active extractor, so
// concurrent RAR operations would otherwise corrupt each other's callbacks.
let rarOperationTail = Promise.resolve()

function readExactly(descriptor, length, position) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = fs.readSync(descriptor, buffer, offset, length - offset, position + offset)
    if (!count) throw toolError('ZIP 文件意外结束', 422, 'ARCHIVE_INVALID_ZIP')
    offset += count
  }
  return buffer
}

function decodeZipName(buffer, utf8) {
  if (utf8) return buffer.toString('utf8')
  return buffer.toString('latin1')
}

function parseZipCentralDirectory(fullPath) {
  const stat = fs.statSync(fullPath)
  if (!stat.isFile()) throw toolError('压缩包输入不是文件', 400, 'ARCHIVE_INPUT_NOT_FILE')
  const descriptor = fs.openSync(fullPath, 'r')
  try {
    const tailLength = Math.min(stat.size, 65_557)
    if (tailLength < 22) throw toolError('文件不是有效的 ZIP 压缩包', 422, 'ARCHIVE_INVALID_ZIP')
    const tail = readExactly(descriptor, tailLength, stat.size - tailLength)
    let eocdIndex = -1
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === ZIP_EOCD_SIGNATURE) {
        const commentLength = tail.readUInt16LE(index + 20)
        if (index + 22 + commentLength === tail.length) {
          eocdIndex = index
          break
        }
      }
    }
    if (eocdIndex < 0) throw toolError('找不到 ZIP 中央目录结束记录', 422, 'ARCHIVE_INVALID_ZIP')
    const eocdOffset = stat.size - tailLength + eocdIndex
    const disk = tail.readUInt16LE(eocdIndex + 4)
    const centralDisk = tail.readUInt16LE(eocdIndex + 6)
    const diskEntries = tail.readUInt16LE(eocdIndex + 8)
    const entryCount = tail.readUInt16LE(eocdIndex + 10)
    const centralSize = tail.readUInt32LE(eocdIndex + 12)
    const centralOffset = tail.readUInt32LE(eocdIndex + 16)
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
      throw toolError('不支持多磁盘 ZIP 压缩包', 415, 'ARCHIVE_MULTIDISK_UNSUPPORTED')
    }
    if (entryCount === 0xffff || centralSize === ZIP32_MAX || centralOffset === ZIP32_MAX) {
      throw toolError('当前运行时仅支持 ZIP32，不支持 ZIP64', 415, 'ARCHIVE_ZIP64_UNSUPPORTED')
    }
    if (entryCount > maxEntries()) throw toolError('ZIP 条目数量超过配置上限', 413, 'ARCHIVE_TOO_MANY_ENTRIES')
    if (centralSize > maxCentralBytes()) throw toolError('ZIP 元数据大小超过配置上限', 413, 'ARCHIVE_METADATA_TOO_LARGE')
    if (centralOffset + centralSize > eocdOffset) throw toolError('ZIP 中央目录边界无效', 422, 'ARCHIVE_INVALID_ZIP')

    const central = readExactly(descriptor, centralSize, centralOffset)
    const entries = []
    let offset = 0
    let totalSize = 0
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
        throw toolError('ZIP 中央目录条目无效', 422, 'ARCHIVE_INVALID_ZIP')
      }
      const madeBy = central.readUInt16LE(offset + 4)
      const flags = central.readUInt16LE(offset + 8)
      const method = central.readUInt16LE(offset + 10)
      const crc32 = central.readUInt32LE(offset + 16)
      const compressedSize = central.readUInt32LE(offset + 20)
      const uncompressedSize = central.readUInt32LE(offset + 24)
      const nameLength = central.readUInt16LE(offset + 28)
      const extraLength = central.readUInt16LE(offset + 30)
      const commentLength = central.readUInt16LE(offset + 32)
      const diskStart = central.readUInt16LE(offset + 34)
      const externalAttributes = central.readUInt32LE(offset + 38)
      const localOffset = central.readUInt32LE(offset + 42)
      const end = offset + 46 + nameLength + extraLength + commentLength
      if (end > central.length) throw toolError('ZIP 中央目录条目不完整', 422, 'ARCHIVE_INVALID_ZIP')
      if (flags & 0x41) throw toolError('不支持加密 ZIP 条目', 415, 'ARCHIVE_ENCRYPTED_UNSUPPORTED')
      if (![0, 8].includes(method)) {
        throw toolError(`不支持 ZIP 压缩方法 ${method}`, 415, 'ARCHIVE_COMPRESSION_UNSUPPORTED')
      }
      if (diskStart !== 0 || compressedSize === ZIP32_MAX || uncompressedSize === ZIP32_MAX || localOffset === ZIP32_MAX) {
        throw toolError('不支持 ZIP64 或多磁盘 ZIP 条目', 415, 'ARCHIVE_ZIP64_UNSUPPORTED')
      }
      const rawName = central.subarray(offset + 46, offset + 46 + nameLength)
      const decoded = decodeZipName(rawName, Boolean(flags & 0x0800))
      const unixType = ((externalAttributes >>> 16) & 0xf000) >>> 0
      if ((madeBy >>> 8) === 3 && unixType && ![0x4000, 0x8000].includes(unixType)) {
        const code = unixType === 0xa000 ? 'BATCH_FILE_SYMLINK_UNSUPPORTED' : 'BATCH_FILE_TYPE_UNSUPPORTED'
        throw toolError(`ZIP 条目类型不安全：${decoded}`, 422, code)
      }
      const directory = decoded.endsWith('/') || Boolean(externalAttributes & 0x10) || unixType === 0x4000
      const name = normalizeArchivePath(decoded, { directory, label: 'ZIP 条目路径' })
      totalSize += uncompressedSize
      if (totalSize > maxExtractedBytes()) throw toolError('ZIP 解压后总大小超过配置上限', 413, 'ARCHIVE_EXPANSION_LIMIT')
      if (!directory && uncompressedSize > 0) {
        if (compressedSize === 0 || uncompressedSize / compressedSize > maxCompressionRatio()) {
          throw toolError(`ZIP 条目膨胀比异常：${name}`, 413, 'ARCHIVE_COMPRESSION_RATIO_LIMIT')
        }
      }
      entries.push({ name, directory, flags, method, crc32, compressedSize, uncompressedSize, localOffset })
      offset = end
    }
    assertNoArchivePathConflicts(entries)
    return { descriptor, size: stat.size, entries, totalSize, centralOffset, close: () => fs.closeSync(descriptor) }
  } catch (cause) {
    fs.closeSync(descriptor)
    throw cause
  }
}

function detectArchiveFormat(fullPath, requested = '') {
  const stat = fs.statSync(fullPath)
  if (!stat.isFile()) throw toolError('压缩包输入不是文件', 400, 'ARCHIVE_INPUT_NOT_FILE')
  const descriptor = fs.openSync(fullPath, 'r')
  const prefix = Buffer.alloc(8)
  try { fs.readSync(descriptor, prefix, 0, prefix.length, 0) } finally { fs.closeSync(descriptor) }
  const rarVersion = prefix.subarray(0, RAR5_SIGNATURE.length).equals(RAR5_SIGNATURE)
    ? 5
    : prefix.subarray(0, RAR4_SIGNATURE.length).equals(RAR4_SIGNATURE) ? 4 : null
  const zipSignature = prefix.length >= 4 && [
    ZIP_LOCAL_SIGNATURE,
    ZIP_CENTRAL_SIGNATURE,
    ZIP_EOCD_SIGNATURE,
    ZIP_DATA_DESCRIPTOR_SIGNATURE,
  ].includes(prefix.readUInt32LE(0))
  const detected = rarVersion ? 'rar' : zipSignature ? 'zip' : null
  if (requested && detected && requested !== detected) {
    throw toolError(
      `压缩包内容是 ${detected.toUpperCase()}，与请求格式 ${requested.toUpperCase()} 不一致`,
      415,
      'ARCHIVE_FORMAT_MISMATCH',
    )
  }
  return {
    format: detected || requested || (/\.rar$/iu.test(fullPath) ? 'rar' : 'zip'),
    rarVersion,
    size: stat.size,
  }
}

function resolveArchiveInput(args, context) {
  const requested = String(args.format || '').trim().toLowerCase()
  if (requested && !['zip', 'rar'].includes(requested)) {
    throw toolError(`不支持的压缩包格式：${requested}`, 415, 'ARCHIVE_FORMAT_UNSUPPORTED')
  }
  const input = resolveForFileTool(requireString(args.input, 'input'), { userId: context.userId })
  return { ...input, ...detectArchiveFormat(input.fullPath, requested) }
}

async function withRarOperation(task, signal) {
  const previous = rarOperationTail
  let release
  rarOperationTail = new Promise((resolve) => { release = resolve })
  await previous
  try {
    throwIfAborted(signal)
    return await task()
  } finally {
    release()
  }
}

function closeRarExtractor(extractor) {
  if (!extractor) return
  for (const rawFd of Object.keys(extractor.fileMap || {})) {
    try { extractor.closeFile(Number(rawFd)) } catch { /* best effort */ }
  }
  if (extractor._archive) {
    try { extractor.closeArc() } catch { /* best effort */ }
  }
}

function translateRarError(cause, entry = '') {
  if (cause?.code) return cause
  if (['ERAR_MISSING_PASSWORD', 'ERAR_BAD_PASSWORD'].includes(cause?.reason)) {
    return toolError('不支持加密 RAR 压缩包或条目', 415, 'ARCHIVE_ENCRYPTED_UNSUPPORTED', { cause })
  }
  const detail = entry || cause?.file
  return toolError(
    detail ? `无法读取 RAR 条目：${detail}` : '文件不是有效的 RAR 压缩包或已损坏',
    422,
    detail ? 'ARCHIVE_ENTRY_EXTRACT_FAILED' : 'ARCHIVE_INVALID_RAR',
    { cause },
  )
}

function safeRarInteger(value, field, entry = '') {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw toolError(
      `RAR ${field} 超出安全整数范围${entry ? `：${entry}` : ''}`,
      415,
      'ARCHIVE_RAR_SIZE_UNSUPPORTED',
    )
  }
  return number
}

function assertSafeRarEntryType(raw, { directory, name, version }) {
  const hostOS = safeRarInteger(raw.hostOS, 'hostOS', name)
  const attributes = safeRarInteger(raw.fileAttr, 'fileAttr', name) >>> 0
  const supportedHosts = version === 5 ? [0, 1] : [0, 1, 2, 3]
  if (!supportedHosts.includes(hostOS)) {
    throw toolError(`不支持无法安全判定类型的 RAR 条目：${name}`, 415, 'ARCHIVE_ENTRY_TYPE_UNSUPPORTED')
  }
  if (attributes & 0x400) {
    throw toolError(`拒绝 RAR 重解析点条目：${name}`, 422, 'BATCH_FILE_SYMLINK_UNSUPPORTED')
  }
  const unixHost = version === 5 ? hostOS === 1 : hostOS === 3
  if (unixHost) {
    const unixType = attributes & 0xf000
    const expectedType = directory ? 0x4000 : 0x8000
    if (unixType && unixType !== expectedType) {
      throw toolError(`拒绝 RAR 链接或特殊文件条目：${name}`, 422, 'BATCH_FILE_SYMLINK_UNSUPPORTED')
    }
  }
}

async function parseRarHeaders(input, signal) {
  let extractor
  try {
    extractor = await createExtractorFromFile({ filepath: input.fullPath })
    if (typeof extractor.openArc !== 'function'
      || typeof extractor.closeArc !== 'function'
      || typeof extractor.getFailException !== 'function') {
      throw toolError('RAR 后端版本不兼容', 500, 'ARCHIVE_RAR_BACKEND_INCOMPATIBLE')
    }
    const arcHeader = extractor.openArc(true)
    if (arcHeader.flags.headerEncrypted) {
      throw toolError('不支持加密 RAR 压缩包头', 415, 'ARCHIVE_ENCRYPTED_UNSUPPORTED')
    }
    if (arcHeader.flags.volume) {
      throw toolError('不支持分卷 RAR 压缩包', 415, 'ARCHIVE_MULTIDISK_UNSUPPORTED')
    }
    const entries = []
    let totalSize = 0
    let totalCompressedSize = 0
    while (true) {
      throwIfAborted(signal)
      const raw = extractor._archive.getFileHeader()
      if (raw?.state?.errCode === 10) break
      if (raw?.state?.errCode !== 0) {
        throw extractor.getFailException(raw?.state?.errCode, raw?.state?.errType)
      }
      if (entries.length >= maxEntries()) {
        throw toolError('RAR 条目数量超过配置上限', 413, 'ARCHIVE_TOO_MANY_ENTRIES')
      }
      const rawName = String(raw.name || '')
      const directory = Boolean(Number(raw.flags) & 0x20)
      const name = normalizeArchivePath(rawName, { directory, label: 'RAR 条目路径' })
      if (Number(raw.flags) & 0x04) {
        throw toolError(`不支持加密 RAR 条目：${name}`, 415, 'ARCHIVE_ENCRYPTED_UNSUPPORTED')
      }
      assertSafeRarEntryType(raw, { directory, name, version: input.rarVersion || 4 })
      const compressedSize = safeRarInteger(raw.packSize, '压缩大小', name)
      const uncompressedSize = safeRarInteger(raw.unpSize, '解压大小', name)
      totalSize += uncompressedSize
      totalCompressedSize += compressedSize
      if (!Number.isSafeInteger(totalSize) || totalSize > maxExtractedBytes()) {
        throw toolError('RAR 解压后总大小超过配置上限', 413, 'ARCHIVE_EXPANSION_LIMIT')
      }
      if (!directory && uncompressedSize > 0
        && (compressedSize === 0 || uncompressedSize / compressedSize > maxCompressionRatio())) {
        throw toolError(`RAR 条目膨胀比异常：${name}`, 413, 'ARCHIVE_COMPRESSION_RATIO_LIMIT')
      }
      entries.push({
        name,
        rawName,
        directory,
        compressedSize,
        uncompressedSize,
        crc32: Number(raw.crc) >>> 0,
      })
      const skipped = extractor._archive.readFile(true)
      if (skipped?.errCode !== 0) {
        throw extractor.getFailException(skipped?.errCode, skipped?.errType, rawName)
      }
    }
    assertNoArchivePathConflicts(entries)
    return {
      size: input.size,
      entries,
      totalSize,
      totalCompressedSize,
      close() {},
    }
  } catch (cause) {
    throw translateRarError(cause)
  } finally {
    closeRarExtractor(extractor)
  }
}

function archiveListResult(input, archive) {
  return {
    ok: true,
    format: input.format,
    input: input.displayPath,
    scope: input.source,
    size: archive.size,
    entryCount: archive.entries.length,
    totalBytes: archive.totalSize,
    totalCompressedBytes: archive.totalCompressedSize
      ?? archive.entries.reduce((sum, entry) => sum + entry.compressedSize, 0),
    entries: archive.entries.map((entry) => ({
      path: entry.name,
      directory: entry.directory,
      type: entry.directory ? 'directory' : 'file',
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      crc32: entry.crc32.toString(16).padStart(8, '0'),
    })),
    limitations: {
      zip64Supported: false,
      encryptedEntriesSupported: false,
      rarSupported: true,
      rarVolumesSupported: false,
    },
  }
}

async function archiveList(args, context) {
  const input = resolveArchiveInput(args, context)
  if (input.format === 'rar') {
    return withRarOperation(async () => {
      const archive = await parseRarHeaders(input, context.signal)
      return archiveListResult(input, archive)
    }, context.signal)
  }
  const archive = parseZipCentralDirectory(input.fullPath)
  try {
    return archiveListResult(input, archive)
  } finally {
    archive.close()
  }
}

export {
  archiveList,
  closeRarExtractor,
  decodeZipName,
  parseRarHeaders,
  parseZipCentralDirectory,
  readExactly,
  resolveArchiveInput,
  translateRarError,
  withRarOperation,
}

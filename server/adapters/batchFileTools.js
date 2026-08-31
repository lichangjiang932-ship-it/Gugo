import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw, createInflateRaw } from 'node:zlib'
import { createExtractorFromFile } from 'node-unrar-js'
import { batchRename } from './batchRenameRuntime.js'
import {
  assertRegularOrDirectory,
  maxCentralBytes,
  maxCompressionRatio,
  maxEntries,
  maxExtractedBytes,
  pathKey,
  publishTempFile,
  requireString,
  tempSibling,
  throwIfAborted,
  toolError,
} from './batchFileSupport.js'
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

function runPipeline(streams, signal) {
  return signal ? pipeline(streams, { signal }) : pipeline(streams)
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function normalizeArchivePath(value, { directory = false, label = 'archive path' } = {}) {
  const raw = requireString(value, label).normalize('NFC')
  if (raw.includes('\0') || /^[a-z]:/iu.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw toolError(`${label} 必须是安全的相对路径：${value}`, 400, 'ARCHIVE_UNSAFE_PATH')
  }
  const slashPath = raw.replace(/\\/gu, '/')
  const isDirectory = directory || slashPath.endsWith('/')
  const segments = slashPath.replace(/\/+$/u, '').split('/')
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw toolError(`${label} 包含空路径段、点路径段或父路径段：${value}`, 400, 'ARCHIVE_UNSAFE_PATH')
  }
  for (const segment of segments) {
    const hasControlCharacter = [...segment].some((character) => character.codePointAt(0) <= 0x1f)
    if (hasControlCharacter || /[<>:"|?*]/u.test(segment)
      || /[ .]$/u.test(segment)
      || WINDOWS_RESERVED.test(segment)) {
      throw toolError(`${label} 不是可移植的安全路径：${value}`, 400, 'ARCHIVE_UNSAFE_PATH')
    }
  }
  return `${segments.join('/')}${isDirectory ? '/' : ''}`
}

function archiveEntryKey(name) {
  const value = name.replace(/\/$/u, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function assertNoArchivePathConflicts(entries) {
  const shapes = new Map()
  for (const entry of entries) {
    const key = archiveEntryKey(entry.name)
    if (shapes.has(key)) throw toolError(`压缩包条目重复：${entry.name}`, 409, 'ARCHIVE_DUPLICATE_ENTRY')
    shapes.set(key, entry.directory ? 'directory' : 'file')
  }
  for (const key of shapes.keys()) {
    const segments = key.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      if (shapes.get(segments.slice(0, index).join('/')) === 'file') {
        throw toolError(`压缩包文件/目录路径冲突：${key}`, 409, 'ARCHIVE_PATH_CONFLICT')
      }
    }
  }
}

function collectArchiveInputs(rawInputs, { userId = null } = {}) {
  if (!Array.isArray(rawInputs) || !rawInputs.length) {
    throw toolError('archive_create 需要非空 inputs 数组', 400, 'ARCHIVE_INPUTS_REQUIRED')
  }
  const entries = []
  const limit = maxEntries()

  const append = (fullPath, archiveName) => {
    const stat = fs.lstatSync(fullPath)
    assertRegularOrDirectory(fullPath, stat, fullPath)
    const name = normalizeArchivePath(archiveName, { directory: stat.isDirectory() })
    if (entries.length >= limit) {
      throw toolError(`压缩包条目数量超过 ${limit}`, 413, 'ARCHIVE_TOO_MANY_ENTRIES')
    }
    if (stat.isFile() && stat.size > ZIP32_MAX) {
      throw toolError(`ZIP32 无法存储大于 4 GiB 的文件：${fullPath}`, 413, 'ARCHIVE_ZIP64_REQUIRED')
    }
    entries.push({ fullPath, name, directory: stat.isDirectory(), size: stat.size, mtime: stat.mtime })
    if (!stat.isDirectory()) return
    for (const child of fs.readdirSync(fullPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childPath = path.join(fullPath, child.name)
      append(childPath, `${name}${child.name}`)
    }
  }

  rawInputs.forEach((item, index) => {
    const rawPath = typeof item === 'string' ? item : item?.path
    const resolved = resolveForFileTool(requireString(rawPath, `inputs[${index}].path`), { userId })
    const stat = fs.lstatSync(resolved.fullPath)
    assertRegularOrDirectory(resolved.fullPath, stat, resolved.displayPath)
    const requestedName = typeof item === 'object' && item?.archivePath
      ? item.archivePath
      : path.basename(resolved.fullPath)
    append(resolved.fullPath, requestedName)
  })
  assertNoArchivePathConflicts(entries)
  return entries
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let crc = value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    table[value] = crc >>> 0
  }
  return table
})()

function updateCrc32(crc, chunk) {
  let value = crc >>> 0
  for (const byte of chunk) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]
  return value >>> 0
}

function countingTransform({ crc = false } = {}) {
  let size = 0
  let crcValue = 0xffffffff
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (crc) crcValue = updateCrc32(crcValue, chunk)
      callback(null, chunk)
    },
  })
  return {
    stream,
    size: () => size,
    crc32: () => (crcValue ^ 0xffffffff) >>> 0,
  }
}

function checkedExtractionTransform(entry, aggregate) {
  let size = 0
  let crcValue = 0xffffffff
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const nextEntrySize = size + chunk.length
      if (nextEntrySize > entry.uncompressedSize) {
        callback(toolError(
          `ZIP 条目实际大小超过中央目录声明：${entry.name}`,
          413,
          'ARCHIVE_ENTRY_SIZE_LIMIT',
          { entry: entry.name, declaredBytes: entry.uncompressedSize, actualBytes: nextEntrySize },
        ))
        return
      }
      const nextTotalSize = aggregate.size + chunk.length
      if (nextTotalSize > aggregate.limit) {
        callback(toolError(
          'ZIP 实际解压总大小超过配置上限',
          413,
          'ARCHIVE_EXPANSION_LIMIT',
          { maxBytes: aggregate.limit, actualBytes: nextTotalSize },
        ))
        return
      }
      size = nextEntrySize
      aggregate.size = nextTotalSize
      crcValue = updateCrc32(crcValue, chunk)
      callback(null, chunk)
    },
  })
  return {
    stream,
    size: () => size,
    crc32: () => (crcValue ^ 0xffffffff) >>> 0,
  }
}

function writeAt(descriptor, buffer, position) {
  let written = 0
  while (written < buffer.length) {
    written += fs.writeSync(descriptor, buffer, written, buffer.length - written, position + written)
  }
  return position + buffer.length
}

function dosDateTime(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const year = Math.max(1980, Math.min(2107, value.getFullYear()))
  return {
    time: ((value.getHours() & 0x1f) << 11) | ((value.getMinutes() & 0x3f) << 5) | ((value.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((value.getMonth() + 1) & 0x0f) << 5) | (value.getDate() & 0x1f),
  }
}

function localHeader(entry, { crc32 = 0, compressedSize = 0, uncompressedSize = 0 } = {}) {
  const name = Buffer.from(entry.name, 'utf8')
  const header = Buffer.alloc(30 + name.length)
  header.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(entry.flags, 6)
  header.writeUInt16LE(entry.method, 8)
  header.writeUInt16LE(entry.dosTime, 10)
  header.writeUInt16LE(entry.dosDate, 12)
  header.writeUInt32LE(crc32 >>> 0, 14)
  header.writeUInt32LE(compressedSize >>> 0, 18)
  header.writeUInt32LE(uncompressedSize >>> 0, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  name.copy(header, 30)
  return header
}

function dataDescriptor(crc32, compressedSize, uncompressedSize) {
  const value = Buffer.alloc(16)
  value.writeUInt32LE(ZIP_DATA_DESCRIPTOR_SIGNATURE, 0)
  value.writeUInt32LE(crc32 >>> 0, 4)
  value.writeUInt32LE(compressedSize >>> 0, 8)
  value.writeUInt32LE(uncompressedSize >>> 0, 12)
  return value
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8')
  const header = Buffer.alloc(46 + name.length)
  header.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0)
  header.writeUInt16LE((3 << 8) | 20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(entry.flags, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(entry.dosTime, 12)
  header.writeUInt16LE(entry.dosDate, 14)
  header.writeUInt32LE(entry.crc32 >>> 0, 16)
  header.writeUInt32LE(entry.compressedSize >>> 0, 20)
  header.writeUInt32LE(entry.uncompressedSize >>> 0, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  const mode = entry.directory ? 0o40755 : 0o100644
  header.writeUInt32LE(((mode << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38)
  header.writeUInt32LE(entry.localOffset >>> 0, 42)
  name.copy(header, 46)
  return header
}

function eocd(entryCount, centralSize, centralOffset) {
  const value = Buffer.alloc(22)
  value.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0)
  value.writeUInt16LE(0, 4)
  value.writeUInt16LE(0, 6)
  value.writeUInt16LE(entryCount, 8)
  value.writeUInt16LE(entryCount, 10)
  value.writeUInt32LE(centralSize >>> 0, 12)
  value.writeUInt32LE(centralOffset >>> 0, 16)
  value.writeUInt16LE(0, 20)
  return value
}

async function writeZipStream(tempPath, sourceEntries, { level = 6, signal = null } = {}) {
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw toolError('compressionLevel 必须是 0 到 9 的整数', 400, 'ARCHIVE_INVALID_COMPRESSION_LEVEL')
  }
  const descriptor = fs.openSync(tempPath, 'wx', 0o600)
  const completed = []
  let offset = 0
  try {
    for (const source of sourceEntries) {
      throwIfAborted(signal)
      const stamp = dosDateTime(source.mtime)
      const entry = {
        ...source,
        flags: source.directory ? 0x0800 : 0x0808,
        method: source.directory ? 0 : 8,
        dosTime: stamp.time,
        dosDate: stamp.date,
        localOffset: offset,
      }
      if (entry.localOffset > ZIP32_MAX) throw toolError('该输出需要 ZIP64，当前仅支持 ZIP32', 413, 'ARCHIVE_ZIP64_REQUIRED')
      const header = localHeader(entry)
      offset = writeAt(descriptor, header, offset)
      if (source.directory) {
        completed.push({ ...entry, crc32: 0, compressedSize: 0, uncompressedSize: 0 })
        continue
      }

      const plain = countingTransform({ crc: true })
      const compressed = countingTransform()
      const output = fs.createWriteStream(tempPath, { fd: descriptor, autoClose: false, start: offset })
      await runPipeline([
        fs.createReadStream(source.fullPath),
        plain.stream,
        createDeflateRaw({ level }),
        compressed.stream,
        output,
      ], signal)
      const uncompressedSize = plain.size()
      const compressedSize = compressed.size()
      if (uncompressedSize > ZIP32_MAX || compressedSize > ZIP32_MAX || offset + compressedSize > ZIP32_MAX) {
        throw toolError('该输出需要 ZIP64，当前仅支持 ZIP32', 413, 'ARCHIVE_ZIP64_REQUIRED')
      }
      offset += compressedSize
      offset = writeAt(descriptor, dataDescriptor(plain.crc32(), compressedSize, uncompressedSize), offset)
      completed.push({
        ...entry,
        crc32: plain.crc32(),
        compressedSize,
        uncompressedSize,
      })
    }

    if (completed.length > 0xffff) throw toolError('条目数量需要 ZIP64，当前仅支持 ZIP32', 413, 'ARCHIVE_ZIP64_REQUIRED')
    const centralOffset = offset
    for (const entry of completed) offset = writeAt(descriptor, centralHeader(entry), offset)
    const centralSize = offset - centralOffset
    if (centralOffset > ZIP32_MAX || centralSize > ZIP32_MAX) {
      throw toolError('中央目录需要 ZIP64，当前仅支持 ZIP32', 413, 'ARCHIVE_ZIP64_REQUIRED')
    }
    offset = writeAt(descriptor, eocd(completed.length, centralSize, centralOffset), offset)
    fs.fsyncSync(descriptor)
    return { size: offset, entries: completed }
  } finally {
    fs.closeSync(descriptor)
  }
}

function resolveOutputFile(rawPath, { userId = null, overwrite = false } = {}) {
  const resolved = resolveForFileTool(requireString(rawPath, 'output'), {
    userId,
    write: true,
    allowMissing: true,
  })
  if (fs.existsSync(resolved.fullPath)) {
    if (!fs.statSync(resolved.fullPath).isFile()) {
      throw toolError(`输出路径不是文件：${resolved.displayPath}`, 400, 'BATCH_FILE_OUTPUT_NOT_FILE')
    }
    if (!overwrite) {
      throw toolError(`输出已存在：${resolved.displayPath}`, 409, 'BATCH_FILE_OUTPUT_EXISTS')
    }
  }
  return resolved
}

function assertZipCreateFormat({ format, inputPath = '' } = {}) {
  const requested = String(format || '').trim().toLowerCase()
  if (requested === 'rar' || /\.rar$/iu.test(inputPath)) {
    throw toolError(
      'RAR 仅支持读取和解压，创建压缩包请使用 ZIP。',
      415,
      'ARCHIVE_RAR_CREATE_UNSUPPORTED',
    )
  }
  if (requested && requested !== 'zip') {
    throw toolError(`不支持的压缩包格式：${requested}`, 415, 'ARCHIVE_FORMAT_UNSUPPORTED')
  }
}

async function archiveCreate(args, context) {
  assertZipCreateFormat({ format: args.format, inputPath: args.output })
  const overwrite = args.overwrite === true
  const entries = collectArchiveInputs(args.inputs, context)
  const output = resolveOutputFile(args.output, { ...context, overwrite })
  const outputKey = pathKey(output.fullPath)
  if (entries.some((entry) => pathKey(entry.fullPath) === outputKey)) {
    throw toolError('压缩包输出不能覆盖自身输入', 409, 'ARCHIVE_OUTPUT_IS_INPUT')
  }
  const tempPath = tempSibling(output.fullPath, '.tmp.zip')
  try {
    const written = await writeZipStream(tempPath, entries, {
      level: args.compressionLevel == null ? 6 : Number(args.compressionLevel),
      signal: context.signal,
    })
    publishTempFile(tempPath, output.fullPath, { overwrite })
    return {
      ok: true,
      format: 'zip',
      path: output.displayPath,
      output: output.displayPath,
      scope: output.source,
      changedPaths: [output.displayPath],
      size: written.size,
      entryCount: written.entries.length,
      entries: written.entries.map((entry) => ({
        path: entry.name,
        type: entry.directory ? 'directory' : 'file',
        size: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        crc32: entry.crc32.toString(16).padStart(8, '0'),
      })),
    }
  } catch (cause) {
    try { fs.unlinkSync(tempPath) } catch { /* best effort */ }
    throw cause
  }
}

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

function localEntryDataStart(archive, entry) {
  const fixed = readExactly(archive.descriptor, 30, entry.localOffset)
  if (fixed.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
    throw toolError(`ZIP 本地文件头无效：${entry.name}`, 422, 'ARCHIVE_INVALID_ZIP')
  }
  const flags = fixed.readUInt16LE(6)
  const method = fixed.readUInt16LE(8)
  const nameLength = fixed.readUInt16LE(26)
  const extraLength = fixed.readUInt16LE(28)
  if (flags & 0x41 || method !== entry.method) {
    throw toolError(`ZIP 本地文件头与中央目录不一致：${entry.name}`, 422, 'ARCHIVE_INVALID_ZIP')
  }
  const nameBytes = readExactly(archive.descriptor, nameLength, entry.localOffset + 30)
  const localName = normalizeArchivePath(decodeZipName(nameBytes, Boolean(flags & 0x0800)), {
    directory: entry.directory,
    label: 'ZIP 本地条目路径',
  })
  if (localName !== entry.name) {
    throw toolError(`ZIP 本地条目路径与中央目录不一致：${entry.name}`, 422, 'ARCHIVE_HEADER_MISMATCH')
  }
  const start = entry.localOffset + 30 + nameLength + extraLength
  if (start + entry.compressedSize > archive.centralOffset) {
    throw toolError(`ZIP 条目数据超出压缩包边界：${entry.name}`, 422, 'ARCHIVE_INVALID_ZIP')
  }
  return start
}

async function extractZipToStage(archivePath, archive, stageRoot, signal) {
  const aggregate = { size: 0, limit: maxExtractedBytes() }
  for (const entry of archive.entries) {
    throwIfAborted(signal)
    const target = path.join(stageRoot, ...entry.name.replace(/\/$/u, '').split('/'))
    if (entry.directory) {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const dataStart = localEntryDataStart(archive, entry)
    const input = entry.compressedSize
      ? fs.createReadStream(archivePath, { start: dataStart, end: dataStart + entry.compressedSize - 1 })
      : Readable.from([])
    const counted = checkedExtractionTransform(entry, aggregate)
    const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 })
    const streams = [input]
    if (entry.method === 8) streams.push(createInflateRaw())
    streams.push(counted.stream, output)
    try {
      await runPipeline(streams, signal)
    } catch (cause) {
      try { fs.unlinkSync(target) } catch { /* best effort */ }
      if (signal?.aborted) throwIfAborted(signal)
      if (['ARCHIVE_ENTRY_SIZE_LIMIT', 'ARCHIVE_EXPANSION_LIMIT'].includes(cause?.code)) throw cause
      throw toolError(`无法解压 ZIP 条目：${entry.name}`, 422, 'ARCHIVE_ENTRY_EXTRACT_FAILED', { cause })
    }
    if (counted.size() !== entry.uncompressedSize || counted.crc32() !== entry.crc32) {
      try { fs.unlinkSync(target) } catch { /* best effort */ }
      throw toolError(`ZIP 条目的 CRC 或大小不匹配：${entry.name}`, 422, 'ARCHIVE_INTEGRITY_FAILED')
    }
  }
}

async function extractRarToStage(archivePath, archive, stageRoot, signal) {
  const entriesByRawName = new Map(archive.entries.map((entry) => [entry.rawName, entry]))
  const statesByRawName = new Map(archive.entries
    .filter((entry) => !entry.directory)
    .map((entry) => [entry.rawName, { entry, actualSize: 0, crcValue: 0xffffffff }]))
  const seenByRawName = new Map()
  const aggregate = { size: 0, limit: maxExtractedBytes() }
  let extractor
  let writeViolation = null
  try {
    for (const entry of archive.entries.filter((item) => item.directory)) {
      const target = path.join(stageRoot, ...entry.name.replace(/\/$/u, '').split('/'))
      fs.mkdirSync(target, { recursive: true })
    }
    extractor = await createExtractorFromFile({
      filepath: archivePath,
      targetPath: stageRoot,
      filenameTransform(filename) {
        const rawName = String(filename || '')
        const entry = entriesByRawName.get(rawName)
        let invalid = !entry || entry.directory
        if (!invalid) {
          try {
            const normalized = normalizeArchivePath(rawName, { directory: false, label: 'RAR 解压条目路径' })
            invalid = normalized !== entry.name
          } catch (cause) {
            writeViolation ||= cause
            invalid = true
          }
        }
        if (invalid) {
          writeViolation ||= toolError(`RAR 解压返回了未请求的路径：${rawName}`, 422, 'ARCHIVE_HEADER_MISMATCH')
          return `.rejected-${crypto.randomUUID()}`
        }
        return entry.name
      },
    })
    const originalWrite = extractor.write.bind(extractor)
    extractor.write = (fd, bufferOffset, size) => {
      if (writeViolation) return false
      if (signal?.aborted) {
        writeViolation = toolError('批量文件操作已取消', 499, 'BATCH_FILE_CANCELLED')
        return false
      }
      const fileState = extractor.fileMap?.[fd]
      const rawName = String(fileState?.name || '')
      const state = statesByRawName.get(rawName)
      if (!state) {
        writeViolation = toolError(`RAR 解压写入了未请求的条目：${rawName}`, 422, 'ARCHIVE_HEADER_MISMATCH')
        return false
      }
      const currentPosition = Number(fileState.pos)
      if (!Number.isSafeInteger(currentPosition) || currentPosition < 0 || currentPosition !== state.actualSize) {
        writeViolation = toolError(
          `不支持 RAR 条目的非顺序写入：${state.entry.name}`,
          415,
          'ARCHIVE_RAR_WRITE_PATTERN_UNSUPPORTED',
        )
        return false
      }
      const nextSize = Math.max(state.actualSize, currentPosition + size)
      const delta = nextSize - state.actualSize
      if (nextSize > state.entry.uncompressedSize) {
        writeViolation = toolError(
          `RAR 条目实际大小超过头部声明：${state.entry.name}`,
          413,
          'ARCHIVE_ENTRY_SIZE_LIMIT',
          { entry: state.entry.name, declaredBytes: state.entry.uncompressedSize, actualBytes: nextSize },
        )
        return false
      }
      if (aggregate.size + delta > aggregate.limit) {
        writeViolation = toolError(
          'RAR 实际解压总大小超过配置上限',
          413,
          'ARCHIVE_EXPANSION_LIMIT',
          { maxBytes: aggregate.limit, actualBytes: aggregate.size + delta },
        )
        return false
      }
      const bytes = extractor.unrar.HEAPU8.subarray(bufferOffset, bufferOffset + size)
      const nextCrc = updateCrc32(state.crcValue, bytes)
      const written = originalWrite(fd, bufferOffset, size)
      if (written) {
        state.actualSize = nextSize
        state.crcValue = nextCrc
        aggregate.size += delta
      }
      return written
    }
    const result = extractor.extract({
      files(fileHeader) {
        throwIfAborted(signal)
        const rawName = String(fileHeader?.name || '')
        const entry = entriesByRawName.get(rawName)
        if (!entry
          || Boolean(fileHeader.flags?.directory) !== entry.directory
          || Number(fileHeader.unpSize) !== entry.uncompressedSize
          || Number(fileHeader.packSize) !== entry.compressedSize) {
          throw toolError(`RAR 提取头与预检结果不一致：${rawName}`, 422, 'ARCHIVE_HEADER_MISMATCH')
        }
        return true
      },
    })
    for (const extracted of result.files) {
      throwIfAborted(signal)
      const rawName = String(extracted.fileHeader?.name || '')
      const entry = entriesByRawName.get(rawName)
      if (!entry || Boolean(extracted.fileHeader?.flags?.directory) !== entry.directory) {
        throw toolError(`RAR 解压返回了未请求的条目：${rawName}`, 422, 'ARCHIVE_HEADER_MISMATCH')
      }
      seenByRawName.set(rawName, (seenByRawName.get(rawName) || 0) + 1)
    }
    if (writeViolation) throw writeViolation
    for (const entry of archive.entries) {
      if (seenByRawName.get(entry.rawName) !== 1) {
        throw toolError(`RAR 条目未被完整且唯一地解压：${entry.name}`, 422, 'ARCHIVE_ENTRY_EXTRACT_FAILED')
      }
      if (entry.directory) continue
      const state = statesByRawName.get(entry.rawName)
      const target = path.join(stageRoot, ...entry.name.split('/'))
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw toolError(`拒绝 RAR 链接或特殊文件条目：${entry.name}`, 422, 'BATCH_FILE_SYMLINK_UNSUPPORTED')
      }
      const actualCrc32 = (state.crcValue ^ 0xffffffff) >>> 0
      if (stat.size !== entry.uncompressedSize
        || state.actualSize !== entry.uncompressedSize
        || actualCrc32 !== entry.crc32) {
        throw toolError(
          `RAR 条目的大小或 CRC 与头部声明不一致：${entry.name}`,
          422,
          'ARCHIVE_INTEGRITY_FAILED',
          {
            entry: entry.name,
            declaredBytes: entry.uncompressedSize,
            actualBytes: stat.size,
            declaredCrc32: entry.crc32.toString(16).padStart(8, '0'),
            actualCrc32: actualCrc32.toString(16).padStart(8, '0'),
          },
        )
      }
    }
  } catch (cause) {
    if (writeViolation) throw writeViolation
    if (signal?.aborted) throwIfAborted(signal)
    throw translateRarError(cause)
  } finally {
    closeRarExtractor(extractor)
  }
}

function resolveExtractionTargets(rawOutputDir, entries, { userId = null, overwrite = false } = {}) {
  const outputRoot = resolveForFileTool(requireString(rawOutputDir, 'outputDir'), {
    userId,
    write: true,
    allowMissing: true,
  })
  if (fs.existsSync(outputRoot.fullPath) && !fs.statSync(outputRoot.fullPath).isDirectory()) {
    throw toolError('outputDir 不是目录', 400, 'ARCHIVE_OUTPUT_NOT_DIRECTORY')
  }
  const targets = entries.map((entry) => {
    const relative = entry.name.replace(/\/$/u, '')
    const targetPath = path.join(outputRoot.fullPath, ...relative.split('/'))
    const resolved = resolveForFileTool(targetPath, { userId, write: true, allowMissing: true })
    const relation = path.relative(outputRoot.fullPath, resolved.fullPath)
    if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      throw toolError(`ZIP 条目越出 outputDir：${entry.name}`, 403, 'ARCHIVE_ZIP_SLIP')
    }
    if (fs.existsSync(resolved.fullPath)) {
      const stat = fs.lstatSync(resolved.fullPath)
      if (stat.isSymbolicLink()) throw toolError(`拒绝通过符号链接解压：${entry.name}`, 422, 'ARCHIVE_ZIP_SLIP')
      if (entry.directory && !stat.isDirectory()) throw toolError(`输出类型冲突：${entry.name}`, 409, 'ARCHIVE_OUTPUT_CONFLICT')
      if (!entry.directory && !stat.isFile()) throw toolError(`输出类型冲突：${entry.name}`, 409, 'ARCHIVE_OUTPUT_CONFLICT')
      if (!entry.directory && !overwrite) throw toolError(`输出已存在：${entry.name}`, 409, 'BATCH_FILE_OUTPUT_EXISTS')
    }
    return { entry, fullPath: resolved.fullPath, displayPath: resolved.displayPath, scope: resolved.source }
  })
  return { outputRoot, targets }
}

function ensureArchiveDirectory(target, createdDirectories) {
  const missing = []
  let current = target
  while (!fs.existsSync(current) && current !== path.dirname(current)) {
    missing.push(current)
    current = path.dirname(current)
  }
  const existing = fs.lstatSync(current)
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw toolError(`解压目标的父路径不是安全目录：${current}`, 409, 'ARCHIVE_OUTPUT_CONFLICT')
  }
  for (const directory of missing.reverse()) {
    try {
      fs.mkdirSync(directory)
      createdDirectories.add(directory)
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause
      const stat = fs.lstatSync(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw cause
    }
  }
}

async function copyFileAtomically(source, target, {
  overwrite = false,
  signal = null,
  backups,
  published,
} = {}) {
  const tempPath = tempSibling(target)
  try {
    await runPipeline([
      fs.createReadStream(source),
      fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
    ], signal)
    const descriptor = fs.openSync(tempPath, 'r+')
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    throwIfAborted(signal)
    let backupPath = null
    if (fs.existsSync(target)) {
      if (!overwrite) throw toolError(`输出已存在：${target}`, 409, 'BATCH_FILE_OUTPUT_EXISTS')
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw toolError(`解压输出类型冲突：${target}`, 409, 'ARCHIVE_OUTPUT_CONFLICT')
      }
      backupPath = tempSibling(target, '.bak')
      fs.renameSync(target, backupPath)
      backups.push({ target, backupPath })
    }
    publishTempFile(tempPath, target, { overwrite: false })
    published.push({ target, backupPath })
  } catch (cause) {
    try { fs.unlinkSync(tempPath) } catch { /* best effort */ }
    if (signal?.aborted) throwIfAborted(signal)
    throw cause
  }
}

function rollbackArchiveExtract({ published, backups, createdDirectories }) {
  const failures = []
  for (const item of [...published].reverse()) {
    if (!fs.existsSync(item.target)) continue
    try {
      fs.unlinkSync(item.target)
    } catch (cause) {
      failures.push(`撤回已解压文件失败 ${item.target}：${cause?.message || '文件系统错误'}`)
    }
  }
  for (const backup of [...backups].reverse()) {
    if (!fs.existsSync(backup.backupPath)) {
      failures.push(`恢复被覆盖文件失败：找不到备份 ${backup.backupPath}`)
      continue
    }
    if (fs.existsSync(backup.target)) {
      failures.push(`恢复被覆盖文件失败：目标仍存在 ${backup.target}`)
      continue
    }
    try {
      fs.renameSync(backup.backupPath, backup.target)
    } catch (cause) {
      failures.push(`恢复被覆盖文件失败 ${backup.target}：${cause?.message || '文件系统错误'}`)
    }
  }
  for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(directory)
    } catch (cause) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(cause?.code)) {
        failures.push(`清理解压目录失败 ${directory}：${cause?.message || '文件系统错误'}`)
      }
    }
  }
  return failures
}

function archiveRecoveryPaths({ published, backups, createdDirectories }) {
  const paths = new Set()
  for (const item of published) {
    if (!item.backupPath && fs.existsSync(item.target)) paths.add(item.target)
  }
  for (const backup of backups) {
    if (!fs.existsSync(backup.backupPath)) continue
    paths.add(backup.backupPath)
    if (fs.existsSync(backup.target)) paths.add(backup.target)
  }
  for (const directory of createdDirectories) {
    if (fs.existsSync(directory)) paths.add(directory)
  }
  return [...paths]
}

async function archiveExtractResolved(input, args, context) {
  const archive = input.format === 'rar'
    ? await parseRarHeaders(input, context.signal)
    : parseZipCentralDirectory(input.fullPath)
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `gugo-${input.format}-extract-`))
  const overwrite = args.overwrite === true
  const backups = []
  const published = []
  const createdDirectories = new Set()
  try {
    const resolved = resolveExtractionTargets(args.outputDir || args.output, archive.entries, {
      userId: context.userId,
      overwrite,
    })
    if (input.format === 'rar') {
      await extractRarToStage(input.fullPath, archive, stageRoot, context.signal)
    } else {
      await extractZipToStage(input.fullPath, archive, stageRoot, context.signal)
    }
    ensureArchiveDirectory(resolved.outputRoot.fullPath, createdDirectories)
    for (const target of resolved.targets.filter((item) => item.entry.directory)
      .sort((a, b) => a.entry.name.length - b.entry.name.length)) {
      ensureArchiveDirectory(target.fullPath, createdDirectories)
    }
    for (const target of resolved.targets.filter((item) => !item.entry.directory)) {
      throwIfAborted(context.signal)
      ensureArchiveDirectory(path.dirname(target.fullPath), createdDirectories)
      const source = path.join(stageRoot, ...target.entry.name.split('/'))
      await copyFileAtomically(source, target.fullPath, {
        overwrite,
        signal: context.signal,
        backups,
        published,
      })
    }
    const cleanupWarnings = []
    for (const backup of backups) {
      try { fs.rmSync(backup.backupPath, { recursive: true, force: true }) } catch (cause) {
        cleanupWarnings.push(`未能清理解压备份 ${backup.backupPath}：${cause?.message || '文件系统错误'}`)
      }
    }
    return {
      ok: true,
      format: input.format,
      input: input.displayPath,
      path: resolved.outputRoot.displayPath,
      outputDir: resolved.outputRoot.displayPath,
      scope: resolved.outputRoot.source,
      changedPaths: resolved.targets.map((target) => target.displayPath),
      entryCount: archive.entries.length,
      totalBytes: archive.totalSize,
      entries: resolved.targets.map((target) => ({
        path: target.entry.name,
        type: target.entry.directory ? 'directory' : 'file',
        size: target.entry.uncompressedSize,
        outputPath: target.displayPath,
      })),
      ...(cleanupWarnings.length ? { cleanupWarnings } : {}),
    }
  } catch (cause) {
    const rollbackFailures = rollbackArchiveExtract({ published, backups, createdDirectories })
    const recoveryPaths = archiveRecoveryPaths({ published, backups, createdDirectories })
    if (cause && typeof cause === 'object') Object.assign(cause, { rollbackFailures, recoveryPaths })
    throw cause
  } finally {
    archive.close()
    try { fs.rmSync(stageRoot, { recursive: true, force: true }) } catch { /* owned temp directory */ }
  }
}

async function archiveExtract(args, context) {
  const input = resolveArchiveInput(args, context)
  if (input.format === 'rar') {
    return withRarOperation(() => archiveExtractResolved(input, args, context), context.signal)
  }
  return archiveExtractResolved(input, args, context)
}

function collectManifestFiles(rawInputs, { userId = null, recursive = true } = {}) {
  if (!Array.isArray(rawInputs) || !rawInputs.length) {
    throw toolError('file_hash_manifest 需要非空 inputs 数组', 400, 'HASH_INPUTS_REQUIRED')
  }
  const files = new Map()
  const visit = (fullPath) => {
    const stat = fs.lstatSync(fullPath)
    assertRegularOrDirectory(fullPath, stat, fullPath)
    if (stat.isFile()) {
      const resolved = resolveForFileTool(fullPath, { userId })
      files.set(pathKey(resolved.fullPath), { resolved, stat })
      if (files.size > maxEntries()) throw toolError('待计算哈希的文件数量超过配置上限', 413, 'BATCH_FILE_TOO_MANY_ENTRIES')
      return
    }
    if (!recursive) return
    for (const child of fs.readdirSync(fullPath).sort()) visit(path.join(fullPath, child))
  }
  rawInputs.forEach((rawPath, index) => {
    const resolved = resolveForFileTool(requireString(rawPath, `inputs[${index}]`), { userId })
    visit(resolved.fullPath)
  })
  return [...files.values()].sort((a, b) => a.resolved.displayPath.localeCompare(b.resolved.displayPath))
}

async function sha256File(file, signal) {
  const before = fs.statSync(file.resolved.fullPath)
  const hash = crypto.createHash('sha256')
  let size = 0
  for await (const chunk of fs.createReadStream(file.resolved.fullPath)) {
    throwIfAborted(signal)
    hash.update(chunk)
    size += chunk.length
  }
  const after = fs.statSync(file.resolved.fullPath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size) {
    throw toolError(`计算哈希时文件发生变化：${file.resolved.displayPath}`, 409, 'HASH_SOURCE_CHANGED')
  }
  return {
    path: file.resolved.displayPath,
    scope: file.resolved.source,
    size,
    modifiedAt: Math.round(after.mtimeMs),
    sha256: hash.digest('hex'),
  }
}

async function fileHashManifest(args, context) {
  const files = collectManifestFiles(args.inputs, { userId: context.userId, recursive: args.recursive !== false })
  const manifest = []
  for (const file of files) manifest.push(await sha256File(file, context.signal))
  const groups = new Map()
  for (const item of manifest) {
    const key = `${item.size}:${item.sha256}`
    const group = groups.get(key) || []
    group.push(item.path)
    groups.set(key, group)
  }
  const duplicates = [...groups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([key, paths]) => {
      const separator = key.indexOf(':')
      return { size: Number(key.slice(0, separator)), sha256: key.slice(separator + 1), paths }
    })
  return {
    ok: true,
    algorithm: 'sha256',
    fileCount: manifest.length,
    totalBytes: manifest.reduce((sum, item) => sum + item.size, 0),
    files: manifest,
    duplicates,
  }
}

export async function dispatchBatchFileTool(name, args = {}, { userId = null, signal = null } = {}) {
  const context = { userId, signal }
  switch (name) {
    case 'archive_create': return archiveCreate(args, context)
    case 'archive_list': return archiveList(args, context)
    case 'archive_extract': return archiveExtract(args, context)
    case 'batch_rename': return batchRename(args, context)
    case 'file_hash_manifest': return fileHashManifest(args, context)
    default: throw toolError(`未知批量文件工具：${name}`, 404, 'BATCH_FILE_TOOL_NOT_FOUND')
  }
}

export const BATCH_FILE_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'archive_create',
      description: 'Create a ZIP archive with streaming compression. Inputs may assign safe archive paths. ZIP64 and RAR creation are unsupported; outputs never overwrite by default.',
      parameters: {
        type: 'object',
        properties: {
          inputs: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: { path: { type: 'string' }, archivePath: { type: 'string' } },
                  required: ['path'],
                },
              ],
            },
          },
          output: { type: 'string' },
          format: { type: 'string', enum: ['zip'] },
          compressionLevel: { type: 'integer', minimum: 0, maximum: 9 },
          overwrite: { type: 'boolean' },
        },
        required: ['inputs', 'output'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'archive_list',
      description: 'List ZIP or RAR entries without extracting or writing files. Validates safe paths, entry count, total expanded size, compression ratio, encryption, unsafe entry types, and file/directory conflicts. ZIP64, encrypted archives, and multi-volume archives are unsupported.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          format: { type: 'string', enum: ['zip', 'rar'] },
        },
        required: ['input'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'archive_extract',
      description: 'Safely extract ZIP or RAR archives through a private staging directory with size checks, path traversal and link rejection, zip-bomb limits, atomic publication, whole-batch rollback, cancellation, and no overwrite by default. Encrypted and multi-volume archives are unsupported.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          outputDir: { type: 'string' },
          format: { type: 'string', enum: ['zip', 'rar'] },
          overwrite: { type: 'boolean' },
        },
        required: ['input', 'outputDir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_rename',
      description: 'Rename regular files or whole directories as one two-stage operation, including swaps and cycles. A selected directory moves recursively; do not separately select any descendant in the same batch. Rejects source/destination tree overlaps and cross-device moves, rolls back failures when possible, and never overwrites unrelated paths by default.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
            },
          },
          overwrite: { type: 'boolean' },
        },
        required: ['operations'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_hash_manifest',
      description: 'Stream files through SHA-256 to produce a manifest and exact duplicate groups without loading large files into memory.',
      parameters: {
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { type: 'string' } },
          recursive: { type: 'boolean', description: 'Recurse into input directories. Defaults true.' },
        },
        required: ['inputs'],
      },
    },
  },
]

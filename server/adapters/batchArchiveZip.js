import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw } from 'node:zlib'
import {
  assertRegularOrDirectory,
  maxEntries,
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

export {
  archiveCreate,
  assertNoArchivePathConflicts,
  checkedExtractionTransform,
  normalizeArchivePath,
  runPipeline,
  updateCrc32,
}

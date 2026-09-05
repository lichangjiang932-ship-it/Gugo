import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import { createExtractorFromFile } from 'node-unrar-js'
import {
  maxExtractedBytes,
  publishTempFile,
  requireString,
  tempSibling,
  throwIfAborted,
  toolError,
} from './batchFileSupport.js'
import {
  checkedExtractionTransform,
  normalizeArchivePath,
  runPipeline,
  updateCrc32,
} from './batchArchiveZip.js'
import {
  closeRarExtractor,
  decodeZipName,
  parseRarHeaders,
  parseZipCentralDirectory,
  readExactly,
  resolveArchiveInput,
  translateRarError,
  withRarOperation,
} from './batchArchiveCatalog.js'
import { resolveForFileTool } from './fsShellTools.js'

const ZIP_LOCAL_SIGNATURE = 0x04034b50

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

function validateRarExtraction({ result, archive, stageRoot, statesByRawName, seenByRawName, signal }) {
  const entriesByRawName = new Map(archive.entries.map((entry) => [entry.rawName, entry]))
  for (const extracted of result.files) {
    throwIfAborted(signal)
    const rawName = String(extracted.fileHeader?.name || '')
    const entry = entriesByRawName.get(rawName)
    if (!entry || Boolean(extracted.fileHeader?.flags?.directory) !== entry.directory) {
      throw toolError(`RAR 解压返回了未请求的条目：${rawName}`, 422, 'ARCHIVE_HEADER_MISMATCH')
    }
    seenByRawName.set(rawName, (seenByRawName.get(rawName) || 0) + 1)
  }
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
    if (stat.size === entry.uncompressedSize
      && state.actualSize === entry.uncompressedSize
      && actualCrc32 === entry.crc32) continue
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
    if (writeViolation) throw writeViolation
    validateRarExtraction({
      result,
      archive,
      stageRoot,
      statesByRawName,
      seenByRawName,
      signal,
    })
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

export { archiveExtract }

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  outputByteLimit,
  pdfError,
  throwIfPdfAborted,
} from './pdfToolSupport.js'

function normalizePathKey(value) {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function assertOutputSize(bytes, displayPath) {
  const size = bytes.byteLength
  const maxBytes = outputByteLimit()
  if (size > maxBytes) {
    throw pdfError(
      `PDF output is too large (${size} bytes; limit ${maxBytes}): ${displayPath}`,
      413,
      'PDF_OUTPUT_TOO_LARGE',
      { size, maxBytes, path: displayPath },
    )
  }
  return size
}

function temporaryOutputSibling(fullPath, suffix) {
  return path.join(
    path.dirname(fullPath),
    `.${path.basename(fullPath)}.${process.pid}.${crypto.randomUUID()}${suffix}`,
  )
}

function stageOutput(output, bytes, signal) {
  throwIfPdfAborted(signal)
  fs.mkdirSync(path.dirname(output.fullPath), { recursive: true })
  const tempPath = temporaryOutputSibling(output.fullPath, '.tmp')
  let descriptor
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    throwIfPdfAborted(signal)
    fs.closeSync(descriptor)
    descriptor = undefined
    return tempPath
  } catch (cause) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* best effort cleanup */ }
    }
    try { fs.unlinkSync(tempPath) } catch { /* best effort cleanup */ }
    if (cause?.code === 'ABORT_ERR') throw cause
    throwIfPdfAborted(signal)
    throw pdfError(`Unable to stage PDF output: ${output.path}`, 500, 'PDF_OUTPUT_WRITE_FAILED', { cause })
  }
}

function rollbackPublishedOutputs({ published, backups }) {
  const failures = []
  for (const item of [...published].reverse()) {
    if (!fs.existsSync(item.output.fullPath)) continue
    try { fs.unlinkSync(item.output.fullPath) } catch (cause) {
      failures.push(`Unable to remove published PDF ${item.output.path}: ${cause?.message || 'filesystem error'}`)
    }
  }
  for (const backup of [...backups].reverse()) {
    if (!fs.existsSync(backup.backupPath)) {
      failures.push(`Unable to restore PDF ${backup.output.path}: backup is missing`)
      continue
    }
    if (fs.existsSync(backup.output.fullPath)) {
      failures.push(`Unable to restore PDF ${backup.output.path}: output still exists`)
      continue
    }
    try { fs.renameSync(backup.backupPath, backup.output.fullPath) } catch (cause) {
      failures.push(`Unable to restore PDF ${backup.output.path}: ${cause?.message || 'filesystem error'}`)
    }
  }
  return failures
}

function outputRecoveryPaths({ published, backups }) {
  const paths = new Set()
  const backedUpOutputs = new Set(backups.map((backup) => normalizePathKey(backup.output.fullPath)))
  for (const item of published) {
    if (!backedUpOutputs.has(normalizePathKey(item.output.fullPath)) && fs.existsSync(item.output.fullPath)) {
      paths.add(item.output.fullPath)
    }
  }
  for (const backup of backups) {
    if (!fs.existsSync(backup.backupPath)) continue
    paths.add(backup.backupPath)
    if (fs.existsSync(backup.output.fullPath)) paths.add(backup.output.fullPath)
  }
  return [...paths]
}

function writeOutputsAtomically(items, { overwrite = false, signal = null } = {}) {
  throwIfPdfAborted(signal)
  const seen = new Set()
  for (const item of items) {
    throwIfPdfAborted(signal)
    const key = normalizePathKey(item.output.fullPath)
    if (seen.has(key)) {
      throw pdfError(`Duplicate PDF output path: ${item.output.path}`, 400, 'PDF_DUPLICATE_OUTPUT')
    }
    seen.add(key)
    assertOutputSize(item.bytes, item.output.path)
  }

  const staged = []
  try {
    for (const item of items) {
      staged.push({ ...item, tempPath: stageOutput(item.output, item.bytes, signal) })
    }
    throwIfPdfAborted(signal)
  } catch (cause) {
    for (const item of staged) {
      try { fs.unlinkSync(item.tempPath) } catch { /* best effort cleanup */ }
    }
    throw cause
  }
  const published = []
  const backups = []
  try {
    for (const item of staged) {
      throwIfPdfAborted(signal)
      if (overwrite) {
        if (fs.existsSync(item.output.fullPath)) {
          if (!fs.statSync(item.output.fullPath).isFile()) {
            throw pdfError(`PDF output is not a file path: ${item.output.path}`, 400, 'PDF_OUTPUT_NOT_FILE')
          }
          const backupPath = temporaryOutputSibling(item.output.fullPath, '.bak')
          fs.renameSync(item.output.fullPath, backupPath)
          backups.push({ output: item.output, backupPath })
          throwIfPdfAborted(signal)
        }
        fs.renameSync(item.tempPath, item.output.fullPath)
        published.push(item)
      } else {
        // Linking a fully written sibling temp file publishes it atomically and
        // fails with EEXIST instead of racing into an accidental overwrite.
        fs.linkSync(item.tempPath, item.output.fullPath)
        published.push(item)
        fs.unlinkSync(item.tempPath)
      }
      throwIfPdfAborted(signal)
    }
  } catch (cause) {
    const rollbackFailures = rollbackPublishedOutputs({ published, backups })
    const recoveryPaths = outputRecoveryPaths({ published, backups })
    if (cause?.code === 'ABORT_ERR') {
      Object.assign(cause, { rollbackFailures, recoveryPaths })
      throw cause
    }
    const failed = staged.find((item) => fs.existsSync(item.tempPath)) || staged[published.length]
    if (String(cause?.code || '').startsWith('PDF_')) {
      Object.assign(cause, { rollbackFailures, recoveryPaths })
      throw cause
    }
    throw pdfError(
      `Unable to publish PDF output atomically: ${failed?.output?.path || 'unknown output'}`,
      cause?.code === 'EEXIST' ? 409 : 500,
      cause?.code === 'EEXIST' ? 'PDF_OUTPUT_EXISTS' : 'PDF_OUTPUT_WRITE_FAILED',
      { cause, rollbackFailures, recoveryPaths },
    )
  } finally {
    for (const item of staged) {
      try { fs.unlinkSync(item.tempPath) } catch { /* already moved or best effort cleanup */ }
    }
  }

  for (const backup of backups) {
    try { fs.unlinkSync(backup.backupPath) } catch { /* output is committed; preserve best-effort backup */ }
  }

  return staged.map((item) => ({
    path: item.output.path,
    scope: item.output.scope,
    size: item.bytes.byteLength,
    ...(item.pageCount == null ? {} : { pageCount: item.pageCount }),
    ...(item.pages == null ? {} : { pages: item.pages }),
  }))
}

export { writeOutputsAtomically }

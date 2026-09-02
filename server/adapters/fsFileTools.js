import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { writeLimiter } from '../utils/rateLimiter.js'
import { checkWorkspaceSize } from '../utils/workspaceSize.js'
import {
  extractManagedAttachmentContent,
  extractOfficeBufferContent,
  extractPdfBufferContent,
} from '../services/managedAttachmentContent.js'
import { validateGeneratedArtifactFile } from '../services/generatedArtifactFormatValidation.js'
import {
  MAX_FILE_BYTES,
  assertToolPermitted,
  badReq,
  effectivePermissionToolName,
  getWorkspaceRoot,
  mapWriteError,
  resolveForFileTool,
} from './fsShellSupport.js'

export async function readFileTool({ path: rawPath, offset = 0, limit = 0, userId = null }) {
  const resolved = resolveForFileTool(rawPath, { userId })
  const full = resolved.fullPath
  const stat = fs.statSync(full)
  if (stat.isDirectory()) throw badReq('路径是目录,不是文件', 400)
  if (resolved.source === 'attachment') {
    const extracted = await extractManagedAttachmentContent({ userId, id: resolved.attachmentId })
    const all = extracted.text
    const lines = all.split('\n')
    const o = Math.max(0, Math.floor(Number(offset) || 0))
    const l = Math.max(0, Math.floor(Number(limit) || 0))
    const slice = l > 0 ? lines.slice(o, o + l) : lines.slice(o)
    return {
      ok: true,
      path: resolved.displayPath,
      scope: resolved.source,
      size: stat.size,
      mimeType: resolved.attachment.mimeType,
      sha256: resolved.attachment.sha256,
      extractionStatus: extracted.extractionStatus,
      requiresVision: extracted.requiresVision,
      truncated: extracted.truncated,
      totalLines: lines.length,
      offset: o,
      returnedLines: slice.length,
      content: slice.join('\n'),
    }
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw badReq(`文件过大(${stat.size} 字节,上限 ${MAX_FILE_BYTES})`, 413)
  }
  const buffer = fs.readFileSync(full)
  const extension = path.extname(full).toLowerCase()
  const isPdf = extension === '.pdf'
    || buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  const isOffice = ['.docx', '.pptx', '.xlsx'].includes(extension)
  const extracted = isPdf
    ? extractPdfBufferContent(buffer)
    : isOffice
      ? await extractOfficeBufferContent({ buffer, filename: path.basename(full) })
      : null
  let formatValidated = null
  let formatValidationCode = null
  if (isOffice) {
    try {
      await validateGeneratedArtifactFile({
        filePath: full,
        filename: path.basename(full),
        artifactType: extension.slice(1),
      })
      formatValidated = true
    } catch (error) {
      formatValidated = false
      formatValidationCode = String(error?.code || 'ARTIFACT_FORMAT_INVALID').slice(0, 120)
    }
  }
  const all = isPdf
    ? extracted.text || '[PDF 文件未提取到可读文本；文件可能是扫描件或使用了压缩/自定义字体。]'
    : isOffice
      ? extracted.text || '[Office 文件未提取到可读文本，或文件结构无效。]'
      : buffer.toString('utf8')
  const lines = all.split('\n')
  const o = Math.max(0, Math.floor(Number(offset) || 0))
  const l = Math.max(0, Math.floor(Number(limit) || 0))
  const slice = l > 0 ? lines.slice(o, o + l) : lines.slice(o)
  return {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    size: stat.size,
    ...((isPdf || isOffice) ? {
      mimeType: extracted.mimeType,
      extractionStatus: extracted.extractionStatus,
      requiresVision: extracted.requiresVision,
    } : {}),
    ...(isOffice ? {
      formatValidated,
      ...(formatValidationCode ? { formatValidationCode } : {}),
    } : {}),
    totalLines: lines.length,
    offset: o,
    returnedLines: slice.length,
    content: slice.join('\n'),
  }
}

export async function listDirectoryTool({ path: rawPath, limit = 200, userId = null }) {
  const resolved = resolveForFileTool(rawPath, { userId })
  const full = resolved.fullPath
  const stat = fs.statSync(full)
  if (!stat.isDirectory()) throw badReq('路径不是文件夹', 400)
  const maxEntries = Math.min(Math.max(Number(limit) || 200, 1), 500)
  const allEntries = fs.readdirSync(full, { withFileTypes: true })
    .map((entry) => {
      const entryPath = path.join(full, entry.name)
      let entryStat = null
      try { entryStat = fs.statSync(entryPath) } catch { /* inaccessible entry */ }
      return {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        size: entryStat?.isFile() ? entryStat.size : null,
        modifiedAt: entryStat?.mtimeMs ? Math.round(entryStat.mtimeMs) : null,
      }
    })
    .sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name)
      if (a.type === 'directory') return -1
      if (b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })
  return {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    total: allEntries.length,
    truncated: allEntries.length > maxEntries,
    entries: allEntries.slice(0, maxEntries),
  }
}

function contentLineCount(value) {
  const text = String(value || '')
  if (!text) return 0
  const lines = text.split(/\r?\n/u).length
  return lines - (/\r?\n$/u.test(text) ? 1 : 0)
}

function contentLines(value) {
  const text = String(value || '')
  if (!text) return []
  const lines = text.split(/\r?\n/u)
  if (/\r?\n$/u.test(text)) lines.pop()
  return lines
}

function lineChangeStats(previous, next) {
  const before = contentLines(previous)
  const after = contentLines(next)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  const left = before.slice(start, beforeEnd)
  const right = after.slice(start, afterEnd)
  const n = left.length
  const m = right.length
  if (n === 0 || m === 0) return { additions: m, deletions: n }

  const max = n + m
  const maxDistance = Math.min(max, 4096)
  const offset = maxDistance + 1
  const frontier = new Int32Array((maxDistance * 2) + 3)
  frontier.fill(-1)
  frontier[offset + 1] = 0
  for (let distance = 0; distance <= maxDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal
      let x
      if (diagonal === -distance
        || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])) {
        x = frontier[index + 1]
      } else {
        x = frontier[index - 1] + 1
      }
      let y = x - diagonal
      while (x < n && y < m && left[x] === right[y]) {
        x += 1
        y += 1
      }
      frontier[index] = x
      if (x >= n && y >= m) {
        return {
          additions: (distance - n + m) / 2,
          deletions: (distance + n - m) / 2,
        }
      }
    }
  }
  return { additions: m, deletions: n }
}

export async function writeFileTool(
  { path: rawPath, content, userId = null },
  {
    permissionToolName = 'write_file',
    idempotentResume = false,
    sideEffectRecoveryPlan = null,
  } = {},
) {
  assertToolPermitted(userId, effectivePermissionToolName(permissionToolName, 'write_file'))
  if (typeof content !== 'string') throw badReq('content 必须是字符串')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_FILE_BYTES) {
    throw badReq(`内容过大(${bytes} 字节,上限 ${MAX_FILE_BYTES})`, 413)
  }
  const resolved = resolveForFileTool(rawPath, { userId, write: true, allowMissing: true })
  const full = resolved.fullPath
  const expectedSha256 = createHash('sha256').update(content, 'utf8').digest('hex')
  let previousContent = null
  let previousContentKnown = false
  let observedBefore = { known: false }
  try {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const previousBytes = fs.readFileSync(full)
      previousContent = previousBytes.toString('utf8')
      observedBefore = {
        known: true,
        exists: true,
        type: 'file',
        bytes: previousBytes.byteLength,
        sha256: createHash('sha256').update(previousBytes).digest('hex'),
      }
    } else if (fs.existsSync(full)) {
      const stat = fs.statSync(full)
      observedBefore = {
        known: true,
        exists: true,
        type: stat.isDirectory() ? 'directory' : 'other',
      }
    } else {
      observedBefore = { known: true, exists: false }
    }
    previousContentKnown = true
  } catch {
    // Progress metadata must not turn a permitted write into a failure.
  }
  const changed = !previousContentKnown || previousContent !== content
  const changes = previousContentKnown ? [{
    path: resolved.displayPath,
    ...(previousContent == null
      ? { additions: contentLineCount(content), deletions: 0 }
      : lineChangeStats(previousContent, content)),
  }] : []
  const outcome = {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    bytes,
    sha256: expectedSha256,
    changed,
    changedPaths: changed ? [resolved.displayPath] : [],
    changes,
  }
  const unknownRecoveryResult = (observed = observedBefore) => ({
    ok: false,
    code: 'WRITE_FILE_OUTCOME_UNKNOWN',
    error: 'The service restarted after write_file crossed its mutation boundary, but the current target cannot prove the persisted write outcome. It was not written again.',
    retryable: false,
    requiresUserVerification: true,
    path: resolved.displayPath,
    scope: resolved.source,
    expectedSha256,
    ...(observed?.known && observed?.exists && observed?.type === 'file' && observed?.sha256
      ? { observedSha256: observed.sha256 }
      : {}),
  })
  if (idempotentResume === true) {
    if (!sideEffectRecoveryPlan || typeof sideEffectRecoveryPlan.read !== 'function') {
      return unknownRecoveryResult()
    }
    const plan = await sideEffectRecoveryPlan.read()
    const plannedPath = String(plan?.target?.fullPath || '')
    const sameTarget = process.platform === 'win32'
      ? path.normalize(plannedPath).toLowerCase() === path.normalize(full).toLowerCase()
      : path.normalize(plannedPath) === path.normalize(full)
    const validPlan = plan?.version === 1
      && plan?.kind === 'local-file-write'
      && sameTarget
      && plan?.after?.exists === true
      && plan?.after?.type === 'file'
      && Number(plan?.after?.bytes) === bytes
      && plan?.after?.sha256 === expectedSha256
      && plan?.outcome
      && typeof plan.outcome === 'object'
      && plan.outcome.sha256 === expectedSha256
    if (validPlan
      && observedBefore.known === true
      && observedBefore.exists === true
      && observedBefore.type === 'file'
      && observedBefore.bytes === bytes
      && observedBefore.sha256 === expectedSha256) {
      return { ...plan.outcome, idempotencyRecovered: true }
    }
    return unknownRecoveryResult()
  }
  if (sideEffectRecoveryPlan && typeof sideEffectRecoveryPlan.prepare === 'function') {
    await sideEffectRecoveryPlan.prepare({
      version: 1,
      kind: 'local-file-write',
      target: {
        fullPath: full,
        displayPath: resolved.displayPath,
        scope: resolved.source,
      },
      before: observedBefore,
      after: {
        exists: true,
        type: 'file',
        bytes,
        sha256: expectedSha256,
      },
      outcome,
    })
  }
  if (userId && !writeLimiter.tryConsume(userId, 'write')) {
    throw badReq('写文件限流:超过 120 次/分钟', 429)
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  } catch (error) {
    throw mapWriteError(error, full)
  }
  if (resolved.source === 'workspace') {
    try { checkWorkspaceSize(getWorkspaceRoot()) } catch { /* 巡检失败不影响写入 */ }
  }
  return outcome
}

export async function editFileTool({
  path: rawPath,
  old_string,
  new_string,
  replace_all = false,
  userId = null,
}, {
  permissionToolName = 'edit_file',
} = {}) {
  assertToolPermitted(userId, effectivePermissionToolName(permissionToolName, 'edit_file'))
  if (userId && !writeLimiter.tryConsume(userId, 'write')) {
    throw badReq('编辑限流:超过 120 次/分钟', 429)
  }
  if (typeof old_string !== 'string' || old_string.length === 0) {
    throw badReq('old_string 必填且不能为空')
  }
  if (typeof new_string !== 'string') throw badReq('new_string 必填')
  if (old_string === new_string) throw badReq('old_string 与 new_string 相同,没有改动')
  const resolved = resolveForFileTool(rawPath, { userId, write: true })
  const full = resolved.fullPath
  const stat = fs.statSync(full)
  if (stat.size > MAX_FILE_BYTES) {
    throw badReq(`文件过大(${stat.size} 字节,上限 ${MAX_FILE_BYTES})`, 413)
  }
  const orig = fs.readFileSync(full, 'utf8')
  let next
  let replacedCount
  if (replace_all) {
    const parts = orig.split(old_string)
    replacedCount = parts.length - 1
    if (replacedCount === 0) throw badReq('old_string 在文件里未找到')
    next = parts.join(new_string)
  } else {
    const idx = orig.indexOf(old_string)
    if (idx === -1) throw badReq('old_string 在文件里未找到')
    const second = orig.indexOf(old_string, idx + old_string.length)
    if (second !== -1) {
      throw badReq('old_string 在文件里出现多次,请加上下文使其唯一,或传 replace_all:true')
    }
    next = orig.slice(0, idx) + new_string + orig.slice(idx + old_string.length)
    replacedCount = 1
  }
  try {
    fs.writeFileSync(full, next, 'utf8')
  } catch (error) {
    throw mapWriteError(error, full)
  }
  const nextBytes = Buffer.from(next, 'utf8')
  return {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    replacedCount,
    bytes: nextBytes.byteLength,
    sha256: createHash('sha256').update(nextBytes).digest('hex'),
    deltaBytes: Buffer.byteLength(next, 'utf8') - Buffer.byteLength(orig, 'utf8'),
    changes: [{ path: resolved.displayPath, ...lineChangeStats(orig, next) }],
  }
}

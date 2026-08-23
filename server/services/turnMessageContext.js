import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeModelUsage } from '../../shared/modelUsage.js'
import { TRUNCATED_TOOL_RESULT_METADATA_KEY } from '../utils/toolCallHarness.js'
import { resolveAuthorizedLocalPath } from './localFileAccessService.js'

const MAX_TOOL_CALLS_PER_GROUP = 8
// Historical tool arguments are audit/context hints, not an artifact source
// store. Successful artifact calls are reduced to references below; other
// calls retain a bounded preview so repeated turns cannot multiply large file
// bodies, commands, or payloads indefinitely.
const MAX_TOOL_ARGUMENT_CHARS = 12_000
const MAX_TOOL_RESULT_CHARS = 8_000
const MAX_TURN_TOOL_CONTEXT_CHARS = 96_000
const MAX_SESSION_TOOL_CONTEXT_CHARS = 128_000
const SOURCE_BEARING_ARTIFACT_TOOLS = new Set([
  'create_docx',
  'create_html_app',
  'create_pdf',
  'create_pptx',
  'create_xlsx',
  'generate_image',
  'render_pdf_pages',
])
const ARTIFACT_TYPE_BY_TOOL = Object.freeze({
  create_docx: 'docx',
  create_html_app: 'html',
  create_pdf: 'pdf',
  create_pptx: 'pptx',
  create_xlsx: 'xlsx',
  generate_image: 'image',
  render_pdf_pages: 'image',
})
const MAX_TOOL_GROUPS_PER_TURN = 16
const MAX_MANAGED_ATTACHMENTS_PER_MESSAGE = 32
const MAX_HISTORICAL_ATTACHMENTS_PER_REQUEST = 4
const STORED_MESSAGE_SOURCE_ID = Symbol('gugoStoredMessageSourceId')
const HISTORICAL_ATTACHMENT_REFERENCE_PATTERN = /(?:attachment:\/\/|(?:刚才|之前|上次|前面|同一|同一个|那个|那张|这张|这份|上一张|原来).{0,16}(?:附件|图片|图像|照片|截图|图表|文件|文档|pdf)|(?:附件|图片|图像|照片|截图|图表|文档|pdf).{0,16}(?:重新|再|继续).{0,8}(?:看|读|分析|检查|查看)|(?:same|previous|earlier|that|the\s+attached)\s+(?:attachment|image|photo|screenshot|diagram|file|document|pdf)|(?:re-?inspect|re-?read|look\s+again\s+at).{0,24}(?:attachment|image|photo|file|document|pdf))/i
const LOCAL_FILE_MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_command',
])
const COMMAND_MUTATION_TOOLS = new Set(['bash_exec', 'run_command'])
const MAX_VERIFIED_LOCAL_FILES = 64

function workspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd())
}

function isInsidePath(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function canonicalLocalPath(value) {
  const normalized = path.normalize(String(value || ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function resolveVerifiedLocalPath(rawPath, { userId, resolvePath }) {
  const raw = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!raw) return null
  try {
    const resolved = resolvePath({
      userId,
      rawPath: raw,
      write: false,
      allowWorkspace: true,
    })
    const resolvedFullPath = typeof resolved?.fullPath === 'string' ? resolved.fullPath.trim() : ''
    if (!resolvedFullPath || !path.isAbsolute(resolvedFullPath)) return null
    const fullPath = path.normalize(resolvedFullPath)

    // Relative tool paths are workspace-relative by contract. Keep that
    // boundary even when approval bypass is enabled, otherwise ../outside
    // or a workspace symlink could silently turn into a trusted receipt.
    if (!path.isAbsolute(raw)) {
      let root = workspaceRoot()
      // Match localFileAccessService's canonical representation. On Windows,
      // mixing realpathSync.native() with realpathSync() can compare the long
      // temp path against its 8.3 alias (for example RUNNER~1) and reject a
      // file that is actually inside the authorized workspace.
      try { root = fs.realpathSync(root) } catch { root = path.resolve(root) }
      if (!isInsidePath(root, fullPath)) return null
    }
    return fullPath
  } catch {
    return null
  }
}

function localFileReceipt(fullPath, {
  statFile,
  verifiedAt,
  retainedAt,
  relatedArtifactIds = [],
}) {
  try {
    const stat = statFile(fullPath)
    if (!stat?.isFile?.()) return null
    const normalized = path.normalize(fullPath)
    const id = `local-file-${createHash('sha256').update(canonicalLocalPath(normalized)).digest('hex').slice(0, 24)}`
    const normalizedVerifiedAt = Number.isFinite(Number(verifiedAt))
      ? Math.max(0, Number(verifiedAt))
      : null
    const normalizedRetainedAt = Number.isFinite(Number(retainedAt))
      ? Math.max(0, Number(retainedAt))
      : null
    return {
      id,
      path: normalized,
      filename: path.basename(normalized),
      size: Math.max(0, Number(stat.size) || 0),
      ...(normalizedVerifiedAt !== null ? { verifiedAt: normalizedVerifiedAt } : {}),
      ...(normalizedRetainedAt !== null ? { retainedAt: normalizedRetainedAt } : {}),
      ...((Array.isArray(relatedArtifactIds) && relatedArtifactIds.length > 0)
        ? { relatedArtifactIds: [...new Set(relatedArtifactIds.map(String).filter(Boolean))] }
        : {}),
    }
  } catch {
    return null
  }
}

function toolCallParts(rawCall) {
  const id = String(rawCall?.id || '').trim()
  const name = String(rawCall?.function?.name || rawCall?.name || '').trim()
  const args = parsedObject(rawCall?.function?.arguments ?? rawCall?.argumentsText ?? rawCall?.args)
  return id && name ? { id, name, args: args || {} } : null
}

function retainedToolResultMetadata(result) {
  if (result?.truncated !== true || result?._truncated !== true) return null
  const metadata = result?.[TRUNCATED_TOOL_RESULT_METADATA_KEY]
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  return metadata.version === 1 ? metadata : null
}

function mutationResultPaths(call, result) {
  if (!LOCAL_FILE_MUTATION_TOOLS.has(call.name) || result?.ok !== true) return []
  const evidence = retainedToolResultMetadata(result) || result
  if (['apply_patch', 'patch_file'].includes(call.name)
    && (evidence.dry_run === true
      || evidence.dryRun === true
      || result.dry_run === true
      || result.dryRun === true
      || call.args?.dry_run === true)) return []

  const values = []
  if (Array.isArray(evidence.changedPaths)) values.push(...evidence.changedPaths)
  if (!COMMAND_MUTATION_TOOLS.has(call.name)) {
    if (typeof evidence.path === 'string') values.push(evidence.path)
    if (Array.isArray(evidence.changes)) {
      for (const change of evidence.changes) {
        if (call.name === 'apply_patch' && change?.op === 'delete') continue
        if (typeof change?.path === 'string') values.push(change.path)
      }
    }
    if ((call.name === 'write_file' || call.name === 'edit_file') && typeof call.args?.path === 'string') {
      values.push(call.args.path)
    }
  }
  return values
}

function completeReadEvidence(call, result) {
  if (call.name !== 'read_file' || result?.ok !== true) return null
  const retainedMetadata = retainedToolResultMetadata(result)
  const evidence = retainedMetadata || result
  if (retainedMetadata) {
    if (retainedMetadata.contentPresent !== true) return null
  } else if (typeof result.content !== 'string' || result.truncated === true) {
    return null
  }
  const offset = Number(evidence.offset ?? call.args?.offset ?? 0)
  return Number.isFinite(offset) && offset >= 0 ? evidence : null
}

function legacyReadEvidence(call, result) {
  if (call.name !== 'read_file' || result?.ok !== true) return null
  const retainedMetadata = retainedToolResultMetadata(result)
  const evidence = retainedMetadata || result
  if (retainedMetadata) {
    if (retainedMetadata.contentPresent !== true) return null
  } else if (typeof result.content !== 'string') {
    return null
  }
  const offset = Number(evidence.offset ?? call.args?.offset ?? 0)
  return Number.isFinite(offset) && offset === 0 ? evidence : null
}

function normalizedVerifiedLocalFiles(values) {
  const receipts = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const fullPath = typeof value?.path === 'string' ? path.normalize(value.path.trim()) : ''
    const id = String(value?.id || '').trim()
    const filename = String(value?.filename || path.basename(fullPath)).trim()
    if (!id || !fullPath || !path.isAbsolute(fullPath) || !filename) continue
    const key = canonicalLocalPath(fullPath)
    if (seen.has(key)) continue
    seen.add(key)
    receipts.push({
      id,
      path: fullPath,
      filename,
      ...(Number.isFinite(Number(value?.size)) ? { size: Math.max(0, Number(value.size)) } : {}),
      ...(Number.isFinite(Number(value?.verifiedAt))
        ? { verifiedAt: Math.max(0, Number(value.verifiedAt)) }
        : {}),
      ...(Array.isArray(value?.relatedArtifactIds) && value.relatedArtifactIds.length > 0
        ? { relatedArtifactIds: [...new Set(value.relatedArtifactIds.map(String).filter(Boolean))] }
        : {}),
    })
    if (receipts.length >= MAX_VERIFIED_LOCAL_FILES) break
  }
  return receipts
}

function normalizedRetainedLocalFiles(values) {
  const receipts = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const fullPath = typeof value?.path === 'string' ? path.normalize(value.path.trim()) : ''
    const id = String(value?.id || '').trim()
    const filename = String(value?.filename || path.basename(fullPath)).trim()
    if (!id || !fullPath || !path.isAbsolute(fullPath) || !filename) continue
    const key = canonicalLocalPath(fullPath)
    if (seen.has(key)) continue
    seen.add(key)
    receipts.push({
      id,
      path: fullPath,
      filename,
      ...(Number.isFinite(Number(value?.size)) ? { size: Math.max(0, Number(value.size)) } : {}),
      ...(Number.isFinite(Number(value?.retainedAt))
        ? { retainedAt: Math.max(0, Number(value.retainedAt)) }
        : {}),
      ...(Array.isArray(value?.relatedArtifactIds) && value.relatedArtifactIds.length > 0
        ? { relatedArtifactIds: [...new Set(value.relatedArtifactIds.map(String).filter(Boolean))] }
        : {}),
    })
    if (receipts.length >= MAX_VERIFIED_LOCAL_FILES) break
  }
  return receipts
}

function extractVerifiedLocalFilesWithReadEvidence(messages, {
  userId = null,
  baselineToolCallIds = new Set(),
  verifiedAt = Date.now(),
  resolvePath = resolveAuthorizedLocalPath,
  statFile = fs.statSync,
} = {}, readEvidenceForCall = completeReadEvidence) {
  const calls = new Map()
  const mutatedAt = new Map()
  const receipts = new Map()
  let sequence = 0

  for (const message of Array.isArray(messages) ? messages : []) {
    sequence += 1
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = toolCallParts(rawCall)
        if (!call || baselineToolCallIds.has(call.id)) continue
        calls.set(call.id, call)
      }
      continue
    }
    if (message?.role !== 'tool') continue
    const toolCallId = String(message.tool_call_id || message.toolCallId || '').trim()
    const call = calls.get(toolCallId)
    const result = parsedObject(message.content)
    if (!call || !result) continue
    const resultName = String(message.name || '').trim()
    if (resultName && resultName !== call.name) continue

    // Artifact generators validate their output before returning success and
    // may synchronously copy the finished file to an explicit/default local
    // directory. That concrete path is already stronger evidence than a
    // separate read_file sample, and must survive into the next turn so an
    // in-place follow-up can target the same file and directory.
    if (SOURCE_BEARING_ARTIFACT_TOOLS.has(call.name) && result.ok === true) {
      const candidates = Array.isArray(result.artifacts) && result.artifacts.length > 0
        ? result.artifacts
        : [result]
      for (const candidate of candidates) {
        const rawPath = String(
          candidate?.localPath || candidate?.outputPath || candidate?.path
          || result.localPath || result.outputPath || result.path || '',
        ).trim()
        const fullPath = resolveVerifiedLocalPath(rawPath, { userId, resolvePath })
        if (!fullPath) continue
        const relatedArtifactIds = [
          candidate?.id,
          candidate?.artifactId,
          result.artifactId,
        ].map((value) => String(value || '').trim()).filter(Boolean)
        const receipt = localFileReceipt(fullPath, {
          statFile,
          verifiedAt,
          relatedArtifactIds,
        })
        if (receipt) receipts.set(canonicalLocalPath(fullPath), receipt)
      }
      continue
    }

    if (LOCAL_FILE_MUTATION_TOOLS.has(call.name)) {
      for (const rawPath of mutationResultPaths(call, result)) {
        const fullPath = resolveVerifiedLocalPath(rawPath, { userId, resolvePath })
        if (!fullPath) continue
        const key = canonicalLocalPath(fullPath)
        mutatedAt.set(key, sequence)
        receipts.delete(key)
      }
      continue
    }
    const readEvidence = readEvidenceForCall(call, result)
    if (!readEvidence) continue
    for (const rawPath of [readEvidence.path, call.args?.path]) {
      const fullPath = resolveVerifiedLocalPath(rawPath, { userId, resolvePath })
      if (!fullPath) continue
      const key = canonicalLocalPath(fullPath)
      if (!mutatedAt.has(key) || mutatedAt.get(key) >= sequence) continue
      const receipt = localFileReceipt(fullPath, { statFile, verifiedAt })
      if (receipt) receipts.set(key, receipt)
      break
    }
  }

  return normalizedVerifiedLocalFiles([...receipts.values()].slice(-MAX_VERIFIED_LOCAL_FILES))
}

/**
 * Build lightweight link receipts only when a successful mutation is followed
 * by a successful read_file of the same authorized file. A bounded read is
 * enough to prove the tool reached the mutated path; opening the link still
 * re-authorizes and stats the current file. This avoids forcing an entire
 * large file into model context merely to make the result clickable.
 */
export function extractVerifiedLocalFiles(messages, options = {}) {
  return extractVerifiedLocalFilesWithReadEvidence(messages, options, completeReadEvidence)
}

/**
 * Build authorization-safe receipts for successful local mutations even when
 * the turn did not reach its independent readback/project verification step.
 * These receipts prove only that the mutation tool returned success and that
 * the resulting path still resolves to a readable file. They must never be
 * treated as completion or verification evidence.
 */
export function extractRetainedLocalFiles(messages, {
  userId = null,
  baselineToolCallIds = new Set(),
  retainedAt = Date.now(),
  resolvePath = resolveAuthorizedLocalPath,
  statFile = fs.statSync,
} = {}) {
  const calls = new Map()
  const receipts = new Map()

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const call = toolCallParts(rawCall)
        if (!call || baselineToolCallIds.has(call.id)) continue
        calls.set(call.id, call)
      }
      continue
    }
    if (message?.role !== 'tool') continue
    const toolCallId = String(message.tool_call_id || message.toolCallId || '').trim()
    const call = calls.get(toolCallId)
    const result = parsedObject(message.content)
    if (!call || !result) continue
    const resultName = String(message.name || '').trim()
    if (resultName && resultName !== call.name) continue

    for (const rawPath of mutationResultPaths(call, result)) {
      const fullPath = resolveVerifiedLocalPath(rawPath, { userId, resolvePath })
      if (!fullPath) continue
      const receipt = localFileReceipt(fullPath, { statFile, retainedAt })
      if (receipt) receipts.set(canonicalLocalPath(fullPath), receipt)
    }
  }

  return normalizedRetainedLocalFiles([...receipts.values()].slice(-MAX_VERIFIED_LOCAL_FILES))
}

/**
 * Compatibility for turns stored before verified receipts existed. A
 * successful mutation followed by an offset-zero read proves the trusted path
 * exists, even when that old turn sampled only the beginning of the file. This
 * is used only when the model context has no explicit verifiedLocalFiles field;
 * new turns retain the complete-read requirement above.
 */
export function recoverLegacyVerifiedLocalFiles(messages, options = {}) {
  return extractVerifiedLocalFilesWithReadEvidence(messages, options, legacyReadEvidence)
}

function tagStoredMessageSource(message, sourceId) {
  const id = String(sourceId || '').trim()
  if (!message || !id) return message
  Object.defineProperty(message, STORED_MESSAGE_SOURCE_ID, {
    value: id,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return message
}

export function storedMessageSourceId(message) {
  return String(message?.[STORED_MESSAGE_SOURCE_ID] || '').trim() || null
}

export function resolveStoredMessagesAfterCompaction(messages, boundary = null) {
  const source = Array.isArray(messages) ? messages : []
  const firstKeptMessageId = String(boundary?.firstKeptMessageId || '').trim()
  if (firstKeptMessageId) {
    const index = source.findIndex((message) => String(message?.id || '') === firstKeptMessageId)
    if (index >= 0) return { messages: source.slice(index), matched: true, boundary: 'first_kept' }
  }

  const lastCompactedMessageId = String(boundary?.lastCompactedMessageId || '').trim()
  if (lastCompactedMessageId) {
    const index = source.findIndex((message) => String(message?.id || '') === lastCompactedMessageId)
    if (index >= 0) return { messages: source.slice(index + 1), matched: true, boundary: 'last_compacted' }
  }

  // A stale canonical snapshot may no longer contain either exact compaction
  // boundary, while still containing the assistant message that references
  // the archive. Everything after that reference is newer than the archive
  // and must remain visible (most importantly, the active user request).
  const referenceMessageId = String(boundary?.referenceMessageId || '').trim()
  if (referenceMessageId) {
    const index = source.findIndex((message) => String(message?.id || '') === referenceMessageId)
    if (index >= 0) {
      return { messages: source.slice(index + 1), matched: false, boundary: 'archive_reference' }
    }
  }
  const referenceMessageIndex = Number(boundary?.referenceMessageIndex)
  if (Number.isInteger(referenceMessageIndex)
    && referenceMessageIndex >= 0
    && referenceMessageIndex < source.length) {
    return {
      messages: source.slice(referenceMessageIndex + 1),
      matched: false,
      boundary: 'archive_reference_index',
    }
  }
  const compacted = boundary?.compacted === true || Boolean(firstKeptMessageId || lastCompactedMessageId)
  return compacted
    ? { messages: [], matched: false, boundary: 'unmatched' }
    : { messages: source, matched: false, boundary: 'none' }
}

export function selectStoredMessagesAfterCompaction(messages, boundary = null) {
  return resolveStoredMessagesAfterCompaction(messages, boundary).messages
}

function jsonLength(value) {
  try { return JSON.stringify(value).length } catch { return Number.MAX_SAFE_INTEGER }
}

function truncatedArguments(text, limit) {
  const note = `[tool arguments truncated: ${text.length} chars total]`
  const build = (headChars, tailChars) => JSON.stringify({
    __truncated: true,
    originalChars: text.length,
    note,
    previewHead: text.slice(0, headChars),
    previewTail: tailChars > 0 ? text.slice(-tailChars) : '',
  })
  let tailChars = Math.min(8_000, Math.floor(limit / 4))
  let headChars = Math.max(0, limit - tailChars - 240)
  let summary = build(headChars, tailChars)
  // JSON escaping can make a preview longer than its raw slices. Scale both
  // previews down until the persisted representation itself obeys the cap.
  for (let attempt = 0; summary.length > limit && attempt < 12; attempt += 1) {
    const ratio = Math.max(0, Math.min(0.95, (limit - 240) / summary.length))
    headChars = Math.floor(headChars * ratio)
    tailChars = Math.floor(tailChars * ratio)
    summary = build(headChars, tailChars)
  }
  return summary.length <= limit ? summary : build(0, 0)
}

function boundedArguments(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {})
  if (text.length <= MAX_TOOL_ARGUMENT_CHARS) return text
  return truncatedArguments(text, MAX_TOOL_ARGUMENT_CHARS)
}

function parsedObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value ?? ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function boundedToolResult(value, toolName = '') {
  if (toolName === 'read_artifact_source') {
    const parsed = parsedObject(value)
    if (parsed?.ok === true && typeof parsed.content === 'string') {
      const receipt = { ...parsed }
      delete receipt.content
      return JSON.stringify({
        ...receipt,
        sourceOmittedFromHistory: true,
        note: 'Editable source is loaded on demand with read_artifact_source.',
      })
    }
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {})
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  const tailChars = 1_000
  const marker = `\n[tool result truncated: ${text.length} chars total]\n`
  const headChars = Math.max(0, MAX_TOOL_RESULT_CHARS - tailChars - marker.length)
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`
}

function normalizeCall(call) {
  const id = String(call?.id || '').trim()
  const name = String(call?.function?.name || call?.name || '').trim()
  if (!id || !name) return null
  const rawArguments = call?.function?.arguments ?? call?.argumentsText ?? call?.args ?? {}
  const normalized = {
    id,
    type: 'function',
    function: {
      name,
      arguments: boundedArguments(rawArguments),
    },
  }
  const original = parsedObject(rawArguments)
  if (original?.title) {
    Object.defineProperty(normalized, 'artifactTitle', {
      value: String(original.title).slice(0, 500),
      enumerable: false,
    })
  }
  return normalized
}

function artifactReferenceArguments(call, resultMessage) {
  const name = String(call?.function?.name || '')
  if (!SOURCE_BEARING_ARTIFACT_TOOLS.has(name)) return null
  const result = parsedObject(resultMessage?.content)
  const artifactId = String(result?.artifactId || '').trim()
  if (result?.ok !== true || !artifactId) return null
  const filename = String(result.filename || '').trim()
  const url = String(result.url || '').trim()
  return JSON.stringify({
    __artifactReference: true,
    artifactId,
    ...(filename ? { filename } : {}),
    type: ARTIFACT_TYPE_BY_TOOL[name] || '',
    ...(url ? { url } : {}),
    ...(call.artifactTitle ? { title: call.artifactTitle } : {}),
    source: {
      omittedFromHistory: true,
      readTool: 'read_artifact_source',
      artifact_id: artifactId,
      instruction: 'Call read_artifact_source from offset 0 through complete=true before revising this artifact.',
    },
  })
}

function normalizeGroups(messages, excludedCallIds) {
  const groups = []
  let active = null
  const flush = () => {
    if (!active?.assistant.tool_calls.length) return
    const resultsById = new Map(active.tools.map((message) => [message.tool_call_id, message]))
    for (const call of active.assistant.tool_calls) {
      const reference = artifactReferenceArguments(call, resultsById.get(call.id))
      if (reference) call.function.arguments = reference
    }
    const tools = active.assistant.tool_calls.map((call) => resultsById.get(call.id) || {
      role: 'tool',
      tool_call_id: call.id,
      name: call.function.name,
      content: JSON.stringify({
        ok: false,
        code: 'tool_result_unavailable',
        error: 'The prior tool result was not retained.',
      }),
    })
    groups.push([active.assistant, ...tools])
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      flush()
      const allCalls = message.tool_calls
        .map(normalizeCall)
        .filter((call) => call && !excludedCallIds.has(call.id))
      const omitted = Math.max(0, allCalls.length - MAX_TOOL_CALLS_PER_GROUP)
      const calls = allCalls.slice(-MAX_TOOL_CALLS_PER_GROUP)
      active = calls.length ? {
        assistant: {
          role: 'assistant',
          content: [
            String(message.content || ''),
            omitted ? `[${omitted} earlier tool calls omitted from retained context]` : '',
          ].filter(Boolean).join('\n'),
          tool_calls: calls,
        },
        callIds: new Set(calls.map((call) => call.id)),
        tools: [],
      } : null
    } else if (message?.role === 'tool' && active) {
      const toolCallId = String(message.tool_call_id || message.toolCallId || '').trim()
      if (!active.callIds.has(toolCallId)) continue
      const name = String(message.name || active.assistant.tool_calls.find((call) => call.id === toolCallId)?.function?.name || '')
      active.tools.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name,
        content: boundedToolResult(message.content, name),
      })
    }
  }
  flush()
  return groups
}

export function collectToolCallIds(messages) {
  const ids = new Set()
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      const id = String(call?.id || '').trim()
      if (id) ids.add(id)
    }
  }
  return ids
}

export function extractTurnToolTrace(messages, { excludedCallIds = new Set() } = {}) {
  const groups = normalizeGroups(messages, excludedCallIds).slice(-MAX_TOOL_GROUPS_PER_TURN)
  const retained = []
  let retainedChars = 0
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    const size = jsonLength(group)
    if (retained.length > 0 && retainedChars + size > MAX_TURN_TOOL_CONTEXT_CHARS) break
    retained.unshift(...group)
    retainedChars += size
  }
  return retained
}

function normalizeManagedAttachmentRefs(values) {
  const refs = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value?.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const ref = {
      id,
      name: String(value?.name || 'attachment').split(/[\\/]/).pop(),
      mimeType: String(value?.mimeType || 'application/octet-stream'),
      size: Math.max(0, Number(value?.size) || 0),
      sha256: String(value?.sha256 || ''),
      uri: String(value?.uri || `attachment://${id}`),
      downloadUrl: String(value?.downloadUrl || ''),
    }
    if (typeof value?.status === 'string') ref.status = value.status
    if (Object.hasOwn(value || {}, 'sessionId')) {
      ref.sessionId = value.sessionId === null ? null : String(value.sessionId || '')
    }
    if (Object.hasOwn(value || {}, 'messageId')) {
      ref.messageId = value.messageId === null ? null : String(value.messageId || '')
    }
    refs.push(ref)
    if (refs.length >= MAX_MANAGED_ATTACHMENTS_PER_MESSAGE) break
  }
  return refs
}

function hasCompleteAttachmentReceipt(attachment, sessionId) {
  const id = String(attachment?.id || '')
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(id)
    && typeof attachment?.name === 'string'
    && attachment.name.length > 0
    && typeof attachment?.mimeType === 'string'
    && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(attachment.mimeType)
    && Number.isSafeInteger(attachment?.size)
    && attachment.size >= 0
    && /^[a-f0-9]{64}$/.test(String(attachment?.sha256 || ''))
    && attachment?.status === 'ready'
    && attachment?.sessionId === sessionId
    && Object.hasOwn(attachment, 'messageId')
    && attachment.uri === `attachment://${id}`
    && attachment.downloadUrl === `/api/attachments/${encodeURIComponent(id)}/content`
}

function frozenExpectedAttachmentReceipts(attachments) {
  return Object.freeze(attachments.map((attachment) => Object.freeze({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
    status: attachment.status,
    sessionId: attachment.sessionId,
    messageId: attachment.messageId,
    uri: attachment.uri,
    downloadUrl: attachment.downloadUrl,
  })))
}

function normalizeAttachmentIds(values, limit = MAX_MANAGED_ATTACHMENTS_PER_MESSAGE) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value?.id || value || '').trim())
    .filter(Boolean))]
    .slice(0, limit)
}

function attachmentReferenceLine(attachment) {
  const name = String(attachment?.name || 'attachment').replace(/["\\\r\n]/g, '_')
  return `[GUGO_MANAGED_ATTACHMENT id="${attachment.id}" uri="${attachment.uri || `attachment://${attachment.id}`}" name="${name}" mime="${attachment.mimeType || 'application/octet-stream'}" size=${Math.max(0, Number(attachment.size) || 0)}]`
}

function contentWithAttachmentReferences(content, refs) {
  const text = textContent(content).trim()
  const references = normalizeManagedAttachmentRefs(refs).map(attachmentReferenceLine).join('\n')
  return [text, references].filter(Boolean).join('\n\n')
}

/**
 * New uploads are sent to the model once. Older binary attachments are only
 * revisited when the user's prompt explicitly refers back to them; ordinary
 * follow-up turns retain lightweight attachment:// references instead.
 */
export function selectAttachmentIdsForModelRequest(messages, {
  currentAttachmentIds = [],
  prompt = '',
  maxHistorical = MAX_HISTORICAL_ATTACHMENTS_PER_REQUEST,
} = {}) {
  const current = normalizeAttachmentIds(currentAttachmentIds)
  if (current.length) return current
  if (!HISTORICAL_ATTACHMENT_REFERENCE_PATTERN.test(String(prompt || ''))) return []

  const source = Array.isArray(messages) ? messages : []
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index]?.role !== 'user') continue
    const refs = normalizeManagedAttachmentRefs(source[index]?.managedAttachments)
    if (!refs.length) continue
    return refs.slice(0, Math.max(1, Number(maxHistorical) || 1)).map((attachment) => attachment.id)
  }
  return []
}

function textContent(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return String(value ?? '')
  return value
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function storedMessageToWire(message) {
  // System blocks are rebuilt by promptCompiler for every request. Replaying a
  // stored/imported system row would duplicate stale identity, skill, runtime,
  // or UI state and could elevate untrusted imported transcript text back to
  // system authority. Durable conversation facts remain in user/assistant and
  // paired tool messages.
  if (message?.role === 'system') return null
  const context = message.modelContext && typeof message.modelContext === 'object'
    ? message.modelContext
    : null
  const wire = {
    role: message.role,
    content: String(context?.modelContent ?? message.content ?? ''),
  }
  const managedAttachments = message.role === 'user'
    ? normalizeManagedAttachmentRefs(context?.attachments)
    : []
  if (managedAttachments.length) wire.managedAttachments = managedAttachments
  if (message.role === 'assistant' && Array.isArray(context?.toolCalls)) {
    wire.tool_calls = context.toolCalls.map(normalizeCall).filter(Boolean)
  }
  if (message.role === 'tool') {
    if (context?.toolCallId) wire.tool_call_id = String(context.toolCallId)
    if (context?.name) wire.name = String(context.name)
  }
  return wire
}

function priorTurnOutcomeWire(message) {
  const context = message?.modelContext && typeof message.modelContext === 'object'
    ? message.modelContext
    : null
  const state = context?.turnEvidence === true ? String(context.evidenceState || '').trim() : ''
  if (!['failed', 'interrupted'].includes(state)) return null
  const errorValue = context?.error
  const error = errorValue && typeof errorValue === 'object'
    ? {
        code: String(errorValue.code || '').slice(0, 160),
        message: String(errorValue.message || errorValue.error || '').slice(0, 1_000),
      }
    : { message: String(errorValue || '').slice(0, 1_000) }
  const verifiedLocalFiles = normalizedVerifiedLocalFiles(context.verifiedLocalFiles)
    .map((file) => ({
      id: file.id,
      path: file.path,
      filename: file.filename,
      ...(Array.isArray(file.relatedArtifactIds)
        ? { relatedArtifactIds: file.relatedArtifactIds }
        : {}),
    }))
  const retainedLocalFiles = normalizedRetainedLocalFiles(context.retainedLocalFiles)
    .map((file) => ({
      id: file.id,
      path: file.path,
      filename: file.filename,
    }))
  const deliveryArtifactIds = [...new Set((Array.isArray(context.deliveryArtifactIds)
    ? context.deliveryArtifactIds
    : []).map(String).filter(Boolean))]
  return {
    role: 'system',
    content: [
      '[PRIOR TURN OUTCOME]',
      JSON.stringify({ state, error, verifiedLocalFiles, retainedLocalFiles, deliveryArtifactIds }),
      'This prior turn did not complete. A status answer must preserve that failure state and its concrete blocker. Do not claim that it completed or had no problem unless this current turn obtains new successful execution and verification evidence. Verified local files may be reused as continuation targets. Retained local files were written successfully but still require verification; they may be inspected or continued from, but must not be described as verified.',
    ].join('\n'),
  }
}

/**
 * Materialize managed attachment references only for the provider request.
 * The tool loop and its checkpoints keep the original lightweight messages,
 * while the returned copy may contain extracted text or inline media.
 */
export async function materializeManagedAttachmentMessages(messages, {
  userId,
  sessionId,
  prepareAttachments,
  inlineAttachmentIds,
} = {}) {
  const requestedInlineIds = inlineAttachmentIds === undefined
    ? null
    : new Set(normalizeAttachmentIds(inlineAttachmentIds))
  const materialized = []
  for (const source of Array.isArray(messages) ? messages : []) {
    const { managedAttachments: rawRefs, ...wire } = source || {}
    const refs = normalizeManagedAttachmentRefs(rawRefs)
    if (wire.role !== 'user' || refs.length === 0) {
      materialized.push({ ...wire })
      continue
    }
    const selectedInlineRefs = requestedInlineIds === null
      ? refs
      : refs.filter((attachment) => requestedInlineIds.has(attachment.id))
    const inlineRefs = selectedInlineRefs.filter((attachment) => (
      hasCompleteAttachmentReceipt(attachment, sessionId)
    ))
    const inlineIds = new Set(inlineRefs.map((attachment) => attachment.id))
    const referenceRefs = refs.filter((attachment) => !inlineIds.has(attachment.id))
    if (inlineRefs.length === 0) {
      materialized.push({
        ...wire,
        content: contentWithAttachmentReferences(wire.content, refs),
      })
      continue
    }
    if (typeof prepareAttachments !== 'function') {
      throw new TypeError('prepareAttachments is required for managed attachment messages')
    }
    const prepared = await prepareAttachments({
      userId,
      sessionId,
      attachmentIds: inlineRefs.map((attachment) => attachment.id),
      expectedAttachments: frozenExpectedAttachmentReceipts(inlineRefs),
      text: contentWithAttachmentReferences(wire.content, referenceRefs),
    })
    materialized.push({
      ...wire,
      content: prepared?.content ?? wire.content,
    })
  }
  return materialized
}

export function expandStoredMessages(messages) {
  const includeTraceAt = new Set()
  let retainedChars = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const trace = messages[index]?.modelContext?.toolTrace
    if (!Array.isArray(trace) || trace.length === 0) continue
    const size = jsonLength(trace)
    if (retainedChars + size > MAX_SESSION_TOOL_CONTEXT_CHARS) continue
    retainedChars += size
    includeTraceAt.add(index)
  }

  const expanded = []
  messages.forEach((message, index) => {
    if (includeTraceAt.has(index)) {
      expanded.push(...message.modelContext.toolTrace.map((item) => (
        tagStoredMessageSource({ ...item }, message.id)
      )))
    }
    const priorOutcome = priorTurnOutcomeWire(message)
    if (priorOutcome) expanded.push(tagStoredMessageSource(priorOutcome, message.id))
    const wire = storedMessageToWire(message)
    if (wire) expanded.push(tagStoredMessageSource(wire, message.id))
  })
  return expanded
}

export function buildAssistantModelContext({
  turnId,
  checkpointMessages,
  baselineToolCallIds,
  userId = null,
  verifiedLocalFiles,
  retainedLocalFiles = [],
  artifactIds = [],
  deliveryArtifactIds,
  iterations = 0,
  paused = false,
  pluginPromptBlockIds = [],
  compactionArchiveId = null,
  compactionRecovery = null,
  usage = null,
  turnModelUsage = null,
  estimatedPromptTokens = null,
  turnStartedAt = null,
  turnCompletedAt = null,
} = {}) {
  const localFileReceipts = normalizedVerifiedLocalFiles(
    verifiedLocalFiles ?? extractVerifiedLocalFiles(checkpointMessages, {
      userId,
      baselineToolCallIds: baselineToolCallIds || new Set(),
      verifiedAt: turnCompletedAt || Date.now(),
    }),
  )
  const retainedFileReceipts = normalizedRetainedLocalFiles(retainedLocalFiles)
    .filter((retained) => !localFileReceipts.some((verified) => (
      canonicalLocalPath(verified.path) === canonicalLocalPath(retained.path)
    )))
  const normalizedUsage = normalizeModelUsage(usage)
  const normalizedTurnModelUsage = normalizeModelUsage(turnModelUsage)
  const normalizedEstimatedPromptTokens = (
    estimatedPromptTokens !== null
    && estimatedPromptTokens !== undefined
    && estimatedPromptTokens !== ''
    && typeof estimatedPromptTokens !== 'boolean'
    && Number.isFinite(Number(estimatedPromptTokens))
    && Number(estimatedPromptTokens) >= 0
  ) ? Math.floor(Number(estimatedPromptTokens)) : null
  const normalizedPluginPromptBlockIds = [...new Set(
    (Array.isArray(pluginPromptBlockIds) ? pluginPromptBlockIds : [])
      .map((value) => String(value || '').trim().slice(0, 160))
      .filter(Boolean),
  )].slice(0, 32)
  const normalizedStartedAt = Number.isFinite(Number(turnStartedAt))
    ? Math.max(0, Number(turnStartedAt))
    : null
  const normalizedCompletedAt = Number.isFinite(Number(turnCompletedAt))
    ? Math.max(0, Number(turnCompletedAt))
    : null
  const latency = normalizedStartedAt !== null && normalizedCompletedAt !== null
    ? Math.max(0, normalizedCompletedAt - normalizedStartedAt)
    : null
  return {
    version: 1,
    turnId: String(turnId || ''),
    toolTrace: extractTurnToolTrace(checkpointMessages, {
      excludedCallIds: baselineToolCallIds || new Set(),
    }),
    // Presence is authoritative. Persist an explicit empty list for new turns
    // so restored clients never reinterpret an intentionally unverified write
    // through the legacy tool-trace compatibility path.
    verifiedLocalFiles: localFileReceipts,
    // A retained receipt is authorized and clickable, but explicitly does not
    // satisfy the independent verification gate.
    retainedLocalFiles: retainedFileReceipts,
    artifactIds: Array.isArray(artifactIds) ? artifactIds.map(String) : [],
    ...(Array.isArray(deliveryArtifactIds)
      ? { deliveryArtifactIds: deliveryArtifactIds.map(String) }
      : {}),
    iterations: Math.max(0, Number(iterations) || 0),
    paused: !!paused,
    ...(normalizedPluginPromptBlockIds.length
      ? { pluginPromptBlockIds: normalizedPluginPromptBlockIds }
      : {}),
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    ...(normalizedTurnModelUsage ? { turnModelUsage: normalizedTurnModelUsage } : {}),
    ...(normalizedEstimatedPromptTokens !== null
      ? { estimatedPromptTokens: normalizedEstimatedPromptTokens }
      : {}),
    ...(normalizedStartedAt !== null ? { turnStartedAt: normalizedStartedAt } : {}),
    ...(normalizedCompletedAt !== null ? { turnCompletedAt: normalizedCompletedAt } : {}),
    ...(latency !== null ? { latency } : {}),
    ...(compactionArchiveId || compactionRecovery?.archiveId
      ? { compactionArchiveId: String(compactionArchiveId || compactionRecovery.archiveId) }
      : {}),
    ...(compactionRecovery?.firstKeptMessageId
      ? { compactionFirstKeptMessageId: String(compactionRecovery.firstKeptMessageId) }
      : {}),
    ...(compactionRecovery?.lastCompactedMessageId
      ? { compactionLastCompactedMessageId: String(compactionRecovery.lastCompactedMessageId) }
      : {}),
    ...(compactionRecovery?.compactCheckpointSource
      && typeof compactionRecovery.compactCheckpointSource === 'object'
      ? { compactCheckpointSource: compactionRecovery.compactCheckpointSource }
      : {}),
  }
}

export const TURN_TOOL_CONTEXT_LIMITS = Object.freeze({
  maxArgumentChars: MAX_TOOL_ARGUMENT_CHARS,
  maxArtifactArgumentChars: MAX_TOOL_ARGUMENT_CHARS,
  maxResultChars: MAX_TOOL_RESULT_CHARS,
  maxTurnChars: MAX_TURN_TOOL_CONTEXT_CHARS,
  maxSessionChars: MAX_SESSION_TOOL_CONTEXT_CHARS,
})

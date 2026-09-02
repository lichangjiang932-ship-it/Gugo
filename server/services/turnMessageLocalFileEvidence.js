import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TRUNCATED_TOOL_RESULT_METADATA_KEY } from '../utils/toolCallHarness.js'
import { resolveAuthorizedLocalPath } from './localFileAccessService.js'

export const SOURCE_BEARING_ARTIFACT_TOOLS = new Set([
  'create_docx',
  'create_html_app',
  'create_pdf',
  'create_pptx',
  'create_xlsx',
  'generate_image',
  'render_pdf_pages',
])
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
export function parsedObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value ?? ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
function workspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd())
}

function isInsidePath(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function canonicalLocalPath(value) {
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

export function normalizedVerifiedLocalFiles(values) {
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

export function normalizedRetainedLocalFiles(values) {
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

import { buildArtifactPreview } from './artifactPreview.js'
import {
  buildArtifactReferenceIdentity,
  normalizeArtifactLocalPath,
  normalizeArtifactReferenceType,
} from './artifactReferences.js'

const MUTATION_TOOL_NAMES = new Set([
  'apply_patch',
  'bash_exec',
  'edit_file',
  'multi_edit',
  'patch_file',
  'run_command',
  'write_file',
])

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function callName(call = {}) {
  return String(call?.name || call?.function?.name || '').trim()
}

function callArguments(call = {}) {
  return parseObject(call?.args)
    || parseObject(call?.arguments)
    || parseObject(call?.function?.arguments)
    || {}
}

function callResult(call = {}) {
  const result = parseObject(call?.result)
  if (!result) return null
  if (!result.path && !result.changes && typeof result.content === 'string') {
    return parseObject(result.content) || result
  }
  return result
}

function callSucceeded(call, result) {
  const status = String(call?.status || '').trim().toLowerCase()
  if (['cancelled', 'error', 'failed'].includes(status)) return false
  return result?.ok !== false && !call?.error
}

function absolutePath(value) {
  const path = String(value || '').trim()
  const key = normalizeArtifactLocalPath(path)
  return key ? { key, path } : null
}

function resultPaths(result = {}) {
  const values = [
    result.path,
    result.fullPath,
    result.outputPath,
    ...(Array.isArray(result.changedFiles) ? result.changedFiles : []),
    ...(Array.isArray(result.changedPaths) ? result.changedPaths : []),
    ...(Array.isArray(result.outputPaths) ? result.outputPaths : []),
    ...(Array.isArray(result.changes) ? result.changes.map((change) => change?.path) : []),
  ]
  const paths = new Map()
  for (const value of values) {
    const normalized = absolutePath(value)
    if (normalized) paths.set(normalized.key, normalized.path)
  }
  return paths
}

function callId(call = {}) {
  return String(call?.id || call?.toolCallId || '').trim()
}

function artifactIdsFromResult(result = {}, paths = new Map()) {
  const idsByPath = new Map([...paths.keys()].map((key) => [key, new Set()]))
  const addIds = (keys, values) => {
    const ids = (Array.isArray(values) ? values : [values])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    for (const key of keys) {
      const target = idsByPath.get(key)
      if (!target) continue
      for (const id of ids) target.add(id)
    }
  }
  const onlyKey = paths.size === 1 ? paths.keys().next().value : ''
  const topLevelIds = [
    result.artifactId,
    ...(Array.isArray(result.artifactIds) ? result.artifactIds : []),
  ]
  if (onlyKey) addIds([onlyKey], topLevelIds)

  const artifacts = [
    ...(Array.isArray(result.artifacts) ? result.artifacts : []),
    ...(result.artifact && typeof result.artifact === 'object' ? [result.artifact] : []),
  ]
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') continue
    const ids = [artifact.id, artifact.artifactId]
    const artifactPathKeys = [
      artifact.path,
      artifact.fullPath,
      artifact.sourcePath,
      artifact.outputPath,
      artifact.localPath,
    ].map((value) => absolutePath(value)?.key).filter((key) => key && idsByPath.has(key))
    if (artifactPathKeys.length > 0) addIds(artifactPathKeys, ids)
    else if (onlyKey) addIds([onlyKey], ids)
  }
  return new Map([...idsByPath].map(([key, ids]) => [key, [...ids]]))
}

function mutationEvidence(toolCalls = []) {
  const mutations = new Map()
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  calls.forEach((call, index) => {
    const name = callName(call)
    const result = callResult(call)
    if (!MUTATION_TOOL_NAMES.has(name) || !result || !callSucceeded(call, result)) return
    const args = callArguments(call)
    const content = name === 'write_file' && typeof args.content === 'string' ? args.content : null
    const paths = resultPaths(result)
    const artifactIdsByPath = artifactIdsFromResult(result, paths)
    for (const [key, path] of paths) {
      mutations.set(key, {
        content,
        index,
        path,
        toolCallId: callId(call),
        relatedArtifactIds: artifactIdsByPath.get(key) || [],
      })
    }
  })
  return mutations
}

function fileHref(path) {
  const key = normalizeArtifactLocalPath(path)
  return `/__local-file-reference__/${encodeURIComponent(key)}`
}

function verifiedFileHref({ id, turnId }) {
  const safeId = String(id || '').trim()
  const safeTurnId = String(turnId || '').trim()
  if (!safeId || !safeTurnId) return ''
  return `/api/local-files/verified/${encodeURIComponent(safeId)}?turnId=${encodeURIComponent(safeTurnId)}`
}

function basename(path) {
  return String(path || '').split(/[\\/]/u).filter(Boolean).at(-1) || 'file'
}

function previewForFile({ content, filename, path }) {
  const type = normalizeArtifactReferenceType({ filename })
  if (['html', 'html_multi', 'mermaid', 'chart', 'svg', 'react'].includes(type)) {
    const preview = buildArtifactPreview({
      content,
      meta: {
        artifactType: type,
        artifactTitle: filename.replace(/\.[^.]+$/u, ''),
      },
    })
    if (preview) return { ...preview, filename, path }
  }
  const extension = String(filename.split('.').at(-1) || '').toUpperCase()
  return {
    type: 'text',
    title: filename,
    label: extension || 'FILE',
    filename,
    path,
    summary: `${String(content || '').length} characters`,
    previewable: true,
  }
}

function completeReadContent(result) {
  if (typeof result?.content !== 'string') return null
  const offset = Math.max(0, Number(result.offset) || 0)
  const returnedLines = Math.max(0, Number(result.returnedLines) || result.content.split('\n').length)
  const totalLines = Math.max(returnedLines, Number(result.totalLines) || returnedLines)
  return offset === 0 && returnedLines >= totalLines ? result.content : null
}

function referencesFromReceipts(receipts, { messageId = '', mutations = new Map(), turnId = '' } = {}) {
  const references = []
  const seen = new Set()
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    const id = String(receipt?.id || '').trim()
    const path = String(receipt?.path || '').trim()
    const filename = String(receipt?.filename || basename(path)).trim()
    const key = normalizeArtifactLocalPath(path)
    const url = verifiedFileHref({ id, turnId })
    if (!id || !key || !filename || !url || seen.has(id)) continue
    seen.add(id)
    const type = normalizeArtifactReferenceType({ filename })
    const identity = `${buildArtifactReferenceIdentity({ filename, messageId, type })}:${key}`
    const mutation = mutations.get(key)
    references.push({
      id: `local-file:${id}`,
      identity,
      filename,
      title: filename,
      type,
      path,
      fullPath: path,
      url,
      verifiedLocalFile: true,
      ...(mutation?.toolCallId ? { toolCallId: mutation.toolCallId } : {}),
      ...(mutation?.relatedArtifactIds?.length > 0
        ? { relatedArtifactIds: mutation.relatedArtifactIds }
        : {}),
      previewArtifact: {
        messageId: String(messageId || ''),
        artifactIdentity: identity,
        content: '',
        preview: null,
        directFile: {
          id,
          filename,
          title: filename,
          type,
          url,
          path,
          ...(Number.isFinite(Number(receipt?.size))
            ? { size: Math.max(0, Number(receipt.size)), summary: `${Math.max(0, Number(receipt.size))} bytes` }
            : {}),
        },
      },
    })
  }
  return references
}

/**
 * Build clickable references only for local files that this completed turn
 * both mutated successfully and read back afterwards. The absolute path comes
 * from trusted tool results, never from assistant prose.
 */
export function buildVerifiedLocalFileReferences({
  toolCalls = [],
  verifiedLocalFiles,
  messageId = '',
  turnId = '',
} = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  const mutations = mutationEvidence(calls)
  if (Array.isArray(verifiedLocalFiles)) {
    return referencesFromReceipts(verifiedLocalFiles, { messageId, mutations, turnId })
  }

  const reads = new Map()
  calls.forEach((call, index) => {
    if (callName(call) !== 'read_file') return
    const result = callResult(call)
    if (!result || !callSucceeded(call, result)) return
    for (const [key, path] of resultPaths(result)) {
      const mutation = mutations.get(key)
      if (!mutation || index <= mutation.index) continue
      reads.set(key, {
        content: completeReadContent(result),
        index,
        path,
      })
    }
  })

  const references = []
  for (const [key, mutation] of mutations) {
    const read = reads.get(key)
    if (!read) continue
    // The readback is the authoritative final state. A write tool may normalize
    // or otherwise alter its input before persisting it.
    const content = read.content ?? mutation.content
    if (typeof content !== 'string') continue
    const path = read.path || mutation.path
    const filename = basename(path)
    const type = normalizeArtifactReferenceType({ filename })
    // Include the verified absolute path so two same-named files from
    // different directories never reuse the same workbench tab.
    const identity = `${buildArtifactReferenceIdentity({ filename, messageId, type })}:${key}`
    const preview = previewForFile({ content, filename, path })
    references.push({
      id: `local-file:${key}`,
      identity,
      filename,
      title: filename,
      type,
      path,
      fullPath: path,
      url: fileHref(path),
      verifiedLocalFile: true,
      ...(mutation.toolCallId ? { toolCallId: mutation.toolCallId } : {}),
      ...(mutation.relatedArtifactIds.length > 0
        ? { relatedArtifactIds: mutation.relatedArtifactIds }
        : {}),
      previewArtifact: {
        messageId: String(messageId || ''),
        artifactIdentity: identity,
        content,
        preview,
      },
    })
  }
  return references
}

/**
 * A local mutation can also publish a managed artifact snapshot. When the
 * successful tool result explicitly associates both with the same path, keep
 * the verified local file: it reflects later in-place edits while the snapshot
 * is immutable. Unrelated and merely same-named files remain separate.
 */
export function mergeArtifactReferences({
  serverReferences = [],
  verifiedLocalFileReferences = [],
} = {}) {
  const localReferences = Array.isArray(verifiedLocalFileReferences)
    ? verifiedLocalFileReferences
    : []
  const supersededArtifactIds = new Set(localReferences.flatMap((reference) => (
    Array.isArray(reference?.relatedArtifactIds) ? reference.relatedArtifactIds : []
  )).map((id) => String(id || '').trim()).filter(Boolean))
  const retainedServerReferences = (Array.isArray(serverReferences) ? serverReferences : [])
    .filter((reference) => !supersededArtifactIds.has(String(reference?.id || '').trim()))
  return [...retainedServerReferences, ...localReferences]
}

export function verifiedLocalFileOpenPayload(reference) {
  return reference?.verifiedLocalFile === true ? reference.previewArtifact || null : null
}

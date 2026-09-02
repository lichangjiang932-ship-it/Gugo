import { normalizeModelUsage } from '../../shared/modelUsage.js'
import { modelAuthoredTurnEvidenceText } from '../../shared/turnEvidenceText.js'
import {
  canonicalLocalPath,
  extractRetainedLocalFiles,
  extractVerifiedLocalFiles,
  normalizedRetainedLocalFiles,
  normalizedVerifiedLocalFiles,
  recoverLegacyVerifiedLocalFiles,
} from './turnMessageLocalFileEvidence.js'
import {
  TURN_TOOL_CONTEXT_LIMITS,
  MAX_SESSION_TOOL_CONTEXT_CHARS,
  collectToolCallIds,
  extractTurnToolTrace,
  jsonLength,
  normalizeCall,
  resolveStoredMessagesAfterCompaction,
  selectStoredMessagesAfterCompaction,
  storedMessageSourceId,
  tagStoredMessageSource,
} from './turnMessageHistoryTrace.js'

export {
  TURN_TOOL_CONTEXT_LIMITS,
  collectToolCallIds,
  extractRetainedLocalFiles,
  extractTurnToolTrace,
  extractVerifiedLocalFiles,
  recoverLegacyVerifiedLocalFiles,
  resolveStoredMessagesAfterCompaction,
  selectStoredMessagesAfterCompaction,
  storedMessageSourceId,
}

const MAX_MANAGED_ATTACHMENTS_PER_MESSAGE = 32
const MAX_HISTORICAL_ATTACHMENTS_PER_REQUEST = 4
const HISTORICAL_ATTACHMENT_REFERENCE_PATTERN = /(?:attachment:\/\/|(?:刚才|之前|上次|前面|同一|同一个|那个|那张|这张|这份|上一张|原来).{0,16}(?:附件|图片|图像|照片|截图|图表|文件|文档|pdf)|(?:附件|图片|图像|照片|截图|图表|文档|pdf).{0,16}(?:重新|再|继续).{0,8}(?:看|读|分析|检查|查看)|(?:same|previous|earlier|that|the\s+attached)\s+(?:attachment|image|photo|screenshot|diagram|file|document|pdf)|(?:re-?inspect|re-?read|look\s+again\s+at).{0,24}(?:attachment|image|photo|file|document|pdf))/i
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

function storedModelAuthoredContent(message, context) {
  const content = String(context?.modelContent ?? message?.content ?? '')

  const state = context?.turnEvidence === true ? String(context.evidenceState || '').trim() : ''
  if (!['blocked', 'cancelled', 'failed', 'interrupted'].includes(state)) return content

  const failureValue = context?.error
  const failureMessage = typeof failureValue === 'object' && failureValue !== null
    ? String(failureValue.message || failureValue.error || '').trim()
    : String(failureValue || '').trim()
  return modelAuthoredTurnEvidenceText({ content, failureMessage, state })
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
    content: storedModelAuthoredContent(message, context),
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
  if (!['blocked', 'failed', 'interrupted'].includes(state)) return null
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

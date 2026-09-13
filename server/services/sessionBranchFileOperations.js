const MAX_BRANCHES_WITH_FILE_EVIDENCE = 200
const MAX_EVIDENCE_CONTEXTS_PER_BRANCH = 12
const MAX_CONTEXT_JSON_CHARS = 128_000
const MAX_OPERATIONS_PER_CONTEXT = 64
const MAX_OPERATIONS_PER_BRANCH = 8
const MAX_INTERNAL_OPERATIONS_PER_BRANCH = 256
const MAX_PATH_CHARS = 4_096
const MAX_TOOL_NAME_CHARS = 256

function parseRecord(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function boundedText(value, limit) {
  const text = String(value || '').trim()
  if (!text || text.length > limit) return ''
  for (const character of text) {
    const code = character.codePointAt(0)
    if (code < 32 || code === 127) return ''
  }
  return text
}

function normalizedAction(value) {
  const action = String(value || '').trim().toLowerCase()
  if (['create', 'created', 'add', 'added'].includes(action)) return 'created'
  if (['delete', 'deleted', 'remove', 'removed'].includes(action)) return 'deleted'
  if (['modify', 'modified', 'update', 'updated', 'replace', 'replaced'].includes(action)) return 'modified'
  return 'changed'
}

function evidencePayload(result) {
  if (result?.ok !== true) return null
  const nested = result.result
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    if (Array.isArray(nested.changedPaths) || Array.isArray(nested.verifiedOutputs)) return nested
  }
  return result
}

function operationActions(payload) {
  const actions = new Map()
  for (const change of Array.isArray(payload?.changes) ? payload.changes : []) {
    const filePath = boundedText(change?.path, MAX_PATH_CHARS)
    if (filePath) actions.set(filePath, normalizedAction(change?.op || change?.status))
  }
  for (const output of Array.isArray(payload?.verifiedOutputs) ? payload.verifiedOutputs : []) {
    const filePath = boundedText(output?.path || output?.declaredPath, MAX_PATH_CHARS)
    if (filePath) actions.set(filePath, normalizedAction(output?.status))
  }
  return actions
}

function explicitFileOperations(call, result, provenanceKey) {
  const payload = evidencePayload(result)
  if (!payload) return []
  const actions = operationActions(payload)
  const paths = [
    ...(Array.isArray(payload.changedPaths) ? payload.changedPaths : []),
    ...(Array.isArray(payload.verifiedOutputs)
      ? payload.verifiedOutputs.map((output) => output?.path || output?.declaredPath)
      : []),
  ]
  const seen = new Set()
  const operations = []
  for (const value of paths) {
    const filePath = boundedText(value, MAX_PATH_CHARS)
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)
    operations.push({
      provenanceKey,
      toolCallId: call.id,
      toolName: call.name,
      path: filePath,
      action: actions.get(filePath) || 'changed',
    })
    if (operations.length >= MAX_OPERATIONS_PER_CONTEXT) break
  }
  return operations
}

function operationsFromContext(modelContextJson, { sessionId, messageId }) {
  const context = parseRecord(modelContextJson)
  const trace = Array.isArray(context?.toolTrace) ? context.toolTrace : []
  const sourceSessionId = boundedText(context?.forkSource?.sessionId, 512) || sessionId
  const sourceMessageId = boundedText(context?.forkSource?.messageId, 512) || messageId
  const calls = new Map()
  const operations = []
  for (const message of trace) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        const id = boundedText(rawCall?.id, 512)
        const name = boundedText(rawCall?.function?.name || rawCall?.name, MAX_TOOL_NAME_CHARS)
        if (id && name) calls.set(id, { id, name })
      }
      continue
    }
    if (message?.role !== 'tool') continue
    const toolCallId = boundedText(message.tool_call_id || message.toolCallId, 512)
    const call = calls.get(toolCallId)
    const resultName = boundedText(message.name, MAX_TOOL_NAME_CHARS)
    const result = parseRecord(message.content)
    if (!call || !result || (resultName && resultName !== call.name)) continue
    const provenanceKey = `${sourceSessionId}\u0000${sourceMessageId}\u0000${call.id}`
    operations.push(...explicitFileOperations(call, result, provenanceKey))
    if (operations.length >= MAX_OPERATIONS_PER_CONTEXT) break
  }
  return operations.slice(0, MAX_OPERATIONS_PER_CONTEXT)
}

function evidenceRows(db, { userId, sessionIds }) {
  if (!sessionIds.length) return []
  const placeholders = sessionIds.map(() => '?').join(', ')
  return db.prepare(`
    WITH ranked AS (
      SELECT id AS message_id, session_id, model_context_json,
        ROW_NUMBER() OVER (
          PARTITION BY session_id ORDER BY created_at DESC, rowid DESC
        ) AS evidence_rank,
        COUNT(*) OVER (PARTITION BY session_id) AS evidence_count,
        LENGTH(model_context_json) AS context_length
      FROM messages
      WHERE user_id = ? AND role = 'assistant'
        AND session_id IN (${placeholders})
        AND (INSTR(model_context_json, 'changedPaths') > 0
          OR INSTR(model_context_json, 'verifiedOutputs') > 0)
    )
    SELECT message_id, session_id,
      CASE WHEN context_length <= ? THEN model_context_json ELSE NULL END AS model_context_json,
      evidence_rank, evidence_count, context_length
    FROM ranked
    WHERE evidence_rank <= ?
    ORDER BY session_id ASC, evidence_rank DESC
  `).all(
    userId,
    ...sessionIds,
    MAX_CONTEXT_JSON_CHARS,
    MAX_EVIDENCE_CONTEXTS_PER_BRANCH,
  )
}

function collectedOperationsBySession(db, { userId, branches }) {
  const selected = branches.slice(0, MAX_BRANCHES_WITH_FILE_EVIDENCE)
  const selectedIds = selected.map((branch) => branch.id)
  const bySession = new Map(branches.map((branch, index) => [branch.id, {
    operations: [],
    truncated: index >= MAX_BRANCHES_WITH_FILE_EVIDENCE,
  }]))
  for (const row of evidenceRows(db, { userId, sessionIds: selectedIds })) {
    const state = bySession.get(row.session_id)
    if (!state) continue
    if (Number(row.evidence_count) > MAX_EVIDENCE_CONTEXTS_PER_BRANCH
      || Number(row.context_length) > MAX_CONTEXT_JSON_CHARS
      || !row.model_context_json) state.truncated = true
    state.operations.push(...operationsFromContext(row.model_context_json, {
      sessionId: row.session_id,
      messageId: row.message_id,
    }))
    if (state.operations.length > MAX_INTERNAL_OPERATIONS_PER_BRANCH) {
      state.operations = state.operations.slice(-MAX_INTERNAL_OPERATIONS_PER_BRANCH)
      state.truncated = true
    }
  }
  return bySession
}

function operationIdentity(operation) {
  return `${operation.provenanceKey}\u0000${operation.action}\u0000${operation.path}`
}

export function branchFileOperationSummaries(db, { userId, branches = [] } = {}) {
  const safeBranches = Array.isArray(branches) ? branches : []
  const evidence = collectedOperationsBySession(db, { userId, branches: safeBranches })
  const summaries = new Map()
  for (const branch of safeBranches) {
    const current = evidence.get(branch.id) || { operations: [], truncated: true }
    const parent = branch.parentSessionId ? evidence.get(branch.parentSessionId) : null
    const comparisonIncomplete = current.truncated || parent?.truncated === true
    if (comparisonIncomplete) {
      summaries.set(branch.id, { fileOperations: [], fileOperationsTruncated: true })
      continue
    }
    const inherited = new Set((parent?.operations || []).map(operationIdentity))
    const local = current.operations.filter((operation) => !inherited.has(operationIdentity(operation)))
    const deduplicated = new Map(local.map((operation) => [operationIdentity(operation), operation]))
    const values = [...deduplicated.values()]
    const visible = values.slice(-MAX_OPERATIONS_PER_BRANCH).map((operation) => ({
      toolName: operation.toolName,
      path: operation.path,
      action: operation.action,
    }))
    summaries.set(branch.id, {
      fileOperations: visible,
      fileOperationsTruncated: values.length > visible.length,
    })
  }
  return summaries
}

export const SESSION_BRANCH_FILE_OPERATION_LIMITS = Object.freeze({
  maxBranches: MAX_BRANCHES_WITH_FILE_EVIDENCE,
  maxEvidenceContextsPerBranch: MAX_EVIDENCE_CONTEXTS_PER_BRANCH,
  maxOperationsPerBranch: MAX_OPERATIONS_PER_BRANCH,
})

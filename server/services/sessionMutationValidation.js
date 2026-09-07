const MAX_BRANCH_LABEL_LENGTH = 120
const MAX_WORKSPACE_PATH_LENGTH = 32_768
const MAX_REPLACEMENT_MESSAGES = 50_000
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool'])

export class SessionMutationValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionMutationValidationError'
    this.code = 'INVALID_SESSION_MUTATION'
  }
}

export function normalizeSessionWorkspacePath(value) {
  if (value == null) return null
  if (typeof value !== 'string') {
    throw new SessionMutationValidationError('workspacePath must be a string or null')
  }
  const workspacePath = value.trim()
  if (!workspacePath) return null
  if (workspacePath.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new SessionMutationValidationError(
      `workspacePath exceeds the ${MAX_WORKSPACE_PATH_LENGTH} character limit`,
    )
  }
  return workspacePath
}

export function normalizeSessionBranchLabel(value) {
  if (value == null) return null
  if (typeof value !== 'string') {
    throw new SessionMutationValidationError('label must be a string')
  }
  const label = value.trim().replace(/\s+/g, ' ')
  if (!label) return null
  if (label.length > MAX_BRANCH_LABEL_LENGTH) {
    throw new SessionMutationValidationError(
      `label exceeds the ${MAX_BRANCH_LABEL_LENGTH} character limit`,
    )
  }
  return label
}

export function normalizeSessionExpectedRevision(value) {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new SessionMutationValidationError('expectedRevision must be a non-negative integer')
  }
  return revision
}

export function serializeSessionModelContext(value) {
  if (!value || typeof value !== 'object') return '{}'
  return JSON.stringify(value)
}

function normalizeMessageContent(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function replacementModelContextJson(provided, existingJson) {
  if (!provided || typeof provided !== 'object') return existingJson || '{}'
  // An explicit empty context still clears it. Otherwise the browser sends a
  // partial model context, so preserve server evidence for the same identity.
  if (Array.isArray(provided) || Object.keys(provided).length === 0) {
    return serializeSessionModelContext(provided)
  }
  let existing = null
  try { existing = JSON.parse(existingJson || '{}') } catch { /* Legacy invalid JSON has no evidence. */ }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)
    || (provided.turnId && existing.turnId && provided.turnId !== existing.turnId)) {
    return serializeSessionModelContext(provided)
  }
  const merged = { ...existing, ...provided }
  // A canonical trace replaces imported standalone call declarations; keeping
  // both would replay the same tool call twice after a browser round trip.
  if (Object.hasOwn(provided, 'toolTrace') && !Object.hasOwn(provided, 'toolCalls')) {
    delete merged.toolCalls
  }
  return serializeSessionModelContext(merged)
}

export function normalizeSessionReplacementMessages(messages, existingContexts, now) {
  if (!Array.isArray(messages)) {
    throw new SessionMutationValidationError('messages must be an array')
  }
  if (messages.length > MAX_REPLACEMENT_MESSAGES) {
    throw new SessionMutationValidationError('messages exceeds the 50000 item limit')
  }
  const ids = new Set()
  return messages.map((message, index) => {
    const id = String(message?.id || '').trim()
    const role = String(message?.role || '').trim()
    if (!id || id.length > 512) {
      throw new SessionMutationValidationError(`messages[${index}].id is invalid`)
    }
    if (ids.has(id)) {
      throw new SessionMutationValidationError(`duplicate message id: ${id}`)
    }
    ids.add(id)
    if (!MESSAGE_ROLES.has(role)) {
      throw new SessionMutationValidationError(`messages[${index}].role is invalid`)
    }
    const createdAtValue = Number(message?.createdAt)
    const updatedAtValue = Number(message?.updatedAt)
    const createdAt = Number.isFinite(createdAtValue) ? Math.floor(createdAtValue) : now + index
    const updatedAt = Number.isFinite(updatedAtValue) ? Math.floor(updatedAtValue) : createdAt
    return {
      id,
      role,
      content: normalizeMessageContent(message?.content),
      modelContextJson: replacementModelContextJson(message?.modelContext, existingContexts.get(id)),
      createdAt,
      updatedAt,
    }
  })
}

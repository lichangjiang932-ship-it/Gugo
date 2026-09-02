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
    const providedContext = message?.modelContext && typeof message.modelContext === 'object'
      ? serializeSessionModelContext(message.modelContext)
      : null
    return {
      id,
      role,
      content: normalizeMessageContent(message?.content),
      modelContextJson: providedContext || existingContexts.get(id) || '{}',
      createdAt,
      updatedAt,
    }
  })
}

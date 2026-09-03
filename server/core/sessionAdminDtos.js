const SESSION_TIME_FIELDS = Object.freeze(['createdAt', 'updatedAt'])
const SESSION_NULLABLE_TIME_FIELDS = Object.freeze([
  'lastViewedAt',
  'archivedAt',
  'pinnedAt',
  'forkedAt',
])
const SESSION_NULLABLE_STRING_FIELDS = Object.freeze(['parentSessionId', 'branchLabel'])
const MESSAGE_ROLES = Object.freeze(['user', 'assistant', 'system', 'tool'])

function record(value, label, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value
}

function own(value, key, label, fail, { optional = false } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    descriptor = null
  }
  if (!descriptor) {
    if (optional) return undefined
    fail(`${label} must declare own data property ${key}`)
  }
  if (!Object.hasOwn(descriptor, 'value')) fail(`${label}.${key} must be an own data property`)
  return descriptor.value
}

function text(value, label, fail, { max = 1_000_000, empty = true, nullable = false } = {}) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || (!empty && !value) || value.length > max) {
    fail(`${label} must be ${nullable ? 'null or ' : ''}a string of at most ${max} characters`)
  }
  return value
}

function integer(value, label, fail, { nullable = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (nullable && value === null) return null
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    fail(`${label} must be a non-negative safe integer${nullable ? ' or null' : ''}`)
  }
  return value
}

function finiteNumber(value, label, fail) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`)
  return value
}

function boolean(value, label, fail) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`)
  return value
}

function array(value, label, fail, project, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  const length = own(value, 'length', label, fail)
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    fail(`${label} must contain at most ${max} items`)
  }
  const projected = []
  for (let index = 0; index < length; index += 1) {
    projected.push(project(own(value, String(index), label, fail), index))
  }
  return Object.freeze(projected)
}

function plainData(value, label, fail, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1
  if (state.nodes > 100_000 || depth > 64) fail(`${label} exceeds the plain-data safety limit`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return finiteNumber(value, label, fail)
  if (!value || typeof value !== 'object') fail(`${label} must contain plain JSON data`)
  if (Array.isArray(value)) {
    return array(
      value,
      label,
      fail,
      (item, index) => plainData(item, `${label}[${index}]`, fail, state, depth + 1),
      { max: 100_000 },
    )
  }
  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(`${label} must be a plain object`)
  }
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`)
  const projected = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') fail(`${label} cannot contain symbol keys`)
    const descriptor = descriptors[key]
    if (!descriptor.enumerable) continue
    if (!Object.hasOwn(descriptor, 'value')) fail(`${label}.${key} must be an own data property`)
    Object.defineProperty(projected, key, {
      enumerable: true,
      value: plainData(descriptor.value, `${label}.${key}`, fail, state, depth + 1),
    })
  }
  return Object.freeze(projected)
}

function stablePublicFailureRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({})
  const failure = { ...value }
  for (const field of ['message', 'hint', 'reason']) delete failure[field]
  for (const field of ['error', 'cause']) {
    if (!Object.hasOwn(failure, field)) continue
    if (failure[field] && typeof failure[field] === 'object' && !Array.isArray(failure[field])) {
      failure[field] = stablePublicFailureRecord(failure[field])
    } else {
      delete failure[field]
    }
  }
  if (failure.recovery && typeof failure.recovery === 'object' && !Array.isArray(failure.recovery)) {
    const recovery = { ...failure.recovery }
    for (const field of ['message', 'hint', 'reason', 'errorMessage']) delete recovery[field]
    for (const field of ['error', 'cause']) {
      if (!Object.hasOwn(recovery, field)) continue
      if (recovery[field] && typeof recovery[field] === 'object' && !Array.isArray(recovery[field])) {
        recovery[field] = stablePublicFailureRecord(recovery[field])
      } else {
        delete recovery[field]
      }
    }
    failure.recovery = Object.freeze(recovery)
  }
  return Object.freeze(failure)
}

function publicMessageModelContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.turnEvidence !== true) {
    return value
  }
  return stablePublicFailureRecord(value)
}

function sessionDto(value, label, fail) {
  const source = record(value, label, fail)
  const projected = {
    id: text(own(source, 'id', label, fail), `${label}.id`, fail, {
      max: 512,
      empty: false,
    }),
  }
  const title = own(source, 'title', label, fail, { optional: true })
  if (title !== undefined) projected.title = text(title, `${label}.title`, fail, { max: 4096 })
  const turnEventRevision = own(source, 'turnEventRevision', label, fail, { optional: true })
  if (turnEventRevision !== undefined) {
    projected.turnEventRevision = integer(
      turnEventRevision,
      `${label}.turnEventRevision`,
      fail,
    )
  }
  const workspacePath = own(source, 'workspacePath', label, fail, { optional: true })
  if (workspacePath !== undefined) {
    projected.workspacePath = text(workspacePath, `${label}.workspacePath`, fail, {
      max: 32_768,
      empty: false,
      nullable: true,
    })
  }
  for (const key of SESSION_TIME_FIELDS) {
    const valueAtKey = own(source, key, label, fail, { optional: true })
    if (valueAtKey !== undefined) projected[key] = integer(valueAtKey, `${label}.${key}`, fail)
  }
  for (const key of SESSION_NULLABLE_TIME_FIELDS) {
    const valueAtKey = own(source, key, label, fail, { optional: true })
    if (valueAtKey !== undefined) {
      projected[key] = integer(valueAtKey, `${label}.${key}`, fail, { nullable: true })
    }
  }
  for (const key of SESSION_NULLABLE_STRING_FIELDS) {
    const valueAtKey = own(source, key, label, fail, { optional: true })
    if (valueAtKey !== undefined) {
      projected[key] = text(valueAtKey, `${label}.${key}`, fail, {
        max: 512,
        empty: false,
        nullable: true,
      })
    }
  }
  projected.revision = integer(
    own(source, 'revision', label, fail),
    `${label}.revision`,
    fail,
  )
  return Object.freeze(projected)
}

function searchDto(value, label, fail) {
  const source = record(value, label, fail)
  const projected = {
    messageId: text(own(source, 'messageId', label, fail), `${label}.messageId`, fail, {
      max: 512,
      empty: false,
    }),
    sessionId: text(own(source, 'sessionId', label, fail), `${label}.sessionId`, fail, {
      max: 512,
      empty: false,
    }),
  }
  for (const key of ['sessionTitle', 'snippet']) {
    const valueAtKey = own(source, key, label, fail, { optional: true })
    if (valueAtKey !== undefined) projected[key] = text(valueAtKey, `${label}.${key}`, fail)
  }
  const role = own(source, 'role', label, fail, { optional: true })
  if (role !== undefined) {
    projected.role = text(role, `${label}.role`, fail, { max: 32, empty: false })
    if (!MESSAGE_ROLES.includes(projected.role)) fail(`${label}.role is invalid`)
  }
  const createdAt = own(source, 'createdAt', label, fail, { optional: true })
  if (createdAt !== undefined) projected.createdAt = integer(createdAt, `${label}.createdAt`, fail)
  const rank = own(source, 'rank', label, fail, { optional: true })
  if (rank !== undefined) projected.rank = finiteNumber(rank, `${label}.rank`, fail)
  return Object.freeze(projected)
}

function artifactDto(value, label, fail) {
  const source = record(value, label, fail)
  const projected = {
    id: text(own(source, 'id', label, fail), `${label}.id`, fail, {
      max: 512,
      empty: false,
    }),
  }
  for (const key of ['type', 'title', 'url', 'filename']) {
    const valueAtKey = own(source, key, label, fail, { optional: true })
    if (valueAtKey !== undefined) {
      projected[key] = text(valueAtKey, `${label}.${key}`, fail, {
        max: key === 'url' ? 16_384 : 4096,
        nullable: true,
      })
    }
  }
  const createdAt = own(source, 'createdAt', label, fail, { optional: true })
  if (createdAt !== undefined) projected.createdAt = integer(createdAt, `${label}.createdAt`, fail)
  return Object.freeze(projected)
}

function messageDto(value, label, fail, input) {
  const source = record(value, label, fail)
  const projected = {
    id: text(own(source, 'id', label, fail), `${label}.id`, fail, { max: 512, empty: false }),
    sessionId: text(own(source, 'sessionId', label, fail), `${label}.sessionId`, fail, {
      max: 512,
      empty: false,
    }),
    userId: text(own(source, 'userId', label, fail), `${label}.userId`, fail, {
      max: 512,
      empty: false,
    }),
    role: text(own(source, 'role', label, fail), `${label}.role`, fail, {
      max: 32,
      empty: false,
    }),
    content: text(own(source, 'content', label, fail), `${label}.content`, fail),
    createdAt: integer(own(source, 'createdAt', label, fail), `${label}.createdAt`, fail),
    updatedAt: integer(own(source, 'updatedAt', label, fail), `${label}.updatedAt`, fail),
  }
  if (!MESSAGE_ROLES.includes(projected.role)) fail(`${label}.role is invalid`)
  if (projected.sessionId !== input.sessionId || projected.userId !== input.userId) {
    fail(`${label} ownership does not match the request`)
  }
  const modelContext = own(source, 'modelContext', label, fail, { optional: true })
  if (modelContext !== undefined) {
    projected.modelContext = publicMessageModelContext(
      plainData(modelContext, `${label}.modelContext`, fail),
    )
  }
  const artifacts = own(source, 'artifacts', label, fail, { optional: true })
  if (artifacts !== undefined) {
    projected.artifacts = array(
      artifacts,
      `${label}.artifacts`,
      fail,
      (artifact, index) => artifactDto(artifact, `${label}.artifacts[${index}]`, fail),
      { max: 1000 },
    )
  }
  return Object.freeze(projected)
}

function snapshotDto(value, fail, input) {
  const source = record(value, 'result', fail)
  const session = sessionDto(own(source, 'session', 'result', fail), 'result.session', fail)
  if (session.id !== input.sessionId) fail('result.session.id does not match the requested session')
  const messages = array(
    own(source, 'messages', 'result', fail),
    'result.messages',
    fail,
    (message, index) => messageDto(message, `result.messages[${index}]`, fail, input),
    { max: input.limit },
  )
  const seen = new Set()
  for (const message of messages) {
    if (seen.has(message.id)) fail(`duplicate message id: ${message.id}`)
    seen.add(message.id)
  }
  const revision = integer(own(source, 'revision', 'result', fail), 'result.revision', fail)
  if (revision !== session.revision) fail('result.revision must match result.session.revision')
  const rawTurnEventRevision = own(source, 'turnEventRevision', 'result', fail, { optional: true })
  const turnEventRevision = rawTurnEventRevision === undefined
    ? undefined
    : integer(rawTurnEventRevision, 'result.turnEventRevision', fail)
  const totalMessages = integer(
    own(source, 'totalMessages', 'result', fail),
    'result.totalMessages',
    fail,
  )
  const complete = boolean(own(source, 'complete', 'result', fail), 'result.complete', fail)
  const nextOffset = integer(
    own(source, 'nextOffset', 'result', fail),
    'result.nextOffset',
    fail,
    { nullable: true },
  )
  if (messages.length > totalMessages
    || (input.offset <= totalMessages && input.offset + messages.length > totalMessages)
    || (input.offset > totalMessages && messages.length > 0)) {
    fail('result.messages conflicts with result.totalMessages')
  }
  if (complete) {
    if (nextOffset !== null
      || (input.offset <= totalMessages && input.offset + messages.length !== totalMessages)) {
      fail('completed snapshot pagination is inconsistent')
    }
  } else if (messages.length === 0
    || nextOffset !== input.offset + messages.length
    || nextOffset > totalMessages) {
    fail('incomplete snapshot pagination is inconsistent')
  }
  return Object.freeze({
    session,
    messages,
    revision,
    ...(turnEventRevision === undefined ? {} : { turnEventRevision }),
    totalMessages,
    complete,
    nextOffset,
  })
}

function branchesDto(value, fail) {
  const source = record(value, 'result', fail)
  const rootSessionId = text(
    own(source, 'rootSessionId', 'result', fail),
    'result.rootSessionId',
    fail,
    { max: 512, empty: false },
  )
  const branches = array(
    own(source, 'branches', 'result', fail),
    'result.branches',
    fail,
    (branch, index) => {
      const projected = sessionDto(branch, `result.branches[${index}]`, fail)
      const depth = integer(
        own(branch, 'depth', `result.branches[${index}]`, fail),
        `result.branches[${index}].depth`,
        fail,
        { max: 5 },
      )
      return Object.freeze({ ...projected, depth })
    },
    { max: 1000 },
  )
  if (!branches.length || branches[0].id !== rootSessionId || branches[0].depth !== 0) {
    fail('result.branches must begin with the root session at depth 0')
  }
  const byId = new Map()
  let previousDepth = -1
  for (const branch of branches) {
    if (byId.has(branch.id)) fail(`duplicate branch id: ${branch.id}`)
    if (branch.depth < previousDepth) fail('result.branches must be ordered by non-decreasing depth')
    if (branch.depth === 0) {
      if (branch.id !== rootSessionId || branch.parentSessionId !== null) {
        fail('result root branch is inconsistent')
      }
    } else {
      const parent = byId.get(branch.parentSessionId)
      if (!parent || parent.depth + 1 !== branch.depth) {
        fail(`branch ${branch.id} has an invalid parent or depth`)
      }
    }
    byId.set(branch.id, branch)
    previousDepth = branch.depth
  }
  const truncated = boolean(own(source, 'truncated', 'result', fail), 'result.truncated', fail)
  return Object.freeze({ rootSessionId, branches, truncated })
}

function legacyImportResultDto(value, fail, input) {
  const source = record(value, 'result', fail)
  const results = array(
    own(source, 'results', 'result', fail),
    'result.results',
    fail,
    (entry, index) => {
      const label = `result.results[${index}]`
      const item = record(entry, label, fail)
      const id = text(own(item, 'id', label, fail), `${label}.id`, fail, {
        max: 512,
        empty: false,
      })
      const status = text(own(item, 'status', label, fail), `${label}.status`, fail, {
        max: 32,
        empty: false,
      })
      if (!['imported', 'server_authoritative'].includes(status)) {
        fail(`${label}.status is invalid`)
      }
      const rawSessionId = own(item, 'sessionId', label, fail, { optional: true })
      const sessionId = rawSessionId === undefined
        ? id
        : text(rawSessionId, `${label}.sessionId`, fail, { max: 512, empty: false })
      const rawSession = own(item, 'session', label, fail)
      const session = rawSession === null ? null : sessionDto(rawSession, `${label}.session`, fail)
      if (session && session.id !== sessionId) {
        fail(`${label}.session.id must match ${label}.sessionId`)
      }
      if (status === 'imported' && !session) fail(`${label}.session is required for imported sessions`)
      if (sessionId !== id && !session) fail(`${label}.session is required for recovered sessions`)
      return Object.freeze({ id, sessionId, status, session })
    },
    { max: input.sessions.length },
  )
  if (results.length !== input.sessions.length) {
    fail('result.results must contain exactly one entry per requested session')
  }
  const requestedIds = new Set(input.sessions.map((session) => session.id))
  const resultIds = new Set()
  for (const entry of results) {
    if (!requestedIds.has(entry.id) || resultIds.has(entry.id)) {
      fail('result.results must match the requested session ids')
    }
    resultIds.add(entry.id)
  }
  const importedCount = integer(
    own(source, 'importedCount', 'result', fail),
    'result.importedCount',
    fail,
    { max: input.sessions.length },
  )
  const serverAuthoritativeCount = integer(
    own(source, 'serverAuthoritativeCount', 'result', fail),
    'result.serverAuthoritativeCount',
    fail,
    { max: input.sessions.length },
  )
  if (importedCount !== results.filter((entry) => entry.status === 'imported').length
    || serverAuthoritativeCount !== results.length - importedCount) {
    fail('result import counts do not match result.results')
  }
  return Object.freeze({ results, importedCount, serverAuthoritativeCount })
}

export function projectSessionAdminResult({ method, value, input, fail }) {
  if (method === 'importLegacySessions') return legacyImportResultDto(value, fail, input)
  if (method === 'searchMessages') {
    const results = array(
      value,
      'result',
      fail,
      (item, index) => searchDto(item, `result[${index}]`, fail),
      { max: input.limit },
    )
    if (input.sessionId && results.some((entry) => entry.sessionId !== input.sessionId)) {
      fail('result contains a Session outside the requested filter')
    }
    return results
  }
  if (method === 'listSessions') {
    return array(
      value,
      'result',
      fail,
      (session, index) => sessionDto(session, `result[${index}]`, fail),
      { max: input.limit },
    )
  }
  if (value === null) return null
  if (method === 'getSessionSnapshot') return snapshotDto(value, fail, input)
  if (method === 'getSessionBranches') return branchesDto(value, fail)
  if (method === 'forkSession') {
    const source = record(value, 'result', fail)
    const session = sessionDto(own(source, 'session', 'result', fail), 'result.session', fail)
    if (session.id === input.sessionId) fail('result.session.id must identify a new Session')
    const totalMessages = integer(
      own(source, 'totalMessages', 'result', fail),
      'result.totalMessages',
      fail,
    )
    return Object.freeze({ session, totalMessages })
  }
  if (method === 'replaceSessionMessages') {
    const source = record(value, 'result', fail)
    const revision = integer(own(source, 'revision', 'result', fail), 'result.revision', fail)
    const totalMessages = integer(
      own(source, 'totalMessages', 'result', fail),
      'result.totalMessages',
      fail,
    )
    if (revision !== input.expectedRevision + 1 || totalMessages !== input.messages.length) {
      fail('result does not match the committed replacement')
    }
    return Object.freeze({ revision, totalMessages })
  }
  if (method === 'deleteSession') {
    const source = record(value, 'result', fail)
    if (own(source, 'deleted', 'result', fail) !== true) fail('result.deleted must be true')
    const previousRevision = integer(
      own(source, 'previousRevision', 'result', fail),
      'result.previousRevision',
      fail,
    )
    if (previousRevision !== input.expectedRevision) {
      fail('result.previousRevision must match expectedRevision')
    }
    return Object.freeze({ deleted: true, previousRevision })
  }
  const session = sessionDto(value, 'result', fail)
  if (session.id !== input.sessionId) fail('result.id does not match the requested session')
  return session
}

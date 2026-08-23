import { types as utilTypes } from 'node:util'

export const SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION = 1

export const SUBAGENT_RUN_PERSISTENCE_PORT_METHODS = Object.freeze([
  'createRun',
  'getRun',
  'markRunning',
  'saveRunningTrace',
  'finishRun',
  'listRunningRuns',
  'interruptRunningRun',
])

const PORT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const RUN_STATUSES = new Set([
  'running',
  'paused',
  'completed',
  'failed',
  'interrupted',
  'needs_verification',
])
const preparedPorts = new WeakSet()
const preparedSnapshots = new WeakMap()
let activeBinding = null

function portError(code, message, extras = {}) {
  return Object.assign(new TypeError(message), {
    code,
    retryable: false,
    ...extras,
  })
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertRecord(value, label) {
  if (!isRecord(value)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be a plain object`,
    )
  }
  return value
}

function assertAllowedFields(value, fields, label) {
  const allowed = new Set(fields)
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== 'string' || !allowed.has(field)) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label} contains unsupported field ${String(field)}`,
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label}.${field} must be an enumerable own data property`,
      )
    }
  }
}

function boundaryField(value, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${field} must be an enumerable own data property`,
    )
  }
  return descriptor.value
}

function identity(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be a non-empty normalized string`,
    )
  }
  return value
}

function optionalIdentity(value, label) {
  if (value === null || value === undefined) return null
  return identity(value, label)
}

function stringValue(value, label, { nonEmpty = false } = {}) {
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be ${nonEmpty ? 'a non-empty ' : 'a '}string`,
    )
  }
  return value
}

function optionalInteger(value, label) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be a non-negative safe integer or null`,
    )
  }
  return value
}

function requiredInteger(value, label) {
  const normalized = optionalInteger(value, label)
  if (normalized === null) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be a non-negative safe integer`,
    )
  }
  return normalized
}

function frozenData(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object') {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must contain only plain serializable data`,
    )
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || seen.has(value)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must contain only acyclic plain serializable data`,
    )
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value)
    const unsupported = ownKeys.find((key) => (
      key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key))
    ))
    if (unsupported !== undefined) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label} contains unsupported field ${String(unsupported)}`,
      )
    }
    const result = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw portError(
          'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
          `${label}[${index}] must be an enumerable own data property`,
        )
      }
      result.push(frozenData(descriptor.value, `${label}[${index}]`, seen))
    }
    Object.freeze(result)
    seen.delete(value)
    return result
  }
  assertRecord(value, label)
  const entries = Reflect.ownKeys(value).map((key) => {
    if (typeof key !== 'string') {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label} contains unsupported field ${String(key)}`,
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label}.${key} must be an enumerable own data property`,
      )
    }
    return [key, frozenData(descriptor.value, `${label}.${key}`, seen)]
  })
  const result = Object.freeze(Object.fromEntries(entries))
  seen.delete(value)
  return result
}

function traceValue(value, label) {
  if (!Array.isArray(value)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be an array`,
    )
  }
  return frozenData(value, label)
}

function statusValue(value, label) {
  if (!RUN_STATUSES.has(value)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} is not a supported subagent run status`,
    )
  }
  return value
}

function createRunInput(input) {
  assertRecord(input, 'createRun input')
  assertAllowedFields(input, [
    'id',
    'userId',
    'parentSessionId',
    'parentMessageId',
    'agentType',
    'prompt',
    'modelName',
    'modelProviderId',
    'modelConfigRevision',
    'trace',
    'createdAt',
  ], 'createRun input')
  return Object.freeze({
    id: identity(boundaryField(input, 'id'), 'createRun input.id'),
    userId: identity(boundaryField(input, 'userId'), 'createRun input.userId'),
    parentSessionId: optionalIdentity(boundaryField(input, 'parentSessionId'), 'createRun input.parentSessionId'),
    parentMessageId: optionalIdentity(boundaryField(input, 'parentMessageId'), 'createRun input.parentMessageId'),
    agentType: identity(boundaryField(input, 'agentType'), 'createRun input.agentType'),
    prompt: stringValue(boundaryField(input, 'prompt'), 'createRun input.prompt', { nonEmpty: true }),
    modelName: optionalIdentity(boundaryField(input, 'modelName'), 'createRun input.modelName'),
    modelProviderId: optionalIdentity(boundaryField(input, 'modelProviderId'), 'createRun input.modelProviderId'),
    modelConfigRevision: optionalInteger(
      boundaryField(input, 'modelConfigRevision'),
      'createRun input.modelConfigRevision',
    ),
    trace: traceValue(boundaryField(input, 'trace') ?? [], 'createRun input.trace'),
    createdAt: requiredInteger(boundaryField(input, 'createdAt'), 'createRun input.createdAt'),
  })
}

function ownedRunInput(input, method) {
  assertRecord(input, `${method} input`)
  assertAllowedFields(input, ['userId', 'id'], `${method} input`)
  return Object.freeze({
    userId: identity(boundaryField(input, 'userId'), `${method} input.userId`),
    id: identity(boundaryField(input, 'id'), `${method} input.id`),
  })
}

function markRunningInput(input) {
  assertRecord(input, 'markRunning input')
  assertAllowedFields(input, ['userId', 'id', 'trace', 'startedAt'], 'markRunning input')
  return Object.freeze({
    userId: identity(boundaryField(input, 'userId'), 'markRunning input.userId'),
    id: identity(boundaryField(input, 'id'), 'markRunning input.id'),
    trace: traceValue(boundaryField(input, 'trace'), 'markRunning input.trace'),
    startedAt: optionalInteger(boundaryField(input, 'startedAt'), 'markRunning input.startedAt'),
  })
}

function saveRunningTraceInput(input) {
  assertRecord(input, 'saveRunningTrace input')
  assertAllowedFields(
    input,
    ['userId', 'id', 'trace', 'checkpointWriteSequence'],
    'saveRunningTrace input',
  )
  const checkpointWriteSequence = optionalInteger(
    boundaryField(input, 'checkpointWriteSequence'),
    'saveRunningTrace input.checkpointWriteSequence',
  )
  if (checkpointWriteSequence === 0) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      'saveRunningTrace input.checkpointWriteSequence must be positive or null',
    )
  }
  return Object.freeze({
    userId: identity(boundaryField(input, 'userId'), 'saveRunningTrace input.userId'),
    id: identity(boundaryField(input, 'id'), 'saveRunningTrace input.id'),
    trace: traceValue(boundaryField(input, 'trace'), 'saveRunningTrace input.trace'),
    ...(checkpointWriteSequence === null ? {} : { checkpointWriteSequence }),
  })
}

function checkpointWriteSequenceFromTrace(trace) {
  let highestSequence = null
  for (const event of trace) {
    if (event?.type !== 'runtime_checkpoint') continue
    const sequence = event?.state?.checkpointWriteSequence
    if (Number.isSafeInteger(sequence) && sequence > 0
        && (highestSequence === null || sequence > highestSequence)) {
      highestSequence = sequence
    }
  }
  return highestSequence
}

function saveRunningTraceOutput(output, input) {
  const result = runOutput(output, 'saveRunningTrace', input)
  if (input.checkpointWriteSequence == null) return result
  const persistedSequence = checkpointWriteSequenceFromTrace(result.trace)
  if (persistedSequence === null || persistedSequence < input.checkpointWriteSequence) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_STALE_CHECKPOINT',
      'saveRunningTrace did not persist the requested checkpoint write sequence',
      {
        requestedSequence: input.checkpointWriteSequence,
        persistedSequence,
      },
    )
  }
  return result
}

function terminalInput(input, method) {
  assertRecord(input, `${method} input`)
  assertAllowedFields(
    input,
    ['userId', 'id', 'status', 'resultText', 'trace', 'finishedAt'],
    `${method} input`,
  )
  const status = statusValue(boundaryField(input, 'status'), `${method} input.status`)
  if (method === 'finishRun' && status === 'running') {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      'finishRun input.status must be terminal',
    )
  }
  if (method === 'interruptRunningRun' && status !== 'interrupted') {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      'interruptRunningRun input.status must be interrupted',
    )
  }
  return Object.freeze({
    userId: identity(boundaryField(input, 'userId'), `${method} input.userId`),
    id: identity(boundaryField(input, 'id'), `${method} input.id`),
    status,
    resultText: stringValue(boundaryField(input, 'resultText') ?? '', `${method} input.resultText`),
    trace: traceValue(boundaryField(input, 'trace') ?? [], `${method} input.trace`),
    finishedAt: requiredInteger(boundaryField(input, 'finishedAt'), `${method} input.finishedAt`),
  })
}

function runOutput(output, method, input, { nullable = false } = {}) {
  if (output === null && nullable) return null
  assertRecord(output, `${method} output`)
  assertAllowedFields(output, [
    'id',
    'userId',
    'parentSessionId',
    'parentMessageId',
    'agentType',
    'prompt',
    'modelName',
    'modelProviderId',
    'modelConfigRevision',
    'status',
    'resultText',
    'trace',
    'tokensIn',
    'tokensOut',
    'createdAt',
    'finishedAt',
  ], `${method} output`)
  const result = Object.freeze({
    id: identity(boundaryField(output, 'id'), `${method} output.id`),
    userId: identity(boundaryField(output, 'userId'), `${method} output.userId`),
    parentSessionId: optionalIdentity(boundaryField(output, 'parentSessionId'), `${method} output.parentSessionId`),
    parentMessageId: optionalIdentity(boundaryField(output, 'parentMessageId'), `${method} output.parentMessageId`),
    agentType: identity(boundaryField(output, 'agentType'), `${method} output.agentType`),
    prompt: stringValue(boundaryField(output, 'prompt'), `${method} output.prompt`, { nonEmpty: true }),
    modelName: optionalIdentity(boundaryField(output, 'modelName'), `${method} output.modelName`),
    modelProviderId: optionalIdentity(boundaryField(output, 'modelProviderId'), `${method} output.modelProviderId`),
    modelConfigRevision: optionalInteger(
      boundaryField(output, 'modelConfigRevision'),
      `${method} output.modelConfigRevision`,
    ),
    status: statusValue(boundaryField(output, 'status'), `${method} output.status`),
    resultText: stringValue(boundaryField(output, 'resultText') ?? '', `${method} output.resultText`),
    trace: traceValue(boundaryField(output, 'trace') ?? [], `${method} output.trace`),
    tokensIn: optionalInteger(boundaryField(output, 'tokensIn'), `${method} output.tokensIn`),
    tokensOut: optionalInteger(boundaryField(output, 'tokensOut'), `${method} output.tokensOut`),
    createdAt: requiredInteger(boundaryField(output, 'createdAt'), `${method} output.createdAt`),
    finishedAt: optionalInteger(boundaryField(output, 'finishedAt'), `${method} output.finishedAt`),
  })
  if (input?.userId && result.userId !== input.userId) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_IDENTITY_MISMATCH',
      `${method} output.userId does not match the requested owner`,
    )
  }
  if (input?.id && result.id !== input.id) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_IDENTITY_MISMATCH',
      `${method} output.id does not match the requested run`,
    )
  }
  return result
}

function runningRunsOutput(output) {
  if (!Array.isArray(output)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      'listRunningRuns output must be an array',
    )
  }
  const ids = new Set()
  const entries = frozenData(output, 'listRunningRuns output')
  return Object.freeze(entries.map((entry) => {
    const run = runOutput(entry, 'listRunningRuns', null)
    if (run.status !== 'running') {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        'listRunningRuns output may contain only running runs',
      )
    }
    const key = `${run.userId}\u0000${run.id}`
    if (ids.has(key)) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        'listRunningRuns output contains a duplicate owner/run identity',
      )
    }
    ids.add(key)
    return run
  }))
}

function interruptOutput(output, input) {
  assertRecord(output, 'interruptRunningRun output')
  assertAllowedFields(output, ['userId', 'id', 'interrupted'], 'interruptRunningRun output')
  const result = Object.freeze({
    userId: identity(boundaryField(output, 'userId'), 'interruptRunningRun output.userId'),
    id: identity(boundaryField(output, 'id'), 'interruptRunningRun output.id'),
    interrupted: boundaryField(output, 'interrupted'),
  })
  if (typeof result.interrupted !== 'boolean') {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      'interruptRunningRun output.interrupted must be a boolean',
    )
  }
  if (result.userId !== input.userId || result.id !== input.id) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_IDENTITY_MISMATCH',
      'interruptRunningRun output identity does not match its input',
    )
  }
  return result
}

function normalizeResult(result, validate) {
  if (utilTypes.isPromise(result)) {
    return Promise.prototype.then.call(result, validate)
  }
  if (result && (typeof result === 'object' || typeof result === 'function')) {
    const descriptor = Object.getOwnPropertyDescriptor(result, 'then')
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw portError(
          'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
          'subagent run persistence result.then must be an own data function',
        )
      }
      return new Promise((resolve, reject) => {
        try {
          descriptor.value.call(result, resolve, reject)
        } catch (error) {
          reject(error)
        }
      }).then(validate)
    }
  }
  return validate(result)
}

function ownDataValue(candidate, field) {
  const descriptor = Object.getOwnPropertyDescriptor(candidate, field)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_INVALID',
      `subagent run persistence port ${field} must be an own data property`,
    )
  }
  return descriptor.value
}

export function prepareSubagentRunPersistencePort(candidate) {
  if (preparedPorts.has(candidate)) return candidate
  if (candidate && preparedSnapshots.has(candidate)) return preparedSnapshots.get(candidate)
  assertRecord(candidate, 'subagent run persistence port')
  const id = ownDataValue(candidate, 'id')
  const apiVersion = ownDataValue(candidate, 'apiVersion')
  if (typeof id !== 'string' || !PORT_ID_PATTERN.test(id)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_INVALID',
      'subagent run persistence port id is invalid',
    )
  }
  if (apiVersion !== SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_VERSION_UNSUPPORTED',
      `subagent run persistence port ${id} requires apiVersion ${SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION}`,
    )
  }
  const methods = Object.fromEntries(SUBAGENT_RUN_PERSISTENCE_PORT_METHODS.map((name) => {
    const method = ownDataValue(candidate, name)
    if (typeof method !== 'function') {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_INVALID',
        `subagent run persistence port ${id} must implement ${name}()`,
      )
    }
    return [name, method]
  }))

  const prepared = Object.freeze({
    id,
    apiVersion,
    createRun(input) {
      const normalized = createRunInput(input)
      return normalizeResult(methods.createRun(normalized), (output) => (
        runOutput(output, 'createRun', normalized)
      ))
    },
    getRun(input) {
      const normalized = ownedRunInput(input, 'getRun')
      return normalizeResult(methods.getRun(normalized), (output) => (
        runOutput(output, 'getRun', normalized, { nullable: true })
      ))
    },
    markRunning(input) {
      const normalized = markRunningInput(input)
      return normalizeResult(methods.markRunning(normalized), (output) => (
        runOutput(output, 'markRunning', normalized)
      ))
    },
    saveRunningTrace(input) {
      const normalized = saveRunningTraceInput(input)
      return normalizeResult(methods.saveRunningTrace(normalized), (output) => (
        saveRunningTraceOutput(output, normalized)
      ))
    },
    finishRun(input) {
      const normalized = terminalInput(input, 'finishRun')
      return normalizeResult(methods.finishRun(normalized), (output) => (
        runOutput(output, 'finishRun', normalized, { nullable: true })
      ))
    },
    listRunningRuns() {
      return normalizeResult(methods.listRunningRuns(), runningRunsOutput)
    },
    interruptRunningRun(input) {
      const normalized = terminalInput(input, 'interruptRunningRun')
      return normalizeResult(methods.interruptRunningRun(normalized), (output) => (
        interruptOutput(output, normalized)
      ))
    },
  })
  preparedPorts.add(prepared)
  preparedSnapshots.set(candidate, prepared)
  preparedSnapshots.set(prepared, prepared)
  return prepared
}

export function assertSubagentRunPersistencePort(candidate) {
  return prepareSubagentRunPersistencePort(candidate)
}

export function createSubagentRunPersistencePortController(input, {
  source = 'host.lifecycle',
} = {}) {
  const port = prepareSubagentRunPersistencePort(input)
  const normalizedSource = identity(String(source || '').trim(), 'subagent persistence source')
  let binding = null
  return Object.freeze({
    portId: port.id,
    activate() {
      if (binding) return port
      if (activeBinding) {
        throw portError(
          'SUBAGENT_RUN_PERSISTENCE_PORT_ALREADY_ACTIVE',
          `subagent run persistence port ${activeBinding.port.id} is already active`,
        )
      }
      binding = Object.freeze({ port, source: normalizedSource })
      activeBinding = binding
      return port
    },
    release() {
      if (!binding) return false
      if (activeBinding !== binding) {
        throw portError(
          'SUBAGENT_RUN_PERSISTENCE_PORT_BINDING_STALE',
          `subagent run persistence port ${port.id} binding is no longer authoritative`,
        )
      }
      activeBinding = null
      binding = null
      return true
    },
  })
}

export function getActiveSubagentRunPersistencePort() {
  if (!activeBinding) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_NOT_CONFIGURED',
      'Subagent run persistence is not configured',
      { statusCode: 503 },
    )
  }
  return activeBinding.port
}

export function getSubagentRunPersistencePortStatus() {
  return Object.freeze({
    configured: Boolean(activeBinding),
    portId: activeBinding?.port.id || null,
    apiVersion: SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
    source: activeBinding?.source || null,
  })
}

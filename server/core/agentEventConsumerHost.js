import { types as utilTypes } from 'node:util'

import {
  parseTurnEventTransportEnvelope,
  TURN_EVENT_TRANSPORT_TYPE,
  TURN_EVENT_TRANSPORT_VERSION,
  TURN_EVENT_TYPES,
} from '../../shared/turnEvents.js'

export const AGENT_EVENT_CONSUMER_CONTRACT_VERSION = 1

const CONSUMER_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const EVENT_TYPE_SET = new Set(TURN_EVENT_TYPES)
const DEFINITION_FIELDS = new Set(['id', 'contractVersion', 'eventTypes', 'listener'])
const MAX_SNAPSHOT_DEPTH = 32
const MAX_SNAPSHOT_NODES = 32_768
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

function isCanonicalArrayIndex(key, length) {
  if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index < length && String(index) === key
}

function consumerError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function ownDataValue(target, field, label, { required = true } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, field)
  } catch {
    descriptor = null
  }
  if (!descriptor) {
    if (!required) return undefined
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      `${label} must declare own data property ${field}`,
    )
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      `${label}.${field} must be an own data property`,
    )
  }
  return descriptor.value
}

function assertDefinitionShape(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)
    || utilTypes.isProxy(definition)) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      'agent event consumer definition must be a non-Proxy object',
    )
  }
  let keys
  try {
    keys = Reflect.ownKeys(definition)
  } catch {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      'agent event consumer definition cannot be inspected safely',
    )
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !DEFINITION_FIELDS.has(key)) {
      throw consumerError(
        'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
        `agent event consumer definition contains unsupported field ${String(key)}`,
      )
    }
  }
}

function normalizeEventTypes(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      'agent event consumer eventTypes must be a non-Proxy array',
    )
  }
  const length = ownDataValue(value, 'length', 'agent event consumer eventTypes')
  if (!Number.isSafeInteger(length) || length < 1 || length > TURN_EVENT_TYPES.length) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      `agent event consumer eventTypes must contain 1..${TURN_EVENT_TYPES.length} entries`,
    )
  }
  const eventTypes = []
  const seen = new Set()
  for (let index = 0; index < length; index += 1) {
    const eventType = ownDataValue(
      value,
      String(index),
      'agent event consumer eventTypes',
    )
    if (typeof eventType !== 'string' || !EVENT_TYPE_SET.has(eventType)) {
      throw consumerError(
        'AGENT_EVENT_CONSUMER_EVENT_UNSUPPORTED',
        `agent event consumer eventTypes[${index}] is not a supported Turn event`,
      )
    }
    if (seen.has(eventType)) {
      throw consumerError(
        'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
        `agent event consumer eventTypes contains duplicate ${eventType}`,
      )
    }
    seen.add(eventType)
    eventTypes.push(eventType)
  }
  let keys
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      'agent event consumer eventTypes cannot be inspected safely',
    )
  }
  if (keys.some((key) => (
    typeof key !== 'string'
    || (key !== 'length' && !isCanonicalArrayIndex(key, length))
  ))) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      'agent event consumer eventTypes must be a dense array without extra properties',
    )
  }
  return Object.freeze(eventTypes)
}

function normalizeDefinition(definition) {
  assertDefinitionShape(definition)
  const id = ownDataValue(definition, 'id', 'agent event consumer definition')
  if (typeof id !== 'string' || !CONSUMER_ID_RE.test(id)) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      'agent event consumer id must match [a-z0-9][a-z0-9._:-]{0,127}',
    )
  }
  const contractVersion = ownDataValue(
    definition,
    'contractVersion',
    'agent event consumer definition',
  )
  if (contractVersion !== AGENT_EVENT_CONSUMER_CONTRACT_VERSION) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_VERSION_UNSUPPORTED',
      `agent event consumer ${id} contractVersion ${String(contractVersion)} is unsupported`,
    )
  }
  const eventTypes = normalizeEventTypes(ownDataValue(
    definition,
    'eventTypes',
    'agent event consumer definition',
  ))
  const listener = ownDataValue(definition, 'listener', 'agent event consumer definition')
  if (typeof listener !== 'function' || utilTypes.isProxy(listener)) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
      'agent event consumer listener must be a non-Proxy function data property',
    )
  }
  return Object.freeze({ id, contractVersion, eventTypes, listener })
}

function snapshotFailure(label, reason) {
  return consumerError(
    'AGENT_EVENT_ENVELOPE_INVALID',
    `${label} must be detached plain data${reason ? `: ${reason}` : ''}`,
  )
}

function addSnapshotBytes(state, value, label) {
  state.bytes += Buffer.byteLength(value, 'utf8')
  if (state.bytes > MAX_SNAPSHOT_BYTES) {
    throw snapshotFailure(label, 'size exceeds 16 MiB')
  }
}

function snapshotPlainData(value, state, label, depth = 0) {
  if (depth > MAX_SNAPSHOT_DEPTH) throw snapshotFailure(label, 'maximum depth exceeded')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    addSnapshotBytes(state, value, label)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw snapshotFailure(label, 'numbers must be finite')
    return Object.is(value, -0) ? 0 : value
  }
  if (!value || typeof value !== 'object') {
    throw snapshotFailure(label, 'functions, undefined, symbols, and bigint are not supported')
  }
  if (utilTypes.isProxy(value)) throw snapshotFailure(label, 'Proxy values are not supported')
  if (state.seen.has(value)) throw snapshotFailure(label, 'cycles are not supported')
  state.nodes += 1
  if (state.nodes > MAX_SNAPSHOT_NODES) throw snapshotFailure(label, 'node limit exceeded')
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      const length = lengthDescriptor?.value
      if (!lengthDescriptor || !Number.isSafeInteger(length) || length < 0
        || length > MAX_SNAPSHOT_NODES) {
        throw snapshotFailure(label, 'array length is invalid')
      }
      const keys = Reflect.ownKeys(value)
      if (keys.some((key) => (
        typeof key !== 'string'
        || (key !== 'length' && !isCanonicalArrayIndex(key, length))
      ))) {
        throw snapshotFailure(label, 'arrays must be dense and have no extra properties')
      }
      const output = new Array(length)
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw snapshotFailure(label, 'arrays must contain only dense data properties')
        }
        output[index] = snapshotPlainData(
          descriptor.value,
          state,
          `${label}[${index}]`,
          depth + 1,
        )
      }
      return output
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw snapshotFailure(label, 'objects must have a plain prototype')
    }
    const output = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw snapshotFailure(label, 'symbol keys are not supported')
      addSnapshotBytes(state, key, label)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw snapshotFailure(`${label}.${key}`, 'accessors are not supported')
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotPlainData(descriptor.value, state, `${label}.${key}`, depth + 1),
      })
    }
    return output
  } catch (error) {
    if (error?.code === 'AGENT_EVENT_ENVELOPE_INVALID') throw error
    throw snapshotFailure(label, 'value cannot be inspected safely')
  } finally {
    state.seen.delete(value)
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

function detachedEnvelope(value) {
  let input
  try {
    input = snapshotPlainData(
      value,
      { seen: new WeakSet(), nodes: 0, bytes: 0 },
      'agent event envelope',
    )
  } catch (error) {
    if (error?.code === 'AGENT_EVENT_ENVELOPE_INVALID') throw error
    throw snapshotFailure('agent event envelope', 'value cannot be inspected safely')
  }
  let parsed
  try {
    parsed = parseTurnEventTransportEnvelope(input)
  } catch {
    throw consumerError(
      'AGENT_EVENT_ENVELOPE_INVALID',
      `agent event envelope must be ${TURN_EVENT_TRANSPORT_TYPE} v${TURN_EVENT_TRANSPORT_VERSION}`,
    )
  }
  const detached = snapshotPlainData(
    parsed,
    { seen: new WeakSet(), nodes: 0, bytes: 0 },
    'agent event envelope',
  )
  return deepFreeze(detached)
}

function safeFailureMessage(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')
    || utilTypes.isProxy(error)) return 'agent event consumer listener failed'
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value.slice(0, 512)
      : 'agent event consumer listener failed'
  } catch {
    return 'agent event consumer listener failed'
  }
}

function observeFailure(callback, failure) {
  if (!callback) return
  try {
    const completion = callback(failure)
    if (utilTypes.isPromise(completion)) {
      Promise.prototype.then.call(completion, undefined, () => {})
    }
  } catch {
    // Observability is non-authoritative.
  }
}

export function createAgentEventConsumerHost({ onListenerError = null } = {}) {
  if (onListenerError !== null
    && (typeof onListenerError !== 'function' || utilTypes.isProxy(onListenerError))) {
    throw consumerError(
      'AGENT_EVENT_CONSUMER_HOST_INVALID',
      'onListenerError must be a non-Proxy function or null',
    )
  }
  const active = new Map()
  const retiring = new Map()
  let closed = false
  let shutdownPromise = null

  const enqueue = (record, envelope) => {
    const delivery = record.tail.then(async () => {
      try {
        const completion = record.definition.listener(envelope)
        if (utilTypes.isPromise(completion)) await completion
        return Object.freeze({ ok: true, consumerId: record.definition.id })
      } catch (error) {
        const failure = deepFreeze({
          code: 'AGENT_EVENT_CONSUMER_LISTENER_FAILED',
          consumerId: record.definition.id,
          eventId: envelope.event.id,
          eventType: envelope.event.type,
          eventSequence: envelope.event.sequence,
          message: safeFailureMessage(error),
        })
        observeFailure(onListenerError, failure)
        return Object.freeze({ ok: false, consumerId: record.definition.id })
      }
    })
    record.tail = delivery.then(() => undefined, () => undefined)
    return delivery
  }

  const revokeRecord = (record) => {
    if (record.revokePromise) return record.revokePromise
    record.accepting = false
    active.delete(record.definition.id)
    retiring.set(record.definition.id, record)
    record.revokePromise = record.tail.then(() => {
      if (retiring.get(record.definition.id) === record) retiring.delete(record.definition.id)
      return true
    })
    return record.revokePromise
  }

  const register = (input) => {
    if (closed) {
      throw consumerError(
        'AGENT_EVENT_CONSUMER_HOST_CLOSED',
        'agent event consumer host is closed',
      )
    }
    const definition = normalizeDefinition(input)
    if (active.has(definition.id) || retiring.has(definition.id)) {
      throw consumerError(
        'AGENT_EVENT_CONSUMER_DUPLICATE',
        `agent event consumer ${definition.id} is already registered or draining`,
      )
    }
    const record = {
      definition,
      accepting: true,
      tail: Promise.resolve(),
      revokePromise: null,
    }
    active.set(definition.id, record)
    return Object.freeze({
      id: definition.id,
      contractVersion: definition.contractVersion,
      eventTypes: definition.eventTypes,
      revoke: () => revokeRecord(record),
    })
  }

  const publish = (value) => {
    if (closed) {
      throw consumerError(
        'AGENT_EVENT_CONSUMER_HOST_CLOSED',
        'agent event consumer host is closed',
      )
    }
    const envelope = detachedEnvelope(value)
    const deliveries = []
    for (const record of active.values()) {
      if (record.accepting && record.definition.eventTypes.includes(envelope.event.type)) {
        deliveries.push(enqueue(record, envelope))
      }
    }
    return Promise.all(deliveries).then((outcomes) => {
      const delivered = outcomes.filter((outcome) => outcome.ok).length
      return deepFreeze({
        eventId: envelope.event.id,
        eventType: envelope.event.type,
        eventSequence: envelope.event.sequence,
        attempted: outcomes.length,
        delivered,
        failed: outcomes.length - delivered,
      })
    })
  }

  const listConsumers = () => Object.freeze([...active.values()].map((record) => Object.freeze({
    id: record.definition.id,
    contractVersion: record.definition.contractVersion,
    eventTypes: record.definition.eventTypes,
  })))

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    closed = true
    const records = new Set([...retiring.values(), ...active.values()])
    shutdownPromise = Promise.all([...records].map(revokeRecord)).then(() => true)
    return shutdownPromise
  }

  return Object.freeze({
    contractVersion: AGENT_EVENT_CONSUMER_CONTRACT_VERSION,
    register,
    publish,
    listConsumers,
    shutdown,
  })
}

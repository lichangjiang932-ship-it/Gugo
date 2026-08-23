import { isDeepStrictEqual } from 'node:util'
import { isPromise, isProxy, isSharedArrayBuffer } from 'node:util/types'

export const LOOP_HARNESS_SESSION_API_VERSION = 1

export const LOOP_HARNESS_SESSION_LIMITS = Object.freeze({
  metadataBytes: 64 * 1024,
  bindingBytes: 32 * 1024,
  sessionDataBytes: 80 * 1024,
  modelRequestBytes: 2 * 1024 * 1024,
  modelResultBytes: 4 * 1024 * 1024,
  toolRequestBytes: 1024 * 1024,
  toolResultBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 50_000,
})

export const LOOP_HARNESS_SESSION_ERROR_CODES = Object.freeze({
  INVALID: 'LOOP_HARNESS_SESSION_INVALID',
  BOUNDARY_INVALID: 'LOOP_HARNESS_SESSION_BOUNDARY_INVALID',
  PAYLOAD_TOO_LARGE: 'LOOP_HARNESS_SESSION_PAYLOAD_TOO_LARGE',
  BINDING_STALE: 'LOOP_HARNESS_SESSION_BINDING_STALE',
  MODEL_BROKER_UNAVAILABLE: 'LOOP_HARNESS_MODEL_BROKER_UNAVAILABLE',
  TOOL_BROKER_UNAVAILABLE: 'LOOP_HARNESS_TOOL_BROKER_UNAVAILABLE',
  MODEL_BROKER_FAILED: 'LOOP_HARNESS_MODEL_BROKER_FAILED',
  TOOL_BROKER_FAILED: 'LOOP_HARNESS_TOOL_BROKER_FAILED',
})

const OPTION_FIELDS = new Set(['lease', 'metadata', 'brokers'])
const BROKER_FIELDS = new Set(['modelRequest', 'toolsExecute'])
const sessionStates = new WeakMap()
const modelFacadeStates = new WeakMap()
const toolFacadeStates = new WeakMap()
const issuedSessionErrors = new WeakSet()

function sessionError(code, message, extras = {}) {
  const error = Object.assign(new TypeError(message), {
    code,
    retryable: false,
    ...extras,
  })
  issuedSessionErrors.add(error)
  return error
}

function invalid(message) {
  return sessionError(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID, message)
}

function boundaryInvalid(message) {
  return sessionError(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID, message)
}

function tooLarge(label, limitBytes) {
  return sessionError(
    LOOP_HARNESS_SESSION_ERROR_CODES.PAYLOAD_TOO_LARGE,
    `${label} exceeds its ${limitBytes}-byte limit`,
    { limitBytes },
  )
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function ownDataValue(record, field, label, { required = false } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, field)
  } catch {
    throw invalid(`${label} could not be inspected safely`)
  }
  if (!descriptor) {
    if (!required) return undefined
    throw invalid(`${label}.${field} is required`)
  }
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    throw invalid(`${label}.${field} must be an enumerable own data property`)
  }
  return descriptor.value
}

function assertAllowedFields(record, allowed, label) {
  let keys
  try {
    keys = Reflect.ownKeys(record)
  } catch {
    throw invalid(`${label} could not be inspected safely`)
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw invalid(`${label} contains unsupported field ${String(key)}`)
    }
    ownDataValue(record, key, label, { required: true })
  }
}

function addBytes(context, count) {
  context.bytes += count
  if (context.bytes > context.limitBytes) {
    throw tooLarge(context.label, context.limitBytes)
  }
}

function inspectPureData(value, context, path, depth = 0) {
  context.nodes += 1
  if (context.nodes > LOOP_HARNESS_SESSION_LIMITS.maxNodes) {
    throw tooLarge(context.label, context.limitBytes)
  }
  if (depth > LOOP_HARNESS_SESSION_LIMITS.maxDepth) {
    throw boundaryInvalid(`${path} exceeds the maximum nesting depth`)
  }
  if (value === null) {
    addBytes(context, 4)
    return
  }
  if (typeof value === 'string') {
    addBytes(context, Buffer.byteLength(JSON.stringify(value), 'utf8'))
    return
  }
  if (typeof value === 'boolean') {
    addBytes(context, value ? 4 : 5)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw boundaryInvalid(`${path} must be a finite number`)
    }
    addBytes(context, Buffer.byteLength(String(value), 'utf8'))
    return
  }
  if (!value || typeof value !== 'object') {
    throw boundaryInvalid(`${path} contains non-cloneable data`)
  }
  if (isProxy(value)) {
    throw boundaryInvalid(`${path} must not contain a Proxy`)
  }
  if (isSharedArrayBuffer(value)
    || (ArrayBuffer.isView(value) && isSharedArrayBuffer(value.buffer))) {
    throw boundaryInvalid(`${path} must not contain shared memory`)
  }
  if (context.ancestors.has(value)) {
    throw boundaryInvalid(`${path} must not contain cycles`)
  }
  context.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      addBytes(context, 2)
      let keys
      try {
        keys = Reflect.ownKeys(value)
      } catch {
        throw boundaryInvalid(`${path} could not be inspected safely`)
      }
      if (keys.length !== value.length + 1 || !keys.includes('length')) {
        throw boundaryInvalid(`${path} must be a dense plain-data array`)
      }
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index)
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          throw boundaryInvalid(`${path}[${index}] must be an enumerable own data property`)
        }
        if (index > 0) addBytes(context, 1)
        inspectPureData(descriptor.value, context, `${path}[${index}]`, depth + 1)
      }
      return
    }
    if (!isPlainObject(value)) {
      throw boundaryInvalid(`${path} must contain only plain objects and arrays`)
    }
    addBytes(context, 2)
    let keys
    try {
      keys = Reflect.ownKeys(value)
    } catch {
      throw boundaryInvalid(`${path} could not be inspected safely`)
    }
    keys.forEach((key, index) => {
      if (typeof key !== 'string') {
        throw boundaryInvalid(`${path} contains an unsupported symbol field`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw boundaryInvalid(`${path}.${key} must be an enumerable own data property`)
      }
      if (index > 0) addBytes(context, 1)
      addBytes(context, Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)
      inspectPureData(descriptor.value, context, `${path}.${key}`, depth + 1)
    })
  } finally {
    context.ancestors.delete(value)
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length' && Array.isArray(value)) continue
    deepFreeze(Object.getOwnPropertyDescriptor(value, key)?.value, seen)
  }
  return Object.freeze(value)
}

function cloneFrozenData(value, label, limitBytes) {
  const context = {
    ancestors: new WeakSet(),
    bytes: 0,
    label,
    limitBytes,
    nodes: 0,
  }
  inspectPureData(value, context, label)
  let clone
  try {
    clone = structuredClone(value)
  } catch {
    throw boundaryInvalid(`${label} could not be structurally cloned`)
  }
  return { value: deepFreeze(clone), bytes: context.bytes }
}

function prepareLease(lease) {
  if (!isPlainObject(lease)) {
    throw invalid('loop harness session lease must be a non-proxy plain object')
  }
  const assertActive = ownDataValue(lease, 'assertActive', 'loop harness session lease', {
    required: true,
  })
  if (typeof assertActive !== 'function' || isProxy(assertActive)) {
    throw invalid('loop harness session lease.assertActive must be a non-proxy function')
  }
  return Object.freeze({ lease, assertActive })
}

function prepareBrokers(brokers) {
  if (brokers === undefined) return Object.freeze({ modelRequest: null, toolsExecute: null })
  if (!isPlainObject(brokers)) {
    throw invalid('loop harness session brokers must be a non-proxy plain object')
  }
  assertAllowedFields(brokers, BROKER_FIELDS, 'loop harness session brokers')
  const result = {}
  for (const field of BROKER_FIELDS) {
    const broker = ownDataValue(brokers, field, 'loop harness session brokers')
    if (broker !== undefined && (typeof broker !== 'function' || isProxy(broker))) {
      throw invalid(`loop harness session brokers.${field} must be a non-proxy function`)
    }
    result[field] = broker || null
  }
  return Object.freeze(result)
}

function assertLeaseActive(state) {
  const binding = Reflect.apply(state.assertActive, state.lease, [])
  const current = cloneFrozenData(
    binding,
    'loop harness session binding',
    LOOP_HARNESS_SESSION_LIMITS.bindingBytes,
  ).value
  if (!isDeepStrictEqual(current, state.binding)) {
    throw sessionError(
      LOOP_HARNESS_SESSION_ERROR_CODES.BINDING_STALE,
      'loop harness session binding is no longer authoritative',
    )
  }
}

function unavailable(kind) {
  const model = kind === 'model'
  return sessionError(
    model
      ? LOOP_HARNESS_SESSION_ERROR_CODES.MODEL_BROKER_UNAVAILABLE
      : LOOP_HARNESS_SESSION_ERROR_CODES.TOOL_BROKER_UNAVAILABLE,
    `${model ? 'Model' : 'Tool'} broker is not configured for this Loop run`,
    { statusCode: 503 },
  )
}

function brokerFailed(kind) {
  const model = kind === 'model'
  return sessionError(
    model
      ? LOOP_HARNESS_SESSION_ERROR_CODES.MODEL_BROKER_FAILED
      : LOOP_HARNESS_SESSION_ERROR_CODES.TOOL_BROKER_FAILED,
    `${model ? 'Model' : 'Tool'} broker failed for this Loop run`,
    { statusCode: 503 },
  )
}

function normalizeBrokerFailure(kind, error) {
  if (
    error
    && (typeof error === 'object' || typeof error === 'function')
    && issuedSessionErrors.has(error)
  ) {
    return error
  }
  return brokerFailed(kind)
}

function finishBrokerResult(state, value, label, limitBytes) {
  assertLeaseActive(state)
  try {
    return cloneFrozenData(value, label, limitBytes).value
  } finally {
    assertLeaseActive(state)
  }
}

function invokeBroker(state, kind, input) {
  assertLeaseActive(state)
  const model = kind === 'model'
  const requestLabel = `loop harness ${kind} request`
  const requestLimit = model
    ? LOOP_HARNESS_SESSION_LIMITS.modelRequestBytes
    : LOOP_HARNESS_SESSION_LIMITS.toolRequestBytes
  const resultLabel = `loop harness ${kind} result`
  const resultLimit = model
    ? LOOP_HARNESS_SESSION_LIMITS.modelResultBytes
    : LOOP_HARNESS_SESSION_LIMITS.toolResultBytes
  let request
  try {
    request = cloneFrozenData(input, requestLabel, requestLimit).value
  } catch (error) {
    assertLeaseActive(state)
    throw error
  }
  const broker = model ? state.modelRequest : state.toolsExecute
  if (!broker) {
    assertLeaseActive(state)
    throw unavailable(kind)
  }
  assertLeaseActive(state)
  let result
  try {
    result = Reflect.apply(broker, undefined, [request])
  } catch (error) {
    assertLeaseActive(state)
    throw normalizeBrokerFailure(kind, error)
  }
  if (isProxy(result)) {
    assertLeaseActive(state)
    throw boundaryInvalid(`${resultLabel} must not be a Proxy`)
  }
  if (isPromise(result)) {
    if (Object.getPrototypeOf(result) !== Promise.prototype) {
      assertLeaseActive(state)
      throw boundaryInvalid(`${resultLabel} must be a plain native Promise`)
    }
    // Observe a later rejection before checking the lease. A broker may revoke
    // its run and still return a pending Promise; the lease error must remain
    // synchronous without leaving that now-unreturnable Promise unhandled.
    Promise.prototype.then.call(result, undefined, () => undefined)
    assertLeaseActive(state)
    const publicResult = Promise.prototype.then.call(
      result,
      (value) => finishBrokerResult(state, value, resultLabel, resultLimit),
      (error) => {
        assertLeaseActive(state)
        throw normalizeBrokerFailure(kind, error)
      },
    )
    // An adapter may deliberately start broker work and then fail before it can
    // await the returned Promise. Observe this public projection as well as the
    // broker Promise so lease revocation cannot surface as an unhandled rejection.
    Promise.prototype.then.call(publicResult, undefined, () => undefined)
    return publicResult
  }
  return finishBrokerResult(state, result, resultLabel, resultLimit)
}

function assertFacade(receiver, expectedState, brands, label) {
  if (!receiver || brands.get(receiver) !== expectedState) {
    throw invalid(`${label} method cannot be borrowed or called without its issued receiver`)
  }
}

export function createLoopHarnessSession(options) {
  if (!isPlainObject(options)) {
    throw invalid('loop harness session options must be a non-proxy plain object')
  }
  assertAllowedFields(options, OPTION_FIELDS, 'loop harness session options')
  const preparedLease = prepareLease(ownDataValue(
    options,
    'lease',
    'loop harness session options',
    { required: true },
  ))
  const metadataSnapshot = cloneFrozenData(
    ownDataValue(options, 'metadata', 'loop harness session options') ?? {},
    'loop harness session metadata',
    LOOP_HARNESS_SESSION_LIMITS.metadataBytes,
  )
  const authoritativeBinding = Reflect.apply(
    preparedLease.assertActive,
    preparedLease.lease,
    [],
  )
  const bindingSnapshot = cloneFrozenData(
    authoritativeBinding,
    'loop harness session binding',
    LOOP_HARNESS_SESSION_LIMITS.bindingBytes,
  )
  if (metadataSnapshot.bytes + bindingSnapshot.bytes
    > LOOP_HARNESS_SESSION_LIMITS.sessionDataBytes) {
    throw tooLarge(
      'loop harness session metadata and binding',
      LOOP_HARNESS_SESSION_LIMITS.sessionDataBytes,
    )
  }
  const brokers = prepareBrokers(ownDataValue(
    options,
    'brokers',
    'loop harness session options',
  ))
  const state = Object.freeze({
    ...preparedLease,
    binding: bindingSnapshot.value,
    modelRequest: brokers.modelRequest,
    toolsExecute: brokers.toolsExecute,
  })
  let model
  let tools
  const request = function request(input) {
    assertFacade(this, state, modelFacadeStates, 'model.request')
    return invokeBroker(state, 'model', input)
  }
  const execute = function execute(input) {
    assertFacade(this, state, toolFacadeStates, 'tools.execute')
    return invokeBroker(state, 'tool', input)
  }
  model = Object.freeze({ request })
  tools = Object.freeze({ execute })
  modelFacadeStates.set(model, state)
  toolFacadeStates.set(tools, state)
  const session = Object.freeze({
    apiVersion: LOOP_HARNESS_SESSION_API_VERSION,
    metadata: metadataSnapshot.value,
    binding: bindingSnapshot.value,
    model,
    tools,
  })
  sessionStates.set(session, state)
  return session
}

export function assertLoopHarnessSession(candidate) {
  if (!candidate || !sessionStates.has(candidate)) {
    throw invalid('loop harness session is not host-issued')
  }
  return candidate
}

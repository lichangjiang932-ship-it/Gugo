import { performance } from 'node:perf_hooks'
import { types as nodeTypes } from 'node:util'

export const POLICY_ADAPTER_CONTRACT_VERSION = 1
export const POLICY_DECISIONS = Object.freeze(['allow', 'ask', 'deny'])
export const DEFAULT_POLICY_CLASSIFY_TIMEOUT_MS = 5_000

const DECISION_SET = new Set(POLICY_DECISIONS)
const RISK_SET = new Set(['low', 'medium', 'high'])
const MAX_REASON_BYTES = 4 * 1024
const MAX_DATA_DEPTH = 32
const MAX_DATA_NODES = 8_192
const MAX_DATA_BYTES = 1024 * 1024
const POLICY_OPTION_FIELDS = new Set([
  'origin',
  'mode',
  'permissionMode',
  'taskGrants',
  'rememberedGrants',
  'metadata',
])
const POLICY_METADATA_FIELDS = new Set([
  'riskLevel',
  'category',
  'riskClass',
  'requiredApproval',
  'requiresApproval',
  'isReadOnly',
  'readOnly',
  'isConcurrencySafe',
  'executionMode',
  'maxParallel',
  'isIdempotent',
  'interruptBehavior',
  'isDestructive',
  'origin',
  'source',
  'reason',
])

function policyError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function ownDataValue(input, field, { required = false } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, field)
  } catch {
    throw policyError(
      'RUNTIME_POLICY_ADAPTER_INVALID',
      `policy adapter.${field} cannot be inspected safely`,
    )
  }
  if (!descriptor) {
    if (!required) return undefined
    throw policyError(
      'RUNTIME_POLICY_ADAPTER_INVALID',
      `policy adapter.${field} must be an own data property`,
    )
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw policyError(
      'RUNTIME_POLICY_ADAPTER_INVALID',
      `policy adapter.${field} must be an own data property`,
    )
  }
  return descriptor.value
}

function snapshotPlainData(input, label) {
  const state = { seen: new WeakSet(), nodes: 0, bytes: 0 }
  const clone = (value, depth) => {
    state.nodes += 1
    if (state.nodes > MAX_DATA_NODES || depth > MAX_DATA_DEPTH) {
      throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} exceeds the policy data boundary`)
    }
    if (value === undefined || value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} must contain finite numbers`)
      }
      return value
    }
    if (typeof value === 'string') {
      state.bytes += Buffer.byteLength(value, 'utf8')
      if (state.bytes > MAX_DATA_BYTES) {
        throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} is too large`)
      }
      return value
    }
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) {
      throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} must contain plain data`)
    }
    if (state.seen.has(value)) {
      throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} must not contain cycles`)
    }
    state.seen.add(value)
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const length = descriptors.length?.value
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DATA_NODES) {
          throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} arrays must be bounded`)
        }
        const output = []
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[index]
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} arrays must be dense data arrays`)
          }
          output.push(clone(descriptor.value, depth + 1))
        }
        return Object.freeze(output)
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} must contain plain objects`)
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const output = {}
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') {
          throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} must not contain symbols`)
        }
        const descriptor = descriptors[key]
        if (!Object.hasOwn(descriptor, 'value')) {
          throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} must not contain accessors`)
        }
        state.bytes += Buffer.byteLength(key, 'utf8')
        if (state.bytes > MAX_DATA_BYTES) {
          throw policyError('RUNTIME_POLICY_DATA_INVALID', `${label} is too large`)
        }
        Object.defineProperty(output, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        })
      }
      return Object.freeze(output)
    } finally {
      state.seen.delete(value)
    }
  }
  return clone(input, 0)
}

function failClosed(code) {
  return Object.freeze({
    decision: 'deny',
    risk: 'high',
    reason: 'The active policy could not produce a valid decision; execution was denied.',
    failure: Object.freeze({ code }),
  })
}

function normalizePolicyMetadata(value) {
  if (value === null || value === undefined) return value
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw policyError('RUNTIME_POLICY_DATA_INVALID', 'policy metadata must be a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw policyError('RUNTIME_POLICY_DATA_INVALID', 'policy metadata must be a plain object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const output = Object.create(null)
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) {
      throw policyError('RUNTIME_POLICY_DATA_INVALID', 'policy metadata must contain own data properties')
    }
    // Tool metadata also carries host-only helpers such as getPath. They are
    // capabilities, not policy evidence, and never cross the adapter boundary.
    if (!POLICY_METADATA_FIELDS.has(key)) continue
    Object.defineProperty(output, key, {
      value: snapshotPlainData(descriptor.value, `policy metadata.${key}`),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(output)
}

function normalizePolicyOptions(value) {
  if (value === undefined) return Object.freeze({})
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw policyError('RUNTIME_POLICY_REQUEST_INVALID', 'policy request.options must be a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw policyError('RUNTIME_POLICY_REQUEST_INVALID', 'policy request.options must be a plain object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const output = Object.create(null)
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || !POLICY_OPTION_FIELDS.has(key) || !Object.hasOwn(descriptor, 'value')) {
      throw policyError('RUNTIME_POLICY_REQUEST_INVALID', 'policy request.options has an unsupported property')
    }
    Object.defineProperty(output, key, {
      value: key === 'metadata'
        ? normalizePolicyMetadata(descriptor.value)
        : snapshotPlainData(descriptor.value, `policy request.options.${key}`),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(output)
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || nodeTypes.isProxy(request)) {
    throw policyError('RUNTIME_POLICY_REQUEST_INVALID', 'policy request must be a plain object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(request)
  const allowed = new Set(['toolName', 'args', 'options'])
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key) || !Object.hasOwn(descriptors[key], 'value')) {
      throw policyError('RUNTIME_POLICY_REQUEST_INVALID', 'policy request has an unsupported property')
    }
  }
  const toolName = descriptors.toolName?.value
  if (typeof toolName !== 'string' || !toolName.trim() || toolName.length > 128) {
    throw policyError('RUNTIME_POLICY_REQUEST_INVALID', 'policy request.toolName must be a bounded string')
  }
  const args = descriptors.args ? snapshotPlainData(descriptors.args.value, 'policy request.args') : Object.freeze({})
  const options = normalizePolicyOptions(descriptors.options?.value)
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || !options || typeof options !== 'object' || Array.isArray(options)) {
    throw policyError('RUNTIME_POLICY_REQUEST_INVALID', 'policy request args and options must be objects')
  }
  return Object.freeze({ toolName: toolName.trim(), args, options })
}

function isAsyncResult(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
  if (nodeTypes.isProxy(value) || nodeTypes.isPromise(value)) return true
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, 'then')
  } catch {
    return true
  }
  return Boolean(descriptor && (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function'))
}

function normalizeDecision(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || nodeTypes.isProxy(result)) {
    throw policyError('RUNTIME_POLICY_RESULT_INVALID', 'policy result must be a plain object')
  }
  const prototype = Object.getPrototypeOf(result)
  if (prototype !== Object.prototype && prototype !== null) {
    throw policyError('RUNTIME_POLICY_RESULT_INVALID', 'policy result must be a plain object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(result)
  const allowed = new Set(['decision', 'risk', 'reason', 'authorization'])
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key) || !Object.hasOwn(descriptors[key], 'value')) {
      throw policyError('RUNTIME_POLICY_RESULT_INVALID', 'policy result has an unsupported property')
    }
  }
  const decision = descriptors.decision?.value
  if (!DECISION_SET.has(decision)) {
    throw policyError('RUNTIME_POLICY_RESULT_INVALID', 'policy decision must be allow, ask, or deny')
  }
  const risk = descriptors.risk?.value ?? (decision === 'allow' ? 'low' : 'high')
  if (!RISK_SET.has(risk)) {
    throw policyError('RUNTIME_POLICY_RESULT_INVALID', 'policy risk must be low, medium, or high')
  }
  const reason = descriptors.reason?.value ?? null
  if (reason !== null && (typeof reason !== 'string' || Buffer.byteLength(reason, 'utf8') > MAX_REASON_BYTES)) {
    throw policyError('RUNTIME_POLICY_RESULT_INVALID', 'policy reason must be a bounded string or null')
  }
  const authorization = descriptors.authorization
    ? snapshotPlainData(descriptors.authorization.value, 'policy result.authorization')
    : undefined
  return Object.freeze({
    decision,
    risk,
    reason,
    ...(authorization === undefined ? {} : { authorization }),
  })
}

export function validatePolicyAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter) || nodeTypes.isProxy(adapter)) {
    throw policyError('RUNTIME_POLICY_ADAPTER_INVALID', 'policy adapter must be a plain object')
  }
  const contractVersion = ownDataValue(adapter, 'contractVersion', { required: true })
  const classify = ownDataValue(adapter, 'classify', { required: true })
  if (contractVersion !== POLICY_ADAPTER_CONTRACT_VERSION) {
    throw policyError(
      'RUNTIME_POLICY_CONTRACT_UNSUPPORTED',
      `policy adapter contractVersion must be ${POLICY_ADAPTER_CONTRACT_VERSION}`,
    )
  }
  if (typeof classify !== 'function') {
    throw policyError('RUNTIME_POLICY_ADAPTER_INVALID', 'policy adapter.classify must be a function')
  }
  return Object.freeze({
    contractVersion: POLICY_ADAPTER_CONTRACT_VERSION,
    classify(request) {
      return classify.call(adapter, request)
    },
  })
}

export function classifyWithPolicyAdapter(adapter, request, {
  timeoutMs = DEFAULT_POLICY_CLASSIFY_TIMEOUT_MS,
  now = () => performance.now(),
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000 || typeof now !== 'function') {
    return failClosed('RUNTIME_POLICY_OPTIONS_INVALID')
  }
  if (adapter === null || adapter === undefined) {
    return failClosed('RUNTIME_POLICY_BINDING_MISSING')
  }
  let normalizedAdapter
  let normalizedRequest
  try {
    normalizedAdapter = validatePolicyAdapter(adapter)
    normalizedRequest = normalizeRequest(request)
  } catch (error) {
    return failClosed(error?.code || 'RUNTIME_POLICY_BINDING_MISSING')
  }
  let startedAt
  try {
    startedAt = now()
    const result = normalizedAdapter.classify(normalizedRequest)
    if (isAsyncResult(result)) {
      if (nodeTypes.isPromise(result)) {
        try { Promise.prototype.then.call(result, undefined, () => {}) } catch { /* fail closed below */ }
      }
      return failClosed('RUNTIME_POLICY_ASYNC_UNSUPPORTED')
    }
    const elapsedMs = now() - startedAt
    if (!Number.isFinite(elapsedMs) || elapsedMs > timeoutMs) {
      return failClosed('RUNTIME_POLICY_TIMEOUT')
    }
    return normalizeDecision(result)
  } catch (error) {
    return failClosed(error?.code === 'RUNTIME_POLICY_RESULT_INVALID'
      ? error.code
      : 'RUNTIME_POLICY_EXECUTION_FAILED')
  }
}

export function createBuiltinApprovalPolicyAdapter(classifyToolRisk) {
  if (typeof classifyToolRisk !== 'function') {
    throw policyError('RUNTIME_POLICY_ADAPTER_INVALID', 'builtin classifyToolRisk must be a function')
  }
  return validatePolicyAdapter(Object.freeze({
    contractVersion: POLICY_ADAPTER_CONTRACT_VERSION,
    classify({ toolName, args, options }) {
      const verdict = classifyToolRisk(toolName, args, options)
      return Object.freeze({
        decision: verdict?.denied ? 'deny' : verdict?.needsApproval ? 'ask' : 'allow',
        risk: RISK_SET.has(verdict?.risk) ? verdict.risk : 'high',
        reason: typeof verdict?.reason === 'string' ? verdict.reason : null,
        ...(verdict?.authorization === undefined ? {} : { authorization: verdict.authorization }),
      })
    },
  }))
}

export function failClosedPolicyDecision(code = 'RUNTIME_POLICY_BINDING_MISSING') {
  return failClosed(code)
}

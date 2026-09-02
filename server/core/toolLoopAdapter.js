import { types as utilTypes } from 'node:util'
import {
  adapterError,
  assertAllowedOwnKeys,
  isPlainObject,
  optionalOwnDataValue,
  ownDataValue,
  ownDescriptor,
} from './toolLoopAdapterValidation.js'

export {
  createTruncatedToolCallResult,
  inspectToolLoopModelResponse,
  normalizeToolLoopModelResponse,
} from './toolLoopModelResponse.js'

export const TOOL_LOOP_ADAPTER_CONTRACT_VERSION = 2
export const TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3 = 3
export const TOOL_LOOP_ADAPTER_BROKER_VERSION = 1
export const TOOL_LOOP_ADAPTER_SUPPORTED_CONTRACT_VERSIONS = Object.freeze([
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
])
export const BUILTIN_TOOL_LOOP_ADAPTER_ID = 'builtin.agent-loop'

const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const AUDIT_LIMIT = 256
const EXTERNAL_ADAPTER_TEXT_LIMIT = 1_000_000
const preparedAdapters = new WeakSet()
const builtinPreparedAdapters = new WeakSet()
const runLeaseStates = new WeakMap()
const auditEvents = []
let auditSequence = 0
let activeBinding = null
let builtinLoopModulePromise = null

async function runBuiltinToolLoop(context) {
  builtinLoopModulePromise ||= import('../services/loop/runtime.js')
  try {
    const { runToolsLoopCore } = await builtinLoopModulePromise
    return await runToolsLoopCore(context)
  } catch (error) {
    builtinLoopModulePromise = null
    throw error
  }
}

function prepareHostCapabilities(candidate, contractVersion) {
  const declared = optionalOwnDataValue(candidate, 'hostCapabilities', 'tool loop adapter')
  if (declared === undefined) {
    if (contractVersion === TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3) {
      throw adapterError(
        'TOOL_LOOP_ADAPTER_INVALID',
        'tool loop adapter contractVersion 3 requires hostCapabilities.loopBroker',
      )
    }
    return null
  }
  if (!isPlainObject(declared)) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_INVALID',
      'tool loop adapter hostCapabilities must be a plain object',
    )
  }
  assertAllowedOwnKeys(declared, new Set(['loopBroker']), 'tool loop adapter hostCapabilities')
  const loopBroker = optionalOwnDataValue(
    declared,
    'loopBroker',
    'tool loop adapter hostCapabilities',
  )
  if (contractVersion === TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3
    && loopBroker !== TOOL_LOOP_ADAPTER_BROKER_VERSION) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_INVALID',
      `tool loop adapter hostCapabilities.loopBroker must equal ${TOOL_LOOP_ADAPTER_BROKER_VERSION}`,
    )
  }
  if (contractVersion === TOOL_LOOP_ADAPTER_CONTRACT_VERSION
    && loopBroker !== undefined
    && loopBroker !== TOOL_LOOP_ADAPTER_BROKER_VERSION) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_INVALID',
      `tool loop adapter hostCapabilities.loopBroker must equal ${TOOL_LOOP_ADAPTER_BROKER_VERSION}`,
    )
  }
  // A v2 declaration is inert compatibility data, never broker authority.
  return contractVersion === TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3
    ? Object.freeze({ loopBroker })
    : null
}

/**
 * Third-party adapters may propose assistant text, but host-owned terminal
 * state and artifact provenance never cross this trust boundary from below.
 */
export function sanitizeExternalToolLoopResult(result) {
  if (typeof result === 'string') {
    return Object.freeze({
      text: result.slice(0, EXTERNAL_ADAPTER_TEXT_LIMIT),
      artifactIds: Object.freeze([]),
      deliveryArtifactIds: Object.freeze([]),
      iterations: 0,
    })
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_RESULT_INVALID',
      'external tool loop adapter result must be an object or string',
    )
  }
  const text = ownDataValue(result, 'text', 'external tool loop adapter result')
  if (typeof text !== 'string') {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_RESULT_INVALID',
      'external tool loop adapter result text must be a string',
    )
  }
  return Object.freeze({
    text: text.slice(0, EXTERNAL_ADAPTER_TEXT_LIMIT),
    artifactIds: Object.freeze([]),
    deliveryArtifactIds: Object.freeze([]),
    iterations: 0,
  })
}

function emit(event, binding, details = {}) {
  const entry = Object.freeze({
    event,
    ...binding.identity,
    sequence: auditSequence += 1,
    at: Date.now(),
    ...details,
  })
  auditEvents.push(entry)
  if (auditEvents.length > AUDIT_LIMIT) {
    auditEvents.splice(0, auditEvents.length - AUDIT_LIMIT)
  }
}

export const BUILTIN_TOOL_LOOP_ADAPTER = Object.freeze({
  id: BUILTIN_TOOL_LOOP_ADAPTER_ID,
  contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
  run: runBuiltinToolLoop,
})

/** Validate and detach the complete Agent Loop implementation used by the host. */
export function prepareToolLoopAdapter(input = BUILTIN_TOOL_LOOP_ADAPTER) {
  const candidate = input === null || input === undefined
    ? BUILTIN_TOOL_LOOP_ADAPTER
    : input
  if (preparedAdapters.has(candidate)) return candidate
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || utilTypes.isProxy(candidate)) {
    throw adapterError('TOOL_LOOP_ADAPTER_INVALID', 'tool loop adapter must be an object')
  }
  const id = ownDataValue(candidate, 'id', 'tool loop adapter')
  if (typeof id !== 'string' || !ADAPTER_ID_RE.test(id)) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_INVALID',
      'tool loop adapter id must match [a-z0-9][a-z0-9._:-]{0,127}',
    )
  }
  const contractVersion = ownDataValue(candidate, 'contractVersion', 'tool loop adapter')
  if (!TOOL_LOOP_ADAPTER_SUPPORTED_CONTRACT_VERSIONS.includes(contractVersion)) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_VERSION_UNSUPPORTED',
      `tool loop adapter ${id} contractVersion ${contractVersion} is unsupported`,
    )
  }
  const hostCapabilities = prepareHostCapabilities(candidate, contractVersion)
  const run = ownDataValue(candidate, 'run', 'tool loop adapter')
  if (typeof run !== 'function' || utilTypes.isProxy(run)) {
    throw adapterError('TOOL_LOOP_ADAPTER_INVALID', 'tool loop adapter run must be a function')
  }
  const prepared = Object.freeze({
    id,
    contractVersion,
    ...(hostCapabilities ? { hostCapabilities } : {}),
    run,
  })
  preparedAdapters.add(prepared)
  if (candidate === BUILTIN_TOOL_LOOP_ADAPTER && run === runBuiltinToolLoop) {
    builtinPreparedAdapters.add(prepared)
  }
  return prepared
}

const BINDING_IDENTITY_FIELDS = Object.freeze([
  'adapterId',
  'owner',
  'version',
  'revision',
  'releaseDigest',
  'contractVersion',
  'brokerVersion',
  'source',
  'generation',
  'provenance',
])
const BINDING_IDENTITY_INPUT_FIELDS = new Set(BINDING_IDENTITY_FIELDS)
const BINDING_PROVENANCE_FIELDS = new Set([
  'capabilityId',
  'type',
  'slot',
  'binding',
  'source',
  'generation',
])

function normalizedOptionalIdentity(value, field) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw adapterError('TOOL_LOOP_BINDING_INVALID', `tool loop binding ${field} must be a string or null`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) {
    throw adapterError('TOOL_LOOP_BINDING_INVALID', `tool loop binding ${field} is invalid`)
  }
  return normalized
}

function identityValues(record, label, { strict = false } = {}) {
  if (record === null || record === undefined) return {}
  if (!isPlainObject(record)) {
    throw adapterError('TOOL_LOOP_BINDING_INVALID', `${label} must be a plain object`)
  }
  if (strict) {
    assertAllowedOwnKeys(record, BINDING_IDENTITY_INPUT_FIELDS, label)
  }
  const values = {}
  for (const field of BINDING_IDENTITY_FIELDS) {
    const value = optionalOwnDataValue(record, field, label)
    if (value !== undefined) values[field] = value
  }
  return values
}

function mergeIdentityValues(target, values) {
  for (const [field, value] of Object.entries(values)) {
    if (target[field] !== undefined && !Object.is(target[field], value)) {
      throw adapterError(
        'TOOL_LOOP_BINDING_INVALID',
        `tool loop binding ${field} is inconsistent`,
      )
    }
    target[field] = value
  }
}

function controllerInput(input, options) {
  if (options !== undefined && !isPlainObject(options)) {
    throw adapterError('TOOL_LOOP_BINDING_INVALID', 'tool loop controller options must be a plain object')
  }
  const optionRecord = options || {}
  let adapterInput = input
  const identity = {}
  if (isPlainObject(input) && ownDescriptor(input, 'adapter') && !ownDescriptor(input, 'run')) {
    adapterInput = ownDataValue(input, 'adapter', 'tool loop binding')
    const nested = optionalOwnDataValue(input, 'identity', 'tool loop binding')
    if (nested !== undefined) mergeIdentityValues(identity, identityValues(nested, 'tool loop binding identity', { strict: true }))
    mergeIdentityValues(identity, identityValues(input, 'tool loop binding'))
  }
  const optionIdentity = optionalOwnDataValue(optionRecord, 'identity', 'tool loop controller options')
  if (optionIdentity !== undefined) {
    mergeIdentityValues(identity, identityValues(optionIdentity, 'tool loop controller identity', { strict: true }))
  }
  mergeIdentityValues(identity, identityValues(optionRecord, 'tool loop controller options'))
  return { adapter: prepareToolLoopAdapter(adapterInput), identity }
}

function prepareBindingIdentity(adapter, values) {
  const adapterId = values.adapterId === undefined ? adapter.id : values.adapterId
  if (adapterId !== adapter.id) {
    throw adapterError('TOOL_LOOP_BINDING_INVALID', 'tool loop binding adapterId does not match adapter id')
  }
  const contractVersion = values.contractVersion === undefined
    ? adapter.contractVersion
    : values.contractVersion
  if (contractVersion !== adapter.contractVersion) {
    throw adapterError('TOOL_LOOP_BINDING_INVALID', 'tool loop binding contractVersion does not match adapter')
  }
  const expectedBrokerVersion = contractVersion === TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3
    ? TOOL_LOOP_ADAPTER_BROKER_VERSION
    : 0
  const brokerVersion = values.brokerVersion === undefined
    ? expectedBrokerVersion
    : values.brokerVersion
  if (brokerVersion !== expectedBrokerVersion) {
    throw adapterError(
      'TOOL_LOOP_BINDING_INVALID',
      `tool loop adapter contractVersion ${contractVersion} requires brokerVersion ${expectedBrokerVersion}`,
    )
  }
  const source = String(values.source || 'host.lifecycle').trim().slice(0, 80) || 'host.lifecycle'
  const revision = values.revision === undefined ? 1 : values.revision
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw adapterError(
      'TOOL_LOOP_BINDING_INVALID',
      'tool loop binding revision must be a positive integer',
    )
  }
  const generation = values.generation === undefined ? 1 : values.generation
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw adapterError(
      'TOOL_LOOP_BINDING_INVALID',
      'tool loop binding generation must be a positive integer',
    )
  }
  let provenance
  if (values.provenance === undefined) {
    provenance = Object.freeze({
      capabilityId: adapterId,
      type: 'loop',
      slot: 'loop',
      binding: 'loop:loop',
      source,
      generation,
    })
  } else {
    if (!isPlainObject(values.provenance)) {
      throw adapterError(
        'TOOL_LOOP_BINDING_INVALID',
        'tool loop binding provenance must be a plain object',
      )
    }
    assertAllowedOwnKeys(
      values.provenance,
      BINDING_PROVENANCE_FIELDS,
      'tool loop binding provenance',
    )
    const captured = {}
    for (const field of BINDING_PROVENANCE_FIELDS) {
      captured[field] = ownDataValue(
        values.provenance,
        field,
        'tool loop binding provenance',
      )
    }
    if (captured.capabilityId !== adapterId
      || captured.type !== 'loop'
      || captured.slot !== 'loop'
      || captured.binding !== 'loop:loop'
      || captured.source !== source
      || captured.generation !== generation) {
      throw adapterError(
        'TOOL_LOOP_BINDING_INVALID',
        'tool loop binding provenance does not match the binding identity',
      )
    }
    provenance = Object.freeze(captured)
  }
  return Object.freeze({
    adapterId,
    owner: normalizedOptionalIdentity(values.owner, 'owner'),
    version: normalizedOptionalIdentity(values.version, 'version'),
    revision,
    releaseDigest: normalizedOptionalIdentity(values.releaseDigest, 'releaseDigest'),
    contractVersion,
    brokerVersion,
    source,
    generation,
    provenance,
  })
}

/**
 * Capability check for the one host-owned implementation that may receive
 * private execution dependencies. Identity is tracked by module-private
 * provenance instead of the public adapter id, which is intentionally
 * user-selectable and therefore cannot be an authority boundary.
 */
export function isBuiltinToolLoopAdapter(adapter) {
  return builtinPreparedAdapters.has(adapter)
}

function activatePreparedAdapter(adapter, identity) {
  if (!preparedAdapters.has(adapter)) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_INVALID',
      'tool loop adapter must be prepared before activation',
    )
  }
  if (activeBinding) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_ALREADY_ACTIVE',
      `tool loop adapter ${activeBinding.adapter.id} is already active`,
    )
  }
  const binding = {
    adapter,
    identity,
    activeRuns: new Set(),
    implicit: false,
    revoked: false,
  }
  activeBinding = binding
  emit('tool_loop.configured', binding)
  return binding
}

/** Host lifecycle controller. Runtime code can acquire runs but cannot replace it. */
export function createToolLoopAdapterController(input, options = {}) {
  const resolved = controllerInput(input, options)
  const { adapter } = resolved
  const identity = prepareBindingIdentity(adapter, resolved.identity)
  let binding = null
  return Object.freeze({
    adapterId: adapter.id,
    binding: identity,
    bindingIdentity: identity,
    activate() {
      if (binding) {
        if (binding.revoked) {
          throw adapterError(
            'TOOL_LOOP_BINDING_REVOKED',
            `tool loop adapter ${adapter.id} is being revoked`,
          )
        }
        return adapter
      }
      binding = activatePreparedAdapter(adapter, identity)
      return adapter
    },
    beginRevoke() {
      if (!binding) return false
      if (activeBinding !== binding) {
        throw adapterError(
          'TOOL_LOOP_BINDING_STALE',
          `tool loop adapter binding ${adapter.id} is no longer authoritative`,
        )
      }
      if (binding.revoked) return false
      binding.revoked = true
      emit('tool_loop.revocation_started', binding, { activeRuns: binding.activeRuns.size })
      return true
    },
    release() {
      if (!binding) return false
      if (activeBinding !== binding) {
        throw adapterError(
          'TOOL_LOOP_BINDING_STALE',
          `tool loop adapter binding ${adapter.id} is no longer authoritative`,
        )
      }
      if (binding.activeRuns.size > 0) {
        throw adapterError(
          'TOOL_LOOP_ADAPTER_IN_USE',
          `tool loop adapter ${adapter.id} cannot be released while runs are active`,
        )
      }
      emit('tool_loop.released', binding)
      activeBinding = null
      binding = null
      return true
    },
  })
}

function assertRunLeaseActive(lease) {
  const state = runLeaseStates.get(lease)
  if (!state) {
    throw adapterError('TOOL_LOOP_RUN_LEASE_INVALID', 'tool loop run lease is not host-issued')
  }
  const { binding, token } = state
  if (binding.revoked) {
    throw adapterError(
      'TOOL_LOOP_RUN_LEASE_REVOKED',
      `tool loop adapter run lease ${binding.adapter.id} has been revoked`,
    )
  }
  if (state.released || activeBinding !== binding || !binding.activeRuns.has(token)) {
    throw adapterError(
      'TOOL_LOOP_RUN_LEASE_STALE',
      `tool loop adapter run lease ${binding.adapter.id} is no longer authoritative`,
    )
  }
  return binding.identity
}

function createLeaseAdapter(resolveLease, binding) {
  const adapter = Object.freeze({
    id: binding.adapter.id,
    contractVersion: binding.adapter.contractVersion,
    ...(binding.adapter.hostCapabilities ? { hostCapabilities: binding.adapter.hostCapabilities } : {}),
    run(...args) {
      assertRunLeaseActive(resolveLease())
      return Reflect.apply(binding.adapter.run, binding.adapter, args)
    },
  })
  preparedAdapters.add(adapter)
  if (isBuiltinToolLoopAdapter(binding.adapter)) builtinPreparedAdapters.add(adapter)
  return adapter
}

/** Acquire one immutable adapter snapshot for a complete Loop run. */
export function acquireToolLoopAdapterForRun() {
  if (!activeBinding) {
    const adapter = prepareToolLoopAdapter(BUILTIN_TOOL_LOOP_ADAPTER)
    activeBinding = activatePreparedAdapter(
      adapter,
      prepareBindingIdentity(adapter, { source: 'tool-loop.default' }),
    )
    activeBinding.implicit = true
  }
  const binding = activeBinding
  if (binding.revoked) {
    emit('tool_loop.run_rejected', binding, { reason: 'binding_revoked' })
    throw adapterError(
      'TOOL_LOOP_BINDING_REVOKED',
      `tool loop adapter ${binding.adapter.id} is being revoked`,
    )
  }
  const token = Object.freeze({})
  binding.activeRuns.add(token)
  emit('tool_loop.run_bound', binding, { activeRuns: binding.activeRuns.size })
  let lease
  const leaseAdapter = createLeaseAdapter(() => lease, binding)
  lease = Object.freeze({
    adapter: leaseAdapter,
    binding: binding.identity,
    bindingSnapshot: binding.identity,
    assertActive() {
      return assertRunLeaseActive(this)
    },
    release() {
      const state = runLeaseStates.get(this)
      if (!state) {
        throw adapterError('TOOL_LOOP_RUN_LEASE_INVALID', 'tool loop run lease is not host-issued')
      }
      if (state.released) return false
      const leaseBinding = state.binding
      const leaseToken = state.token
      if (activeBinding !== leaseBinding || !leaseBinding.activeRuns.has(leaseToken)) {
        throw adapterError(
          'TOOL_LOOP_RUN_LEASE_STALE',
          `tool loop adapter run lease ${leaseBinding.adapter.id} is no longer authoritative`,
        )
      }
      leaseBinding.activeRuns.delete(leaseToken)
      state.released = true
      emit('tool_loop.run_released', leaseBinding, {
        activeRuns: leaseBinding.activeRuns.size,
      })
      if (leaseBinding.implicit && leaseBinding.activeRuns.size === 0) {
        emit('tool_loop.released', leaseBinding)
        activeBinding = null
      }
      return true
    },
  })
  runLeaseStates.set(lease, {
    binding,
    released: false,
    token,
  })
  return lease
}

export function getToolLoopAdapterStatus() {
  if (!activeBinding) {
    return Object.freeze({
      configured: false,
      adapterId: null,
      contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
      activeRuns: 0,
      source: null,
      binding: null,
      revoking: false,
    })
  }
  return Object.freeze({
    configured: true,
    adapterId: activeBinding.adapter.id,
    contractVersion: activeBinding.adapter.contractVersion,
    activeRuns: activeBinding.activeRuns.size,
    source: activeBinding.identity.source,
    binding: activeBinding.identity,
    revoking: activeBinding.revoked,
  })
}

export function listToolLoopAdapterAuditEvents() {
  return Object.freeze([...auditEvents])
}

import { ENDPOINT_KINDS } from '../utils/endpointProfile.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from '../plugins/runtimePluginContributionLifecycle.js'
import { classifyToolRisk } from '../utils/approvalPolicy.js'
import { getBuiltinSpec, listBuiltinNames } from '../utils/toolSchemaCatalog.js'
import { createBuiltinApprovalPolicyAdapter } from './policyAdapter.js'
import { readRuntimeCapabilityBindings } from './runtimeCapabilityBindings.js'
import { createRuntimeCapabilityRegistry } from './runtimeCapabilityRegistry.js'
import {
  acquireRuntimePolicy,
  activateRuntimePolicy,
  getBoundRuntimeProvider,
  getBoundRuntimeTool,
  getActiveRuntimePolicyProvenance,
  getRuntimeCapabilitySnapshot,
  releaseRuntimePolicy,
  replaceRuntimeCapabilitySnapshot,
} from './runtimeCapabilityState.js'
import {
  BUILTIN_TOOL_LOOP_ADAPTER,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
} from './toolLoopAdapter.js'
import {
  prepareTurnPersistenceAdapter,
  TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
} from './turnPersistenceAdapter.js'

const BUILTIN_VERSION = '0.11.31'
const TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3 = 3
const LOOP_HOST_BROKER_API_VERSION = 1
const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const CAPABILITY_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i
const CAPABILITY_DIGEST_RE = /^sha256-(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/i
const MULTI_SLOT_CAPABILITY_TYPES = new Set(['tool', 'provider'])
const registry = createRuntimeCapabilityRegistry()
let currentConfigFingerprint = null
let currentBindings = Object.freeze({})
let currentBindingProvenance = Object.freeze({})
let registryMutationRevision = 0
let snapshotPreparationRevision = 0
let builtinPersistenceAdapter = null
let disposeBuiltinPersistenceRegistration = null
const builtinPersistenceOwners = new Set()

const BUILTIN_HARNESS_POLICY = Object.freeze({
  id: 'builtin.harness-policy',
  adapter: createBuiltinApprovalPolicyAdapter(classifyToolRisk),
})

function builtinContribution(type, id, implementation, { slot = type } = {}) {
  return Object.freeze({
    id,
    type,
    slot,
    owner: 'builtin',
    version: BUILTIN_VERSION,
    priority: 0,
    implementation,
    healthCheck: () => true,
  })
}

registry.registerAll([
  builtinContribution('loop', BUILTIN_TOOL_LOOP_ADAPTER.id, BUILTIN_TOOL_LOOP_ADAPTER),
  builtinContribution('policy', BUILTIN_HARNESS_POLICY.id, BUILTIN_HARNESS_POLICY.adapter),
  ...listBuiltinNames().map((name) => builtinContribution(
    'tool',
    `builtin.tool.${name.toLowerCase()}`,
    Object.freeze({ name, spec: getBuiltinSpec(name) }),
    { slot: name },
  )),
  ...ENDPOINT_KINDS.map((kind) => builtinContribution(
    'provider',
    `builtin.provider.${kind}`,
    Object.freeze({ kind, builtin: true }),
    { slot: kind },
  )),
])

// Direct service consumers (including recovery and focused tests) may execute
// before the async lifecycle preparation step. Activate only the builtin
// policy here; publishing the full tool/provider snapshot early would change
// the legacy dynamic-tool selection boundary before startup preparation.
activateRuntimePolicy(registry.snapshot())

function publishRuntimeCapabilitySnapshot() {
  const snapshot = registry.snapshot(currentBindings, { provenance: currentBindingProvenance })
  if (getRuntimeCapabilitySnapshot()) replaceRuntimeCapabilitySnapshot(snapshot)
  else activateRuntimePolicy(snapshot)
  return snapshot
}

function explicitBindingId(entry) {
  const configured = currentBindings?.[entry.type]
  if (MULTI_SLOT_CAPABILITY_TYPES.has(entry.type)) {
    return configured && typeof configured === 'object' ? configured[entry.slot] : null
  }
  return configured || null
}

function assertRuntimeCapabilityRemovalResolvable(entry) {
  if (explicitBindingId(entry) !== entry.id) return
  const binding = `${entry.type}:${entry.slot}`
  const error = new Error(
    `runtime capability ${entry.id} cannot unload while explicitly selected by ${binding}`,
  )
  error.code = 'RUNTIME_CAPABILITY_BINDING_IN_USE'
  error.retryable = true
  error.capabilityId = entry.id
  error.binding = binding
  error.source = currentBindingProvenance[binding] || 'runtime_config'
  throw error
}

function registeredContributionSince(knownSequences) {
  let registered = null
  for (const entry of registry.list()) {
    if (knownSequences.has(entry.sequence)) continue
    if (!registered || entry.sequence > registered.sequence) registered = entry
  }
  return registered
}

function markRuntimeCapabilityMutation() {
  registryMutationRevision += 1
}

function staleRuntimeCapabilitySnapshotError(expectedRevision, expectedPreparationRevision) {
  const error = new Error('runtime capability registry changed while preparing a snapshot')
  error.code = 'RUNTIME_CAPABILITY_SNAPSHOT_STALE'
  error.retryable = true
  error.expectedRevision = expectedRevision
  error.actualRevision = registryMutationRevision
  error.expectedPreparationRevision = expectedPreparationRevision
  error.actualPreparationRevision = snapshotPreparationRevision
  return error
}

/**
 * Composition-root hook for the host-selected persistence backend.
 * The kernel intentionally ships no concrete storage implementation and never
 * installs one as a side effect of importing this module. Runtime plugins do
 * not receive this hook: persistence is selected by trusted process bootstrap
 * before ordinary plugin discovery or restoration.
 */
export function acquireHostTurnPersistenceCapability(input) {
  const adapter = prepareTurnPersistenceAdapter(input)
  if (builtinPersistenceAdapter !== null) {
    if (adapter !== builtinPersistenceAdapter) {
      const error = new Error('a different host persistence backend is already registered')
      error.code = 'RUNTIME_BUILTIN_PERSISTENCE_ALREADY_REGISTERED'
      error.retryable = false
      throw error
    }
  } else {
    const disposeRegistration = registry.register(
      builtinContribution('persistence', adapter.id, adapter),
    )
    markRuntimeCapabilityMutation()
    builtinPersistenceAdapter = adapter
    disposeBuiltinPersistenceRegistration = disposeRegistration
  }

  const owner = Object.freeze({})
  let released = false
  builtinPersistenceOwners.add(owner)
  return Object.freeze({
    adapter: builtinPersistenceAdapter,
    release() {
      if (released) return false
      if (!builtinPersistenceOwners.has(owner)) {
        const error = new Error('host persistence ownership lease is no longer authoritative')
        error.code = 'RUNTIME_BUILTIN_PERSISTENCE_LEASE_STALE'
        error.retryable = false
        throw error
      }
      if (builtinPersistenceOwners.size === 1) {
        if (typeof disposeBuiltinPersistenceRegistration !== 'function') {
          const error = new Error('host persistence registration has no release handle')
          error.code = 'RUNTIME_BUILTIN_PERSISTENCE_RELEASE_UNAVAILABLE'
          error.retryable = false
          throw error
        }
        const removed = disposeBuiltinPersistenceRegistration()
        if (!removed) {
          const error = new Error('host persistence registration could not be released')
          error.code = 'RUNTIME_BUILTIN_PERSISTENCE_RELEASE_FAILED'
          error.retryable = false
          throw error
        }
        markRuntimeCapabilityMutation()
        builtinPersistenceAdapter = null
        disposeBuiltinPersistenceRegistration = null
      }
      builtinPersistenceOwners.delete(owner)
      released = true
      return true
    },
  })
}

/** @deprecated Use acquireHostTurnPersistenceCapability at composition roots. */
export function registerHostTurnPersistenceCapability(input) {
  return acquireHostTurnPersistenceCapability(input)
}

/** @deprecated Use acquireHostTurnPersistenceCapability at composition roots. */
export function registerBuiltinTurnPersistenceCapability(input) {
  return acquireHostTurnPersistenceCapability(input)
}

export function registerRuntimeCapabilityContribution(definition) {
  const knownSequences = new Set(registry.list().map((entry) => entry.sequence))
  const disposeRegistration = registry.register(definition)
  markRuntimeCapabilityMutation()
  const registeredEntry = registeredContributionSince(knownSequences)
  if (!registeredEntry) {
    if (disposeRegistration()) markRuntimeCapabilityMutation()
    const error = new Error('runtime capability host could not identify the registered contribution')
    error.code = 'RUNTIME_CAPABILITY_REGISTRATION_UNTRACKED'
    error.retryable = false
    throw error
  }
  try {
    publishRuntimeCapabilitySnapshot()
  } catch (error) {
    if (disposeRegistration()) markRuntimeCapabilityMutation()
    throw error
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return false
    assertRuntimeCapabilityRemovalResolvable(registeredEntry)
    const removed = disposeRegistration()
    if (!removed) return false
    markRuntimeCapabilityMutation()
    disposed = true
    publishRuntimeCapabilitySnapshot()
    return true
  }
  return attachRuntimePluginBeginRevoke(dispose, () => {
    try {
      dispose()
      return createRuntimePluginRevokeReceipt('revoked')
    } catch (error) {
      if (error?.code === 'RUNTIME_CAPABILITY_IN_USE'
        || error?.code === 'RUNTIME_CAPABILITY_BINDING_IN_USE') {
        return createRuntimePluginRevokeReceipt('retained')
      }
      throw error
    }
  })
}

export async function prepareRuntimeCapabilitySnapshot(options = {}) {
  const config = readRuntimeCapabilityBindings(options)
  const preparationRevision = ++snapshotPreparationRevision
  const expectedRevision = registryMutationRevision
  const snapshot = await registry.resolve(config.bindings, { provenance: config.provenance })
  if (registryMutationRevision !== expectedRevision
    || snapshotPreparationRevision !== preparationRevision) {
    throw staleRuntimeCapabilitySnapshotError(expectedRevision, preparationRevision)
  }
  currentBindings = config.bindings
  currentBindingProvenance = config.provenance
  replaceRuntimeCapabilitySnapshot(snapshot)
  currentConfigFingerprint = config.fingerprint
  return snapshot
}

export {
  acquireRuntimePolicy,
  activateRuntimePolicy,
  getActiveRuntimePolicyProvenance,
  getBoundRuntimeProvider,
  getBoundRuntimeTool,
  getRuntimeCapabilitySnapshot,
  releaseRuntimePolicy,
}

export function listRuntimeCapabilityContributions() {
  return registry.list()
}

export function listEffectiveRuntimeCapabilityBindings() {
  return getRuntimeCapabilitySnapshot()?.effectiveBindings || Object.freeze([])
}

export function listRuntimeCapabilityAuditEvents() {
  return registry.listAuditEvents()
}

export function getRuntimeCapabilityConfigFingerprint() {
  return currentConfigFingerprint
}

export function createBoundTurnPersistenceAdapter(snapshot) {
  if (!snapshot || typeof snapshot.get !== 'function') {
    throw new TypeError('runtime capability snapshot is required')
  }
  const persistence = snapshot.get('persistence')
  if (!persistence
    || persistence.contractVersion !== TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION) {
    const error = new Error('runtime capability binding requires one complete persistence backend')
    error.code = 'RUNTIME_PERSISTENCE_BINDING_INCOMPLETE'
    error.retryable = false
    throw error
  }
  return prepareTurnPersistenceAdapter(persistence)
}

function loopBindingError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function loopBindingOwnData(target, field, label) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, field)
  } catch {
    descriptor = null
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      `${label} must declare own data property ${String(field)}`,
    )
  }
  return descriptor.value
}

function assertLoopIdentityString(value, field, pattern = null) {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || (pattern && !pattern.test(value))) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      `selected loop capability ${field} is invalid`,
    )
  }
  return value
}

function selectedLoopCapabilityEntry(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw loopBindingError('RUNTIME_LOOP_BINDING_INVALID', 'runtime capability snapshot is required')
  }
  const effectiveBindings = loopBindingOwnData(
    snapshot,
    'effectiveBindings',
    'runtime capability snapshot',
  )
  if (!Array.isArray(effectiveBindings)) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'runtime capability snapshot effectiveBindings must be an array',
    )
  }
  const length = loopBindingOwnData(
    effectiveBindings,
    'length',
    'runtime capability snapshot effectiveBindings',
  )
  let selected = null
  for (let index = 0; index < length; index += 1) {
    const entry = loopBindingOwnData(
      effectiveBindings,
      String(index),
      'runtime capability snapshot effectiveBindings',
    )
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw loopBindingError(
        'RUNTIME_LOOP_BINDING_INVALID',
        'runtime capability snapshot binding entry must be an object',
      )
    }
    const type = loopBindingOwnData(entry, 'type', 'runtime capability snapshot binding entry')
    const slot = loopBindingOwnData(entry, 'slot', 'runtime capability snapshot binding entry')
    if (type !== 'loop' || slot !== 'loop') continue
    if (selected) {
      throw loopBindingError(
        'RUNTIME_LOOP_BINDING_INVALID',
        'runtime capability snapshot has multiple selected loop bindings',
      )
    }
    selected = entry
  }
  if (!selected) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'runtime capability snapshot has no selected loop binding',
    )
  }
  return selected
}

function loopBrokerVersion(adapter, contractVersion) {
  if (contractVersion === TOOL_LOOP_ADAPTER_CONTRACT_VERSION) return 0
  if (contractVersion !== TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_VERSION_UNSUPPORTED',
      `selected loop capability contractVersion ${String(contractVersion)} is unsupported`,
    )
  }
  const hostCapabilities = loopBindingOwnData(adapter, 'hostCapabilities', 'selected loop adapter')
  if (!hostCapabilities || typeof hostCapabilities !== 'object' || Array.isArray(hostCapabilities)) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'selected loop adapter hostCapabilities must be an object',
    )
  }
  const brokerVersion = loopBindingOwnData(
    hostCapabilities,
    'loopBroker',
    'selected loop adapter hostCapabilities',
  )
  if (brokerVersion !== LOOP_HOST_BROKER_API_VERSION) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_VERSION_UNSUPPORTED',
      `selected loop capability requires loop broker version ${LOOP_HOST_BROKER_API_VERSION}`,
    )
  }
  return brokerVersion
}

/** Capture the complete selected Loop identity alongside its executable adapter. */
export function selectedToolLoopBinding(snapshot) {
  const entry = selectedLoopCapabilityEntry(snapshot)
  const get = loopBindingOwnData(snapshot, 'get', 'runtime capability snapshot')
  if (typeof get !== 'function') {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'runtime capability snapshot get must be a function',
    )
  }
  let adapter
  try {
    adapter = Reflect.apply(get, snapshot, ['loop'])
  } catch {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'runtime capability snapshot could not resolve the selected loop adapter',
    )
  }
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'selected loop capability must provide an adapter object',
    )
  }

  const adapterId = assertLoopIdentityString(
    loopBindingOwnData(adapter, 'id', 'selected loop adapter'),
    'adapterId',
    CAPABILITY_ID_RE,
  )
  const contractVersion = loopBindingOwnData(
    adapter,
    'contractVersion',
    'selected loop adapter',
  )
  if (!Number.isSafeInteger(contractVersion)) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'selected loop capability contractVersion must be an integer',
    )
  }
  const run = loopBindingOwnData(adapter, 'run', 'selected loop adapter')
  if (typeof run !== 'function') {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'selected loop adapter run must be a function',
    )
  }
  const brokerVersion = loopBrokerVersion(adapter, contractVersion)

  const capabilityId = assertLoopIdentityString(
    loopBindingOwnData(entry, 'id', 'selected loop capability entry'),
    'id',
    CAPABILITY_ID_RE,
  )
  if (capabilityId !== adapterId) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_IDENTITY_MISMATCH',
      'selected loop capability identity does not match its adapter',
    )
  }
  const owner = assertLoopIdentityString(
    loopBindingOwnData(entry, 'owner', 'selected loop capability entry'),
    'owner',
    CAPABILITY_ID_RE,
  )
  const version = assertLoopIdentityString(
    loopBindingOwnData(entry, 'version', 'selected loop capability entry'),
    'version',
    CAPABILITY_VERSION_RE,
  )
  const revision = loopBindingOwnData(entry, 'revision', 'selected loop capability entry')
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'selected loop capability revision must be a positive integer',
    )
  }
  const releaseDigest = loopBindingOwnData(
    entry,
    'releaseDigest',
    'selected loop capability entry',
  )
  if (releaseDigest !== null
    && (typeof releaseDigest !== 'string' || !CAPABILITY_DIGEST_RE.test(releaseDigest))) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'selected loop capability releaseDigest is invalid',
    )
  }
  const binding = loopBindingOwnData(entry, 'binding', 'selected loop capability entry')
  if (binding !== 'loop:loop') {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'selected loop capability binding must be loop:loop',
    )
  }
  const source = assertLoopIdentityString(
    loopBindingOwnData(entry, 'source', 'selected loop capability entry'),
    'source',
  )
  const generation = loopBindingOwnData(entry, 'generation', 'selected loop capability entry')
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw loopBindingError(
      'RUNTIME_LOOP_BINDING_INVALID',
      'selected loop capability generation must be a positive integer',
    )
  }
  const provenance = Object.freeze({
    capabilityId,
    type: 'loop',
    slot: 'loop',
    binding,
    source,
    generation,
  })
  const identity = Object.freeze({
    adapterId,
    owner,
    version,
    revision,
    releaseDigest,
    contractVersion,
    brokerVersion,
    source,
    generation,
    provenance,
  })
  return Object.freeze({ adapter, identity })
}

export function selectedToolLoopAdapter(snapshot) {
  return selectedToolLoopBinding(snapshot).adapter
}

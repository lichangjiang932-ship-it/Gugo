import {
  classifyWithPolicyAdapter,
  failClosedPolicyDecision,
  validatePolicyAdapter,
} from './policyAdapter.js'

let currentSnapshot = null
let activePolicyBinding = null

function capabilityProvenance(snapshot, type, slot) {
  const entry = snapshot?.effectiveBindings?.find((binding) => (
    binding?.type === type && binding?.slot === slot
  ))
  if (!entry) return null
  return Object.freeze({
    id: entry.id,
    owner: entry.owner,
    version: entry.version,
    revision: entry.revision,
    releaseDigest: entry.releaseDigest || null,
    generation: entry.generation,
    source: entry.source,
  })
}

function policyProvenance(snapshot) {
  return capabilityProvenance(snapshot, 'policy', 'policy')
}

function createPolicyBinding(snapshot) {
  const adapter = snapshot?.get?.('policy') || null
  const provenance = policyProvenance(snapshot)
  if (!adapter || !provenance) return null
  return {
    adapter: validatePolicyAdapter(adapter),
    provenance,
    active: true,
  }
}

export function activateRuntimePolicy(snapshot = currentSnapshot) {
  const next = createPolicyBinding(snapshot)
  const previous = activePolicyBinding
  activePolicyBinding = next
  if (previous) previous.active = false
  return next?.provenance || null
}

export function releaseRuntimePolicy() {
  const previous = activePolicyBinding
  if (!previous) return false
  previous.active = false
  activePolicyBinding = null
  return true
}

export function replaceRuntimeCapabilitySnapshot(snapshot) {
  const nextPolicy = createPolicyBinding(snapshot)
  const previousPolicy = activePolicyBinding
  currentSnapshot = snapshot
  activePolicyBinding = nextPolicy
  if (previousPolicy) previousPolicy.active = false
  return currentSnapshot
}

export function getRuntimeCapabilitySnapshot() {
  return currentSnapshot
}

export function getBoundRuntimeTool(name) {
  return currentSnapshot?.get('tool', name) || null
}

export function getBoundRuntimeProvider(kind) {
  return currentSnapshot?.get('provider', kind) || null
}

export function getBoundRuntimeProviderProvenance(kind) {
  const slot = typeof kind === 'string' ? kind.trim().toLowerCase() : ''
  return slot ? capabilityProvenance(currentSnapshot, 'provider', slot) : null
}

export function getActiveRuntimePolicyProvenance() {
  return activePolicyBinding?.provenance || null
}

export function acquireRuntimePolicy() {
  const binding = activePolicyBinding
  let released = false
  return Object.freeze({
    provenance: binding?.provenance || null,
    classify(request, options) {
      if (released) return failClosedPolicyDecision('RUNTIME_POLICY_LEASE_RELEASED')
      if (!binding) return failClosedPolicyDecision('RUNTIME_POLICY_BINDING_MISSING')
      if (!binding.active || binding !== activePolicyBinding) {
        return failClosedPolicyDecision('RUNTIME_POLICY_BINDING_STALE')
      }
      return classifyWithPolicyAdapter(binding.adapter, request, options)
    },
    release() {
      if (released) return false
      released = true
      return true
    },
  })
}

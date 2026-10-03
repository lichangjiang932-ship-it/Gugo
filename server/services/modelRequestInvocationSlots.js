import { restoreModelInvocationCheckpoint } from './loop/modelInvocationCheckpoint.js'

function ambiguousRecovery() {
  return Object.assign(new Error('The checkpoint contains multiple unresolved model requests; recovery cannot choose a slot safely.'), {
    code: 'MODEL_REQUEST_RECOVERY_AMBIGUOUS',
    statusCode: 409,
    retryable: false,
    unsafeToReplay: true,
  })
}

export function readModelInvocationSlots(state, binding = {}) {
  const slots = [
    { slot: 'main', value: state?.modelInvocation },
    { slot: 'compaction', value: state?.compactionCheckpoint?.modelInvocation },
  ].filter(({ value }) => value !== undefined && value !== null)
  if (slots.filter(({ value }) => value?.status === 'in_flight').length > 1) throw ambiguousRecovery()
  return slots.map(({ slot, value }) => ({ slot, invocation: restoreModelInvocationCheckpoint(value, binding) }))
}

export function isManuallyResolvedModelInvocation(invocation) {
  return ['completed', 'not_sent'].includes(invocation?.status)
    && invocation.reconciliation?.source === 'manual'
    && invocation.reconciliation.outcome === invocation.status
}

export function selectModelRequestRecoverySlot(state, { includeMaterialized = false } = {}) {
  const slots = readModelInvocationSlots(state)
  const pending = slots.find(({ invocation }) => invocation.status === 'in_flight')
  if (pending) return pending
  if (!includeMaterialized) return null
  // A compaction response stays in this dedicated slot only until the loop
  // consumes it. An older completed main response may remain beside it.
  return slots.reverse().find(({ invocation }) => isManuallyResolvedModelInvocation(invocation)) || null
}

export function modelInvocationAtSlot(state, slot) {
  return readModelInvocationSlots(state).find((entry) => entry.slot === slot)?.invocation || null
}

export function withModelInvocationAtSlot(state, slot, invocation) {
  if (slot === 'main') return { ...state, modelInvocation: invocation }
  if (slot === 'compaction' && state?.compactionCheckpoint
    && typeof state.compactionCheckpoint === 'object' && !Array.isArray(state.compactionCheckpoint)) {
    return { ...state, compactionCheckpoint: { ...state.compactionCheckpoint, modelInvocation: invocation } }
  }
  throw Object.assign(new Error('The model request checkpoint slot is missing or invalid'), {
    code: 'MODEL_REQUEST_CONTEXT_DRIFT', statusCode: 409, retryable: false, unsafeToReplay: true,
  })
}

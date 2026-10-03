import { modelContextDiagnosticsSchema } from '../../../shared/modelContextDiagnostics.js'
import { createHash } from 'node:crypto'
import { modelWireDiagnosticsSchema } from '../../../shared/modelWireDiagnostics.js'
import { logWarn } from '../../utils/logger.js'
import { describeRuntimePrompt } from '../promptPrefixFingerprint.js'

const durableObservers = new WeakSet()
const previousWireByState = new WeakMap()

/** Host event stores are not optional observers: their failures must still stop execution. */
export function requireContextDiagnosticDurability(observer) {
  durableObservers.add(observer)
  return observer
}

function warnUnavailable(warn, stage) {
  // Diagnostic failures may contain prompt data; never log the original error.
  try {
    warn('loop.context_diagnostics', new Error('Optional context diagnostics unavailable'), { stage })
  } catch { /* a logging observer cannot own model execution */ }
}

export async function emitContextPreparation(state, tools, {
  describe = describeRuntimePrompt,
  warn = logWarn,
} = {}) {
  let observation
  try {
    observation = describe({ messages: state.convo, tools, previous: state.runtimePromptFingerprint })
    const parsed = modelContextDiagnosticsSchema.safeParse(observation?.diagnostics)
    if (!parsed.success) throw new Error('Invalid diagnostic shape')
    observation = { ...observation, diagnostics: parsed.data }
  } catch {
    state.runtimePromptFingerprint = null
    warnUnavailable(warn, 'prepare')
    return
  }
  state.runtimePromptFingerprint = observation.snapshot
  const observer = state.onModelPhase
  if (typeof observer !== 'function') return
  try {
    await observer({ phase: 'context_prepared', iteration: state.iter, contextDiagnostics: observation.diagnostics })
  } catch (error) {
    if (durableObservers.has(observer) || error?.name === 'AbortError') throw error
    warnUnavailable(warn, 'observe')
  }
}

export function optionalContextDiagnostics(value) {
  const parsed = modelContextDiagnosticsSchema.safeParse(value)
  if (parsed.success) return parsed.data
  warnUnavailable(logWarn, 'event_schema')
  return null
}

export function optionalWireDiagnostics(value) {
  const parsed = modelWireDiagnosticsSchema.safeParse(value)
  if (parsed.success) return parsed.data
  warnUnavailable(logWarn, 'wire_schema')
  return null
}

/** Called only after the durable physical-attempt fence has succeeded, before fetch. */
export async function emitWirePreparation(state, { wireDiagnostics, modelRequestId, physicalAttempt, configRevision } = {}, { warn = logWarn } = {}) {
  let current = optionalWireDiagnostics(wireDiagnostics)
  if (!current) return
  if (Number.isSafeInteger(configRevision) && configRevision > 0 && current.configFingerprint) {
    current = { ...current, configFingerprint: createHash('sha256').update(JSON.stringify({
      wireConfig: current.configFingerprint, bindingRevision: configRevision,
    })).digest('hex') }
  }
  const previous = previousWireByState.get(state)
  const comparable = Boolean(current.available && previous?.available && current.identityComparable && previous.identityComparable
    && ['ownerScopeFingerprint', 'endpointFingerprint', 'modelFingerprint', 'configFingerprint']
      .every((key) => current[key] && current[key] === previous[key]))
  const prefixComparable = comparable && current.prefixFingerprint !== null && previous.prefixFingerprint !== null
  const observation = { ...current, prefixComparable,
    prefixChanged: prefixComparable ? current.prefixFingerprint !== previous.prefixFingerprint : null,
    toolsChanged: comparable ? current.toolsFingerprint !== previous.toolsFingerprint : null,
    bodyChanged: comparable ? current.bodyFingerprint !== previous.bodyFingerprint : null }
  previousWireByState.set(state, current)
  if (typeof state.onModelPhase !== 'function') return
  try {
    await state.onModelPhase({ phase: 'wire_prepared', iteration: state.iter, modelRequestId, physicalAttempt, wireDiagnostics: observation })
  } catch (error) {
    if (durableObservers.has(state.onModelPhase) || error?.name === 'AbortError') {
      try { error.retryable = false; error.modelRequestOutcome = 'not_sent'; error.unsafeToReplay = true } catch { /* immutable error */ }
      throw error
    }
    warnUnavailable(warn, 'wire_observe')
  }
}

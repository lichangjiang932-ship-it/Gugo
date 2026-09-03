import { createEffectTracker } from './pluginLifecycle.js'

const MAX_CONFIG_RELOAD_AUDIT_EVENTS = 256

export function normalizeRuntimePluginId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function createRuntimePluginRecordFactory() {
  let installSequence = 0
  return ({
    manifest,
    setup,
    configResolver,
    configResolution,
    configRevision,
    state,
    deferVisibility,
    durableIdentity = null,
    durableOwnerUserId = null,
    resetDurableAgentEventSubscriptions = false,
    installedAt = null,
  }) => ({
    manifest,
    setup,
    configResolver,
    configResolution,
    configRevision,
    state,
    deferVisibility,
    durableIdentity,
    durableOwnerUserId,
    resetDurableAgentEventSubscriptions,
    cancelRequested: false,
    installedAt,
    sequence: ++installSequence,
    effects: createEffectTracker(),
    managedContributions: [],
    deactivationChecks: new Set(),
    configHealthChecks: new Set(),
    eventContributions: new Set(),
    agentEventContributions: new Set(),
    httpCapabilities: new Set(),
    visibleEffects: new Set(),
    revocationErrors: [],
    revocationPromise: null,
    activeCallbacks: 0,
    callbackDrainWaiters: new Set(),
  })
}

export function createRuntimePluginAuditRuntime(audit) {
  const configReloadAudit = []

  const emitAudit = (event, details = {}) => {
    if (typeof audit !== 'function') return
    try {
      audit(Object.freeze({ event, ...details }))
    } catch {
      // Observability must never change lifecycle correctness.
    }
  }

  const emitConfigReloadAudit = (event, details = {}) => {
    const entry = Object.freeze({ event, at: new Date().toISOString(), ...details })
    configReloadAudit.push(entry)
    if (configReloadAudit.length > MAX_CONFIG_RELOAD_AUDIT_EVENTS) configReloadAudit.shift()
    emitAudit(event, details)
  }

  return Object.freeze({
    emitAudit,
    emitConfigReloadAudit,
    listConfigReloadAudit: () => Object.freeze([...configReloadAudit]),
  })
}

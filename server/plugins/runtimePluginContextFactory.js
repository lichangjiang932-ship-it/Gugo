import { createPluginContext } from './pluginContext.js'
import { snapshotPluginAuditEntry } from './pluginContextData.js'

export function createRuntimePluginContextForRecord(record, ports) {
  const {
    registerConfigHealthCheck,
    registerToolContribution,
    registerEventContribution,
    registerAgentEventContribution,
    registerModelProviderContribution,
    registerLoopContribution,
    registerPolicyContribution,
    registerHttpCapabilityContribution,
    registerPromptContribution,
    provideService,
    invokeServiceForConsumer,
    hasServiceForConsumer,
    emitAudit,
  } = ports

  return createPluginContext({
    manifest: record.manifest,
    config: record.configResolution.config,
    track: record.effects.track,
    registerConfigHealthCheck: (check) => registerConfigHealthCheck(record, check),
    registerTool: (definition) => registerToolContribution(record, definition),
    registerEvent: (event, listener) => registerEventContribution(record, event, listener),
    registerAgentEvent: (eventType, listener, options) => (
      registerAgentEventContribution(record, eventType, listener, options)
    ),
    registerModelProvider: (kind, adapter, options) => (
      registerModelProviderContribution(record, kind, adapter, options)
    ),
    registerLoop: (adapter, options) => registerLoopContribution(record, adapter, options),
    registerPolicy: (adapter, options) => registerPolicyContribution(record, adapter, options),
    registerHttpCapability: (definition) => registerHttpCapabilityContribution(record, definition),
    registerPrompt: (definition) => registerPromptContribution(record, definition),
    provideService: (name, value) => provideService(record, name, value),
    invokeService: (name, method, args) => invokeServiceForConsumer(record, name, method, args),
    hasService: (name) => hasServiceForConsumer(record, name),
    emitAudit: (event, details) => {
      const entry = snapshotPluginAuditEntry(event, details)
      emitAudit(entry.event, {
        pluginId: record.manifest.id,
        details: entry.details,
      })
    },
  })
}

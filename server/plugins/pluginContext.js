export function createPluginContext({
  manifest,
  config,
  track,
  registerConfigHealthCheck,
  registerTool,
  registerEvent,
  registerAgentEvent,
  registerModelProvider,
  registerLoop,
  registerPolicy,
  registerHttpCapability,
  registerPrompt,
  provideService,
  invokeService,
  hasService,
  emitAudit,
}) {
  const context = {
    plugin: manifest,
    config,
    lifecycle: Object.freeze({
      onDispose(effect) {
        return track(effect)
      },
      onConfigHealthCheck(check) {
        return registerConfigHealthCheck(check)
      },
    }),
    tools: Object.freeze({
      register(definition) {
        return registerTool(definition)
      },
    }),
    events: Object.freeze({
      on(event, listener) {
        return registerEvent(event, listener)
      },
    }),
    agentEvents: Object.freeze({
      subscribe(eventType, listener, options) {
        return registerAgentEvent(eventType, listener, options)
      },
    }),
    models: Object.freeze({
      providers: Object.freeze({
        register(kind, adapter, options) {
          return registerModelProvider(kind, adapter, options)
        },
      }),
    }),
    loops: Object.freeze({
      register(adapter, options) {
        return registerLoop(adapter, options)
      },
    }),
    policies: Object.freeze({
      register(adapter, options) {
        return registerPolicy(adapter, options)
      },
    }),
    http: Object.freeze({
      register(definition) {
        return registerHttpCapability(definition)
      },
    }),
    prompts: Object.freeze({
      register(definition) {
        return registerPrompt(definition)
      },
    }),
    services: Object.freeze({
      provide(name, value) {
        return provideService(name, value)
      },
      invoke(name, method, args = []) {
        return invokeService(name, method, args)
      },
      has(name) {
        return hasService(name)
      },
    }),
    audit: Object.freeze({
      emit(event, details = {}) {
        emitAudit(event, details)
      },
    }),
  }
  return Object.freeze(context)
}

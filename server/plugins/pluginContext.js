export function createPluginContext({
  manifest,
  config,
  track,
  registerTool,
  registerEvent,
  provideService,
  getService,
  hasService,
  emitAudit,
}) {
  const context = {
    plugin: manifest,
    config: Object.freeze({ ...(config || {}) }),
    lifecycle: Object.freeze({
      onDispose(effect) {
        return track(effect)
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
    services: Object.freeze({
      provide(name, value) {
        return provideService(name, value)
      },
      get(name) {
        return getService(name)
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

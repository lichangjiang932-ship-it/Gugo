const MODEL_READINESS_VIEW = Object.freeze({
  loading: { state: 'loading', label: 'taskCenter.modelReadiness.loading', detail: 'taskCenter.modelReadiness.loadingDetail' },
  unconfigured: { state: 'unconfigured', label: 'taskCenter.modelReadiness.unconfigured', detail: 'taskCenter.modelReadiness.unconfiguredDetail' },
  empty: { state: 'unavailable', label: 'taskCenter.modelReadiness.unavailable', detail: 'taskCenter.modelReadiness.emptyDetail' },
  'selection-required': { state: 'unavailable', label: 'taskCenter.modelReadiness.unavailable', detail: 'taskCenter.modelReadiness.selectionDetail' },
  'provider-unverified': { state: 'untested', label: 'taskCenter.modelReadiness.untested', detail: 'taskCenter.modelReadiness.untestedDetail' },
  'provider-chat-only': { state: 'chat-only', label: 'taskCenter.modelReadiness.chatOnly', detail: 'taskCenter.modelReadiness.chatOnlyDetail' },
  'provider-unavailable': { state: 'unavailable', label: 'taskCenter.modelReadiness.unavailable', detail: 'taskCenter.modelReadiness.unavailableDetail' },
  ready: { state: 'agent-ready', label: 'taskCenter.modelReadiness.agentReady', detail: 'taskCenter.modelReadiness.agentReadyDetail' },
  error: { state: 'unavailable', label: 'taskCenter.modelReadiness.unavailable', detail: 'taskCenter.modelReadiness.errorDetail' },
})

export function describeTaskModelReadiness(readiness = {}) {
  return MODEL_READINESS_VIEW[readiness?.kind] || MODEL_READINESS_VIEW.error
}

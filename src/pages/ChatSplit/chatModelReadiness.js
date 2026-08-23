export const INITIAL_MODEL_CATALOG_STATE = Object.freeze({ kind: 'loading' })

export function modelOptionsFromStatus(status = {}) {
  if (Array.isArray(status?.models) && status.models.length > 0) return status.models
  if (!status?.modelName) return []
  return [{
    name: status.modelName,
    active: true,
    contextWindow: status.contextWindow,
    contextWindowSource: status.contextWindowSource,
    contextWindowEstimated: status.contextWindowEstimated,
    contextWindowSourceUrl: status.contextWindowSourceUrl,
    contextWindowVerifiedAt: status.contextWindowVerifiedAt,
    maxOutputTokens: status.maxOutputTokens,
  }]
}

export function modelCatalogStateFromStatus(status = {}, modelOptions = []) {
  if (status?.configured === false) {
    return {
      kind: 'unconfigured',
      missing: Array.isArray(status.missing) ? status.missing : [],
    }
  }
  if (!Array.isArray(modelOptions) || modelOptions.length === 0) return { kind: 'empty' }
  return { kind: 'ready' }
}

export function resolveModelOptionReadiness(model = {}) {
  const configRevision = Number(model?.configRevision)
  const managedProvider = Boolean(
    String(model?.providerKey || '').trim()
    || Number.isInteger(configRevision),
  )
  const readiness = model?.readiness
  const testedRevision = Number(readiness?.configRevision)

  // Deployment-provided models do not have a persisted probe receipt. Keep
  // them selectable for backwards compatibility, but do not claim that their
  // Agent capabilities were verified.
  if (!managedProvider || !readiness || testedRevision !== configRevision) {
    return { kind: 'untested', canSelect: true, managedProvider }
  }
  if (readiness.mode === 'unavailable' || readiness.chat !== true) {
    return { kind: 'unavailable', canSelect: false, managedProvider: true }
  }
  if (readiness.mode === 'chat_only' || readiness.agent !== true || readiness.tools !== true) {
    return { kind: 'chat-only', canSelect: true, managedProvider: true }
  }
  return { kind: 'agent-ready', canSelect: true, managedProvider: true }
}

export function resolveChatModelReadiness({
  catalogState = INITIAL_MODEL_CATALOG_STATE,
  modelOptions = [],
  modelName = '',
  modelProviderId = '',
} = {}) {
  const catalogKind = String(catalogState?.kind || 'loading')
  if (catalogKind !== 'ready') return { ...catalogState, kind: catalogKind, canSend: false, modelName: '' }

  const options = Array.isArray(modelOptions) ? modelOptions : []
  const selected = String(modelName || '').trim()
  const selectedProviderId = String(modelProviderId || '').trim()
  if (options.length === 0) return { kind: 'empty', canSend: false, modelName: '' }
  const matched = options.find((model) => (
    String(model?.name || '').trim() === selected
    && (!selectedProviderId || String(model?.provider || '').trim() === selectedProviderId)
  ))
  if (!selected || !matched) return { kind: 'selection-required', canSend: false, modelName: '' }
  const optionReadiness = resolveModelOptionReadiness(matched)
  if (optionReadiness.managedProvider) {
    const currentRevision = Number(matched.configRevision)
    const context = {
      canSend: false,
      modelName: selected,
      modelProviderId: String(matched.provider || selectedProviderId || '').trim(),
      configRevision: Number.isInteger(currentRevision) ? currentRevision : null,
    }
    if (optionReadiness.kind === 'untested') {
      return { ...context, kind: 'provider-unverified' }
    }
    if (optionReadiness.kind === 'unavailable') {
      return { ...context, kind: 'provider-unavailable' }
    }
    if (optionReadiness.kind === 'chat-only') {
      return { ...context, kind: 'provider-chat-only', canSend: true }
    }
  }
  return {
    kind: 'ready',
    canSend: true,
    modelName: selected,
    ...(String(matched.provider || selectedProviderId || '').trim()
      ? { modelProviderId: String(matched.provider || selectedProviderId || '').trim() }
      : {}),
    ...(Number.isInteger(Number(matched.configRevision)) && Number(matched.configRevision) > 0
      ? { configRevision: Number(matched.configRevision) }
      : {}),
  }
}

export function modelReadinessMessageKey(readiness = {}) {
  switch (readiness.kind) {
    case 'loading': return 'chat.modelPicker.loadingSendBlocked'
    case 'unconfigured': return 'chat.modelPicker.unconfiguredSendBlocked'
    case 'error': return 'chat.modelPicker.errorSendBlocked'
    case 'empty': return 'chat.modelPicker.emptySendBlocked'
    case 'selection-required': return 'chat.modelPicker.selectionSendBlocked'
    case 'provider-unverified': return 'errors.modelProviderUnverified'
    case 'provider-chat-only': return readiness.canSend === false ? 'errors.modelProviderChatOnly' : ''
    case 'provider-unavailable': return 'errors.modelEndpointUnavailable'
    default: return ''
  }
}

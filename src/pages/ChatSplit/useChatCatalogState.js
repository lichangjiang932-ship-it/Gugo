import { useEffect, useMemo, useState } from 'react'
import {
  isAuthoritativeContextWindow,
  resolveModelContextWindow,
} from '../../lib/contextUsage.js'
import {
  readStoredModelSelection,
  resolveSessionModelSelection,
} from '../../lib/modelSelection.js'
import { SERVER_TURN_TOOL_TOGGLE_NAMES } from '../../lib/serverToolConfig.js'
import {
  buildServerToolCatalogFallback,
  fetchServerToolCatalog,
  selectEnabledServerToolSpecs,
} from '../../lib/serverToolCatalog.js'
import { resolveChatModelReadiness } from './chatModelReadiness.js'
import useChatRuntimeCatalog from './useChatRuntimeCatalog.js'

const EMPTY_MESSAGES = []

export default function useChatCatalogState({
  authoritativeModelFailure,
  globalActiveAgentId,
  lang,
  state,
  t,
}) {
  const {
    modelCatalogState,
    modelOptions,
    reloadModels,
    runtimeSkills,
    selectedModel,
    selectedModelProviderId,
    setSelectedModel,
    slashRegistry,
  } = useChatRuntimeCatalog({ lang, skillConfigs: state.skillConfigs, t })
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
  const activeSessionId = activeSession?.id || null
  const effectiveAgentId = activeSession?.agentId || globalActiveAgentId || null
  const messages = activeSession?.messages ?? EMPTY_MESSAGES

  const fallbackContextToolSpecs = useMemo(() => {
    const enabledNames = SERVER_TURN_TOOL_TOGGLE_NAMES.filter((name) => state.toolsConfig?.[name] === true)
    return buildServerToolCatalogFallback(enabledNames)
  }, [state.toolsConfig])
  const [serverToolCatalog, setServerToolCatalog] = useState(null)
  useEffect(() => {
    let active = true
    fetchServerToolCatalog()
      .then((catalog) => { if (active) setServerToolCatalog(catalog) })
      .catch(() => { /* Context estimation keeps server-tool placeholders without duplicating schemas. */ })
    return () => { active = false }
  }, [])
  const contextToolSpecs = useMemo(() => (
    serverToolCatalog
      ? selectEnabledServerToolSpecs(serverToolCatalog, state.toolsConfig)
      : fallbackContextToolSpecs
  ), [fallbackContextToolSpecs, serverToolCatalog, state.toolsConfig])

  const storedModelSelection = readStoredModelSelection()
  const effectiveModelSelection = resolveSessionModelSelection(modelOptions, {
    sessionModel: activeSession?.modelName,
    sessionProviderId: activeSession?.modelProviderId,
    selectedModel,
    selectedProviderId: selectedModelProviderId,
    storedModel: storedModelSelection.modelName,
    storedProviderId: storedModelSelection.providerId,
  })
  const effectiveSelectedModel = effectiveModelSelection.modelName
  const effectiveSelectedModelProviderId = effectiveModelSelection.providerId
  const catalogModelReadiness = resolveChatModelReadiness({
    catalogState: modelCatalogState,
    modelName: effectiveSelectedModel,
    modelProviderId: effectiveSelectedModelProviderId,
    modelOptions,
  })
  const modelReadiness = authoritativeModelFailure || catalogModelReadiness
  const selectedContextWindow = resolveModelContextWindow(
    modelOptions,
    effectiveSelectedModel,
    undefined,
    effectiveSelectedModelProviderId,
  )
  const selectedModelOption = modelOptions.find((model) => (
    model?.name === effectiveSelectedModel
    && (!effectiveSelectedModelProviderId || model?.provider === effectiveSelectedModelProviderId)
  ))
  const selectedContextWindowAuthoritative = isAuthoritativeContextWindow(selectedModelOption)

  return {
    activeSession,
    activeSessionId,
    contextToolSpecs,
    effectiveAgentId,
    effectiveSelectedModel,
    effectiveSelectedModelProviderId,
    messages,
    modelOptions,
    modelReadiness,
    reloadModels,
    runtimeSkills,
    selectedContextWindow,
    selectedContextWindowAuthoritative,
    selectedModel,
    selectedModelProviderId,
    setSelectedModel,
    slashRegistry,
  }
}

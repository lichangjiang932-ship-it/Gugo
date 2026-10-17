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
  // A window is "known" when the selected model actually carries one. The
  // resolver's 128k fallback is still returned as a denominator, but it must not
  // turn into a precise-looking ring for a model whose window is not known.
  const selectedContextWindowKnown = Number(selectedModelOption?.contextWindow) > 0
  const selectedContextWindowSource = String(selectedModelOption?.contextWindowSource || '')
  const selectedContextWindowEstimated = selectedContextWindowKnown
    && (selectedModelOption?.contextWindowEstimated === true || !selectedContextWindowAuthoritative)

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
    selectedContextWindowEstimated,
    selectedContextWindowKnown,
    selectedContextWindowSource,
    selectedConfigRevision: Number.isInteger(selectedModelOption?.configRevision) ? selectedModelOption.configRevision : null,
    selectedModel,
    selectedModelProviderId,
    setSelectedModel,
    slashRegistry,
  }
}

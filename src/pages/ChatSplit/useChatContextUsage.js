import { useMemo } from 'react'
import { createContextUsageEstimator, sumSessionModelUsage } from '../../lib/contextUsage.js'
import { browserOutputKey, useBrowserOutputTiming } from '../../lib/browserOutputTiming.js'
import { buildPendingContextUsage, createContextHistoryGuard, createStreamingContextAnchor } from '../../lib/contextMeter.js'

export default function useChatContextUsage({ messages, contextToolSpecs, contextSystemPrompt, contextWindow, contextWindowAuthoritative, contextWindowEstimated = false, contextWindowKnown = null, contextWindowSource = '', recoveryOwnerScope, activeSessionId, input = '', attachments = [], selectedModel = '', selectedModelProviderId = '', selectedConfigRevision = null }) {
  const estimate = useMemo(() => createContextUsageEstimator(), [])
  const historyGuard = useMemo(() => createContextHistoryGuard(), [])
  const streamingAnchor = useMemo(() => createStreamingContextAnchor(), [])
  const configurationSnapshot = useMemo(() => ({ id: '__context_configuration__', content: contextSystemPrompt, tool_calls: contextToolSpecs }), [contextSystemPrompt, contextToolSpecs])
  const latestIndex = messages.findLastIndex(message => message?.role === 'assistant')
  const latest = messages.findLast(message => message?.role === 'assistant')
  const observation = latest?.meta?.modelContextUsage
  const live = latest?.meta?.streaming === true && observation?.stage !== 'retained'
  const scope = JSON.stringify([recoveryOwnerScope, activeSessionId, selectedModel, selectedModelProviderId, selectedConfigRevision])
  const observationDeltaTokens = streamingAnchor(scope, observation, estimate({ messages: latest ? [latest] : [] }).estimatedTokens)
  const browserTiming = useBrowserOutputTiming(browserOutputKey(recoveryOwnerScope, activeSessionId, latest))
  return {
    ...buildPendingContextUsage({ messages, tools: contextToolSpecs, systemPrompt: contextSystemPrompt, contextWindow, contextWindowAuthoritative,
      contextWindowEstimated, contextWindowKnown, contextWindowSource,
      input, attachments, selectedModel, selectedModelProviderId, selectedConfigRevision, estimate,
      observation, observationDeltaTokens, actualPromptTokens: latest?.meta?.actualPromptTokens, serverEstimatedPromptTokens: latest?.meta?.serverEstimatedPromptTokens,
      allowServerBaseline: historyGuard(JSON.stringify([recoveryOwnerScope, activeSessionId, latest?.meta?.modelContextUsage?.requestId, latest?.meta?.modelContextUsage?.stage]), [...messages.slice(0, latestIndex + (live ? 0 : 1)), configurationSnapshot]),
      tailMessages: live ? [] : messages.slice(latestIndex + 1),
    }),
    cumulativeTokens: sumSessionModelUsage(messages), modelUsage: latest?.meta?.modelUsage,
    modelContextDiagnostics: latest?.meta?.modelContextDiagnostics, modelWireDiagnostics: latest?.meta?.modelWireDiagnostics,
    modelTiming: latest?.meta?.modelTiming, browserTiming, modelCompilerDiagnostics: latest?.meta?.modelCompilerDiagnostics,
    previousModelWireDiagnostics: messages.findLast(message => message !== latest && message?.role === 'assistant' && message?.meta?.modelWireDiagnostics)?.meta?.modelWireDiagnostics,
    contextWindowAuthoritative,
  }
}

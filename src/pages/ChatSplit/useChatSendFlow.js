import { useCallback, useRef } from 'react'
import { serializeAttachmentReferences } from '../../lib/attachmentClient.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import {
  readStoredModelSelection,
  resolveInitialModelSelection,
  resolveSessionModelSelection,
} from '../../lib/modelSelection.js'
import { inferSkillIdFromPrompt, parseSkillCommand } from '../../lib/skillCommands.js'
import { buildServerTurnMessageIds, runServerChatTurn } from './serverTurnFlow.js'
import {
  applyPlanExecutionConfirmation,
  intentModeForAgentMode,
  resolvePlanExecutionConfirmation,
} from './chatSendMode.js'
import { serializeServerTurnHistory } from './serverTurnHistory.js'
import { hasTurnRun } from './turnRunRegistry.js'

export default function useChatSendFlow({
  abortCtrlRef,
  abortSessionIdRef,
  attachments,
  approvalMode = 'normal',
  changeApprovalMode,
  directoryApprovalResolveRef,
  dispatch,
  effectiveAgentId,
  ensureLocalPathAccess,
  isGenerating,
  modelReadiness,
  modelOptions,
  onModelUnavailable,
  onTurnStart,
  onTurnResult,
  probeLocalPathAccess,
  requestServerToolApproval,
  resolveToolApprovalForOwner,
  runtimeSkills,
  selectedModel,
  selectedModelProviderId,
  setContextSystemPrompts,
  state,
  t,
  clearToolApprovalForOwner,
}) {
  const sendInFlightRef = useRef(false)
  return useCallback(async (content, explicitAttachments = null, historyLimit = null) => {
    if (isGenerating || directoryApprovalResolveRef.current || sendInFlightRef.current) return false
    sendInFlightRef.current = true
    try {
    let sessionId = state.activeSessionId
    let activeSession = state.sessions.find((session) => session.id === sessionId)
    const storedSelection = readStoredModelSelection()
    const modelSelection = resolveSessionModelSelection(modelOptions, {
      sessionModel: activeSession?.modelName,
      sessionProviderId: activeSession?.modelProviderId,
      selectedModel,
      selectedProviderId: selectedModelProviderId,
      storedModel: storedSelection.modelName,
      storedProviderId: storedSelection.providerId,
    })
    const fallbackSelection = modelSelection.modelName
      ? modelSelection
      : resolveInitialModelSelection(modelOptions)
    const modelName = fallbackSelection.modelName
    const modelProviderId = fallbackSelection.providerId
    const modelMode = modelReadiness?.kind === 'provider-chat-only' ? 'chat_only' : 'agent'
    const modelIsExecutable = modelReadiness?.canSend !== false
      && !!modelName
      && modelOptions.some((model) => (
        model?.name === modelName
        && (!modelProviderId || model?.provider === modelProviderId)
      ))
    if (!modelIsExecutable) {
      onModelUnavailable?.(modelReadiness?.canSend === false
        ? modelReadiness
        : { kind: modelOptions.length > 0 ? 'selection-required' : 'empty', canSend: false })
      return false
    }
    if (!activeSession) {
      sessionId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      activeSession = { id: sessionId, title: t('chatReliability.newConversation'), messages: [], agentId: effectiveAgentId || null }
      abortSessionIdRef.current = sessionId
      dispatch({ type: 'NEW_SESSION', payload: { id: sessionId, title: activeSession.title, agentId: effectiveAgentId || null } })
    }
    if (hasTurnRun(sessionId)) return false
    if (modelName && (
      activeSession.modelName !== modelName
      || String(activeSession.modelProviderId || '') !== modelProviderId
    )) {
      dispatch({ type: 'SET_SESSION_MODEL', payload: { sessionId, modelName, modelProviderId: modelProviderId || null } })
    }
    const sourceMessages = historyLimit == null ? activeSession.messages || [] : (activeSession.messages || []).slice(0, historyLimit)
    const historyMessages = serializeServerTurnHistory(sourceMessages)
    const turnId = crypto.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const turnMessageIds = buildServerTurnMessageIds(turnId)
    const turnAttachments = explicitAttachments ?? attachments
    const attachmentReferences = serializeAttachmentReferences(turnAttachments)
    const displayContent = typeof content === 'string' ? content : String(content || '')
    onTurnStart?.({ sessionId })
    dispatch({ type: 'SEND_MESSAGE', payload: { id: turnMessageIds.userId, sessionId, content: displayContent, attachments: attachmentReferences } })

    if (activeSession.title === t('chatReliability.newConversation') || activeSession.title.startsWith(t('chatReliability.newSession'))) {
      const fallback = content.slice(0, 18).trim() || t('chatReliability.newConversation')
      dispatch({ type: 'UPDATE_SESSION_TITLE_FOR', payload: { sessionId, title: fallback.length > 15 ? `${fallback.slice(0, 15)}…` : fallback } })
    }
    const parsedSkill = parseSkillCommand(content)
    const requestedSkillId = parsedSkill.skillId || inferSkillIdFromPrompt(content)
    const requestedSkill = requestedSkillId ? runtimeSkills.find((skill) => skill.id === requestedSkillId && skill.runnable !== false) : null
    const skill = requestedSkill && state.skillConfigs?.[requestedSkill.id]?.enabled !== false ? requestedSkill : null
    if (!isLoggedInLocally()) {
      dispatch({ type: 'RECEIVE_MESSAGE', payload: { sessionId, content: t('chatReliability.loginRequired') } })
      return false
    }
    const planExecutionConfirmation = resolvePlanExecutionConfirmation({
      content,
      agentMode: state.agentMode,
      approvalMode,
    })
    const modeTransition = await applyPlanExecutionConfirmation(planExecutionConfirmation, {
      currentApprovalMode: approvalMode,
      changeApprovalMode,
      dispatch,
    })
    if (!modeTransition.proceed) return false
    const localPathAccess = await ensureLocalPathAccess(content)
    if (!localPathAccess.proceed) return false
    const effectiveAgentMode = planExecutionConfirmation?.agentMode || state.agentMode
    const intentMode = intentModeForAgentMode(effectiveAgentMode)
    const taskId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const turnResult = await runServerChatTurn({
      abortCtrlRef,
      agentId: effectiveAgentId,
      attachments,
      content,
      displayContent,
      dispatch,
      explicitAttachments,
      historyMessages,
      intentMode,
      localPathAccess,
      modelName,
      modelProviderId,
      modelMode,
      probeLocalPathAccess,
      requestServerToolApproval,
      resolveToolApprovalForOwner,
      sessionId,
      setContextSystemPrompts,
      clearToolApprovalForOwner,
      skill,
      skillId: skill?.id || null,
      taskId,
      taskName: skill?.name || t('chatReliability.generalTask'),
      t,
      toolsConfig: state.toolsConfig,
      turnId,
      userPrompt: parsedSkill.skillId && skill ? parsedSkill.userPrompt : content,
    })
    onTurnResult?.({ sessionId, turnId, result: turnResult })
    return true
    } finally {
      sendInFlightRef.current = false
    }
  }, [
    abortCtrlRef, abortSessionIdRef, attachments, approvalMode, changeApprovalMode,
    directoryApprovalResolveRef, dispatch, effectiveAgentId,
    ensureLocalPathAccess, isGenerating, modelOptions, modelReadiness, onModelUnavailable, onTurnResult, onTurnStart, probeLocalPathAccess, requestServerToolApproval,
    resolveToolApprovalForOwner, runtimeSkills, selectedModel, selectedModelProviderId,
    setContextSystemPrompts, clearToolApprovalForOwner,
    state.activeSessionId, state.agentMode, state.sessions, state.skillConfigs, state.toolsConfig, t,
  ])
}

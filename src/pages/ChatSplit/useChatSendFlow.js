import { useCallback } from 'react'
import { serializeAttachmentReferences } from '../../lib/attachmentClient.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { readStoredModel, resolveInitialModel, resolveSessionModel } from '../../lib/modelSelection.js'
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
  modelOptions,
  probeLocalPathAccess,
  requestServerToolApproval,
  resolveToolApprovalForOwner,
  runtimeSkills,
  selectedModel,
  setContextSystemPrompts,
  state,
  t,
  toast,
  clearToolApprovalForOwner,
}) {
  return useCallback(async (content, explicitAttachments = null, historyLimit = null) => {
    if (isGenerating || directoryApprovalResolveRef.current) return
    let sessionId = state.activeSessionId
    let activeSession = state.sessions.find((session) => session.id === sessionId)
    if (!activeSession) {
      sessionId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      activeSession = { id: sessionId, title: t('chatReliability.newConversation'), messages: [], agentId: effectiveAgentId || null }
      abortSessionIdRef.current = sessionId
      dispatch({ type: 'NEW_SESSION', payload: { id: sessionId, title: activeSession.title, agentId: effectiveAgentId || null } })
    }
    if (hasTurnRun(sessionId)) return
    const modelName = resolveSessionModel(modelOptions, {
      sessionModel: activeSession.modelName,
      selectedModel,
      storedModel: readStoredModel(),
    }) || activeSession.modelName || selectedModel || readStoredModel() || resolveInitialModel(modelOptions)
    if (modelName && activeSession.modelName !== modelName) {
      dispatch({ type: 'SET_SESSION_MODEL', payload: { sessionId, modelName } })
    }
    const sourceMessages = historyLimit == null ? activeSession.messages || [] : (activeSession.messages || []).slice(0, historyLimit)
    const historyMessages = serializeServerTurnHistory(sourceMessages)
    const turnId = crypto.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const turnMessageIds = buildServerTurnMessageIds(turnId)
    const turnAttachments = explicitAttachments ?? attachments
    const attachmentReferences = serializeAttachmentReferences(turnAttachments)
    const displayContent = typeof content === 'string' ? content : String(content || '')
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
      toast.error(t('errors.loginRequired'))
      return
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
    if (!modeTransition.proceed) return
    const localPathAccess = await ensureLocalPathAccess(content)
    if (!localPathAccess.proceed) return
    const effectiveAgentMode = planExecutionConfirmation?.agentMode || state.agentMode
    const intentMode = intentModeForAgentMode(effectiveAgentMode)
    const taskId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    await runServerChatTurn({
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
      toast,
      toolsConfig: state.toolsConfig,
      turnId,
      userPrompt: parsedSkill.skillId && skill ? parsedSkill.userPrompt : content,
    })
  }, [
    abortCtrlRef, abortSessionIdRef, attachments, approvalMode, changeApprovalMode,
    directoryApprovalResolveRef, dispatch, effectiveAgentId,
    ensureLocalPathAccess, isGenerating, modelOptions, probeLocalPathAccess, requestServerToolApproval,
    resolveToolApprovalForOwner, runtimeSkills, selectedModel, setContextSystemPrompts, clearToolApprovalForOwner,
    state.activeSessionId, state.agentMode, state.sessions, state.skillConfigs, state.toolsConfig, t, toast,
  ])
}

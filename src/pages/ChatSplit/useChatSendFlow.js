import { useCallback, useRef } from 'react'
import { serializeAttachmentReferences } from '../../lib/attachmentClient.js'
import { isLoggedInLocally, setAuthToken } from '../../lib/accountClient.js'
import { isModelSetupFailure } from '../../lib/chatFlowGuards.js'
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
import { preflightChatModelSelection } from './chatModelPreflight.js'

export default function useChatSendFlow({
  activateWorkspaceForTurn,
  abortCtrlRef,
  abortSessionIdRef,
  attachments,
  approvalMode = 'normal',
  changeApprovalMode,
  directoryApprovalResolveRef,
  dispatch,
  draftWorkspacePath = '',
  effectiveAgentId,
  ensureLocalPathAccess,
  isGenerating,
  lang,
  modelReadiness,
  modelOptions,
  onAuthenticationRequired,
  onModelCatalogChanged,
  onModelUnavailable,
  onSendRejected,
  onSendBlocked,
  onTurnStart,
  onTurnResult,
  onWorkspaceUnavailable,
  probeLocalPathAccess,
  refreshAuth,
  requestServerToolApproval,
  resolveToolApprovalForOwner,
  runtimeSkills,
  selectedModel,
  selectedModelProviderId,
  setContextSystemPrompts,
  state,
  t,
  clearToolApprovalForOwner,
  preflightModelSelection = preflightChatModelSelection,
  runChatTurn = runServerChatTurn,
}) {
  const sendInFlightRef = useRef(false)
  return useCallback(async (content, explicitAttachments = null, historyLimit = null, onAccepted = null) => {
    if (isGenerating) {
      onSendBlocked?.('turn-running')
      return false
    }
    if (directoryApprovalResolveRef.current) {
      onSendBlocked?.('directory-approval')
      return false
    }
    if (sendInFlightRef.current) {
      onSendBlocked?.('send-pending')
      return false
    }
    sendInFlightRef.current = true
    try {
    if (!isLoggedInLocally()) {
      onAuthenticationRequired?.()
      return false
    }
    let sessionId = state.activeSessionId || String(state.draftSessionId || '').trim() || null
    let activeSession = state.sessions.find((session) => session.id === sessionId)
    const storedWorkspacePath = String(activeSession?.workspacePath || '').trim()
    // Never attach an unscoped/legacy conversation to the global default
    // workspace. Only explicit draft or persisted Session project membership
    // may enter a Turn request.
    let workspacePath = storedWorkspacePath || (!activeSession ? String(draftWorkspacePath || '').trim() : '')
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
    const candidateModelName = fallbackSelection.modelName
    const candidateModelProviderId = fallbackSelection.providerId
    const selectedOption = modelOptions.find((model) => (
      model?.name === candidateModelName
      && (!candidateModelProviderId || model?.provider === candidateModelProviderId)
    ))
    const candidateConfigRevision = Number(selectedOption?.configRevision || modelReadiness?.configRevision) || null
    const modelIsExecutable = modelReadiness?.canSend !== false
      && !!candidateModelName
      && !!selectedOption
    if (!modelIsExecutable) {
      onModelUnavailable?.(modelReadiness?.canSend === false
        ? modelReadiness
        : { kind: modelOptions.length > 0 ? 'selection-required' : 'empty', canSend: false })
      return false
    }
    const preflightInput = {
      modelName: candidateModelName,
      modelProviderId: candidateModelProviderId,
      modelConfigRevision: candidateConfigRevision,
    }
    let preflight = await preflightModelSelection(preflightInput)
    if (preflight?.authenticationRequired === true && typeof refreshAuth === 'function') {
      const refreshed = await refreshAuth({ retryDelays: [0] })
      if (refreshed?.authenticated === true && isLoggedInLocally()) {
        // The status request is read-only, so retrying it after a successful
        // local bootstrap cannot duplicate a Turn or any external side effect.
        preflight = await preflightModelSelection(preflightInput)
      }
    }
    if (!preflight?.ok) {
      if (preflight?.authenticationRequired === true) {
        setAuthToken('')
        dispatch({ type: 'LOGOUT' })
        onAuthenticationRequired?.()
        return false
      }
      onModelCatalogChanged?.()
      onModelUnavailable?.(preflight?.readiness || { kind: 'error', canSend: false })
      return false
    }
    const modelName = preflight.selection.modelName
    const modelProviderId = preflight.selection.modelProviderId
    const modelConfigRevision = preflight.selection.modelConfigRevision
    const modelMode = preflight.selection.modelMode
    if (!activeSession) {
      sessionId ||= crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      activeSession = {
        id: sessionId,
        title: t('chatReliability.newConversation'),
        messages: [],
        agentId: effectiveAgentId || null,
        ...(workspacePath ? { workspacePath } : {}),
      }
    }
    if (hasTurnRun(sessionId)) {
      onSendBlocked?.('turn-running')
      return false
    }
    const sourceMessages = historyLimit == null ? activeSession.messages || [] : (activeSession.messages || []).slice(0, historyLimit)
    const historyMessages = serializeServerTurnHistory(sourceMessages)
    const turnId = crypto.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const turnMessageIds = buildServerTurnMessageIds(turnId)
    const turnAttachments = explicitAttachments ?? attachments
    const attachmentReferences = serializeAttachmentReferences(turnAttachments)
    const displayContent = typeof content === 'string' ? content : String(content || '')
    const parsedSkill = parseSkillCommand(content)
    const requestedSkillId = parsedSkill.skillId || inferSkillIdFromPrompt(content)
    const requestedSkill = requestedSkillId ? runtimeSkills.find((skill) => skill.id === requestedSkillId && skill.runnable !== false) : null
    const skill = requestedSkill && state.skillConfigs?.[requestedSkill.id]?.enabled !== false ? requestedSkill : null
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
    if (workspacePath && typeof activateWorkspaceForTurn === 'function') {
      try {
        const activated = await activateWorkspaceForTurn(workspacePath)
        workspacePath = String(activated?.path || workspacePath).trim()
        activeSession = { ...activeSession, workspacePath }
      } catch (error) {
        onWorkspaceUnavailable?.(error, { path: workspacePath })
        return false
      }
    }
    const localPathAccess = await ensureLocalPathAccess(content)
    if (!localPathAccess.proceed) return false
    const effectiveAgentMode = planExecutionConfirmation?.agentMode || state.agentMode
    const intentMode = intentModeForAgentMode(effectiveAgentMode)
    const taskId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    let clientCommitted = false
    const commitClientTurn = () => {
      if (clientCommitted) return
      clientCommitted = true
      // Persist edits made while the server ACK was pending before NEW_SESSION
      // activates the accepted session and its lifecycle restores that draft.
      onAccepted?.({ sessionId })
      if (!state.activeSessionId) {
        abortSessionIdRef.current = sessionId
        dispatch({
          type: 'NEW_SESSION',
          payload: {
            id: sessionId,
            title: activeSession.title,
            agentId: effectiveAgentId || null,
            ...(workspacePath ? { workspacePath } : {}),
          },
        })
      } else if (workspacePath && storedWorkspacePath !== workspacePath) {
        dispatch({ type: 'SET_SESSION_WORKSPACE', payload: { sessionId, workspacePath } })
      }
      if (modelName && (
        activeSession.modelName !== modelName
        || String(activeSession.modelProviderId || '') !== modelProviderId
      )) {
        dispatch({ type: 'SET_SESSION_MODEL', payload: { sessionId, modelName, modelProviderId: modelProviderId || null } })
      }
      onTurnStart?.({ sessionId })
      dispatch({ type: 'SEND_MESSAGE', payload: { id: turnMessageIds.userId, sessionId, content: displayContent, attachments: attachmentReferences } })
      if (activeSession.title === t('chatReliability.newConversation') || activeSession.title.startsWith(t('chatReliability.newSession'))) {
        const fallback = content.slice(0, 18).trim() || t('chatReliability.newConversation')
        dispatch({ type: 'UPDATE_SESSION_TITLE_FOR', payload: { sessionId, title: fallback.length > 15 ? `${fallback.slice(0, 15)}…` : fallback } })
      }
    }
    const turnResult = await runChatTurn({
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
      locale: lang,
      modelName,
      modelProviderId,
      modelConfigRevision,
      modelMode,
      onTurnAccepted: commitClientTurn,
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
      workspacePath,
    })
    if (turnResult?.rejectedBeforeStart) {
      if (isModelSetupFailure(turnResult.error)) {
        onModelCatalogChanged?.()
        onModelUnavailable?.({ kind: 'provider-changed', canSend: false, authoritative: true })
      } else if (Number(turnResult.error?.status) === 401) {
        const refreshed = typeof refreshAuth === 'function'
          ? await refreshAuth({ retryDelays: [0] })
          : null
        if (refreshed?.authenticated === true && isLoggedInLocally()) {
          // The create-Turn POST may have reached the server. Never replay it
          // automatically; tell the user that credentials are fresh and let
          // them explicitly send the preserved draft again.
          onSendRejected?.(turnResult.error, { authenticationRefreshed: true })
        } else {
          setAuthToken('')
          dispatch({ type: 'LOGOUT' })
          onAuthenticationRequired?.()
        }
      } else {
        onSendRejected?.(turnResult.error)
      }
      return false
    }
    onTurnResult?.({ sessionId, turnId, result: turnResult })
    return clientCommitted
    } finally {
      sendInFlightRef.current = false
    }
  }, [
    abortCtrlRef, abortSessionIdRef, activateWorkspaceForTurn, attachments, approvalMode, changeApprovalMode,
    directoryApprovalResolveRef, dispatch, draftWorkspacePath, effectiveAgentId,
    ensureLocalPathAccess, isGenerating, lang, modelOptions, modelReadiness, onAuthenticationRequired, onModelCatalogChanged, onModelUnavailable, onSendBlocked, onSendRejected, onTurnResult, onTurnStart, onWorkspaceUnavailable, preflightModelSelection, probeLocalPathAccess, requestServerToolApproval,
    refreshAuth, resolveToolApprovalForOwner, runChatTurn, runtimeSkills, selectedModel, selectedModelProviderId,
    setContextSystemPrompts, clearToolApprovalForOwner,
    state.activeSessionId, state.agentMode, state.draftSessionId, state.sessions, state.skillConfigs, state.toolsConfig, t,
  ])
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '../../lib/router.jsx'
import { useAppContext } from '../../store/AppContext'
import { writeStoredModelSelection } from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { SETTINGS_TAB_MODELS, settingsPathForSection } from '../../lib/settingsNavigation.js'
import { useActiveAgent } from '../../agents/activeAgentContext.js'
import { getSlashActionCopy } from '../../lib/slashCoreCommands.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import { persistSlashGoals } from '../../lib/slashGoals.js'
import { recordChatFeedback } from '../../lib/evolutionClient.js'
import { readContextUsageVisible, readDesktopPetVisible, readWorkbenchOpen } from '../../lib/chatUiPreferences.js'
import { useToast } from '../../components/Toast.jsx'
import { useT } from '../../i18n/I18nProvider.jsx'
import ChatSplitView from './ChatSplitView.jsx'
import useInputHistory from './useInputHistory.js'
import useChatApprovals from './useChatApprovals.js'
import useDirectoryApproval from './useDirectoryApproval.js'
import useVoiceRecognition from './useVoiceRecognition.js'
import useChatSessionLifecycle from './useChatSessionLifecycle.js'
import useChatSendFlow from './useChatSendFlow.js'
import useTurnSteering from './useTurnSteering.js'
import useSlashCommandExecution from './useSlashCommandExecution.js'
import { readSessionDraft } from '../../lib/chatDrafts.js'
import { useChatAttachmentActions } from './chatAttachmentActions.js'
import useChatCatalogState from './useChatCatalogState.js'
import { useChatReplayActions } from './chatReplayActions.js'
import { useChatSendActions } from './chatSendActions.js'
import useChatTurnRecovery from './useChatTurnRecovery.js'
import useChatWorkspaceState from './useChatWorkspaceState.js'

const CHAT_MODEL_SETTINGS_PATH = settingsPathForSection(SETTINGS_TAB_MODELS, [], { returnTo: '/chat' })

export default function ChatSplit() {
  const navigate = useNavigate()
  const { state, dispatch, refreshAuth } = useAppContext()
  const toast = useToast()
  const { t, lang } = useT()
  const { activeAgentId: globalActiveAgentId } = useActiveAgent()
  const initialSessionDraft = readSessionDraft((state.sessionDrafts || {})[state.activeSessionId])
  const [input, setInput] = useState(() => (
    state.activeSessionId ? initialSessionDraft.text : String(state.draftInput || '')
  ))
  const [workbenchMessage, setWorkbenchMessage] = useState('')
  const [attachments, setAttachments] = useState(() => initialSessionDraft.attachments)
  const [isGenerating, setIsGenerating] = useState(false)
  const [showContextUsage, setShowContextUsage] = useState(readContextUsageVisible)
  const [workbenchOpen, setWorkbenchOpen] = useState(readWorkbenchOpen)
  const [workbenchTab, setWorkbenchTab] = useState('files')
  const [desktopPetVisible, setDesktopPetVisible] = useState(readDesktopPetVisible)
  const [slashInlinePanel, setSlashInlinePanel] = useState(null)
  const [showContextPanel, setShowContextPanel] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [messageEdit, setMessageEdit] = useState(null)
  const [authoritativeModelFailure, setAuthoritativeModelFailure] = useState(null)
  const [contextSystemPrompts, setContextSystemPrompts] = useState({})
  const abortCtrlRef = useRef(null)
  const preserveAttachmentsForSessionRef = useRef(null)
  const resumingTurnIdsRef = useRef(new Set())
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => {
    if (!workbenchMessage) return undefined
    const timer = setTimeout(() => setWorkbenchMessage(''), 5000)
    return () => clearTimeout(timer)
  }, [workbenchMessage])

  const {
    activeSession, activeSessionId, contextToolSpecs, effectiveAgentId,
    effectiveSelectedModel, effectiveSelectedModelProviderId, messages,
    modelOptions, modelReadiness, reloadModels, runtimeSkills, selectedContextWindow,
    selectedContextWindowAuthoritative,
    selectedModel, selectedModelProviderId, setSelectedModel, slashRegistry,
  } = useChatCatalogState({
    authoritativeModelFailure, globalActiveAgentId, lang, state, t,
  })
  const {
    activateWorkspaceForTurn, draftWorkspacePath, handleWorkspaceClear,
    handleWorkspaceSelect, recentWorkspaces, selectedWorkspacePath,
    workspaceBusy, workspaceError,
  } = useChatWorkspaceState({ activeSession, activeSessionId, dispatch, state, t })
  const clearMessageEditForSessionChange = useCallback(() => setMessageEdit(null), [])
  const navigateInputHistory = useInputHistory({
    messages,
    input,
    setInput,
    sessionId: activeSessionId,
    enabled: state.inputHistoryNavigationEnabled !== false,
  })
  const approvals = useChatApprovals({ setWorkbenchMessage, toast, t })
  const directory = useDirectoryApproval({ lang, t, toast })
  const { handleVoice, voiceState } = useVoiceRecognition({ dispatch, input, lang, permissions: state.permissions, setInput, setMessage: setWorkbenchMessage, t })
  const { abortSessionIdRef, attachmentsRef, inputRef } = useChatSessionLifecycle({
    abortCtrlRef, attachments, desktopPetVisible, dispatch, input, isGenerating, messages, preserveAttachmentsForSessionRef, setAttachments, setDesktopPetVisible,
    setInput, setIsGenerating, setWorkbenchMessage, showContextUsage, state, toolApproval: approvals.toolApproval,
    workbenchOpen, onSessionChange: clearMessageEditForSessionChange,
  })
  const {
    handleAbort, handleAuthorizeDirectoryRequest, handleDismissResume, handleResume,
    handleTurnResult, handleTurnStart, resumeAvailable, showPendingDirectoryGuidance,
  } = useChatTurnRecovery({
    abortCtrlRef, activeSessionId, approvals, dispatch, isGenerating, messages,
    resumingTurnIdsRef, setInput, setWorkbenchMessage, state, stateRef, t, toast,
  })
  const showModelUnavailable = (readiness = modelReadiness) => {
    // The picker owns the durable, actionable readiness presentation. Do not
    // also emit the same failure into the transient chat status strip: that
    // produced two competing notices for one blocked send.
    if (readiness?.authoritative) setAuthoritativeModelFailure(readiness)
    setShowModelPicker(true)
  }
  const retryModels = useCallback(() => {
    setAuthoritativeModelFailure(null)
    reloadModels()
  }, [reloadModels])
  const showAuthenticationRequired = useCallback(() => {
    window.dispatchEvent(new CustomEvent('auth:required', {
      detail: { path: '/chat', message: t('chatReliability.loginRequired') },
    }))
  }, [t])
  const showSendRejected = useCallback((error, { authenticationRefreshed = false } = {}) => {
    toast.error({
      title: t('toast.chatSendFailed'),
      body: authenticationRefreshed
        ? t('chatReliability.authenticationRefreshedResend')
        : String(error?.message || t('errors.chatFailure')),
    })
  }, [t, toast])
  const showSendBlocked = useCallback((reason) => setWorkbenchMessage(t(reason === 'directory-approval' ? 'chatSteering.directoryAuthorizationRequired'
    : reason === 'send-pending' ? 'chatSteering.sendPending' : 'chatSteering.turnRunning')), [t])
  const triggerSendFlow = useChatSendFlow({
    abortCtrlRef, abortSessionIdRef, activateWorkspaceForTurn, attachments,
    approvalMode: approvals.approvalSettings?.mode || 'normal',
    changeApprovalMode: approvals.changeApprovalMode,
    directoryApprovalResolveRef: directory.directoryApprovalResolveRef,
    draftWorkspacePath,
    dispatch, effectiveAgentId, ensureLocalPathAccess: directory.ensureLocalPathAccess, isGenerating, modelOptions, modelReadiness,
    onAuthenticationRequired: showAuthenticationRequired, onModelCatalogChanged: reloadModels,
    onModelUnavailable: showModelUnavailable, onSendBlocked: showSendBlocked, onSendRejected: showSendRejected,
    onTurnResult: handleTurnResult, onTurnStart: handleTurnStart,
    onWorkspaceUnavailable: (error) => toast.error({
      title: t('chatMessages.workspaceSelectionFailed'),
      body: String(error?.message || t('chatMessages.workspaceSelectionFailed')),
    }),
    probeLocalPathAccess: directory.probeLocalPathAccess, requestServerToolApproval: approvals.requestServerToolApproval,
    refreshAuth, resolveToolApprovalForOwner: approvals.resolveToolApprovalForOwner, runtimeSkills, selectedModel,
    selectedModelProviderId, setContextSystemPrompts,
    clearToolApprovalForOwner: approvals.clearToolApprovalForOwner, state, t,
  })
  const steerActiveTurn = useTurnSteering({
    dispatch, inputRef, setInput, setWorkbenchMessage, stateRef, t,
  })
  const executeSlashEntry = useSlashCommandExecution({
    changeApprovalMode: approvals.changeApprovalMode, dispatch, modelName: effectiveSelectedModel,
    modelConfigRevision: modelReadiness.configRevision,
    modelProviderId: effectiveSelectedModelProviderId, modelReadiness, navigate, onModelUnavailable: showModelUnavailable,
    setDesktopPetVisible, setInput,
    setSlashInlinePanel, setWorkbenchMessage, setWorkbenchOpen, setWorkbenchTab, slashRegistry, stateRef, triggerSendFlow,
  })
  const slashQuery = input.match(/^\/([^\s/]*)$/i)?.[1]
  const slashCommands = slashQuery === undefined ? [] : slashRegistry.listCommands({ query: slashQuery })

  const setModelForActiveSession = (modelName, modelProviderId = '') => {
    const normalized = String(modelName || '').trim()
    if (!normalized) return
    const normalizedProviderId = String(modelProviderId || '').trim()
    setAuthoritativeModelFailure(null)
    setSelectedModel(normalized, normalizedProviderId)
    writeStoredModelSelection({ modelName: normalized, providerId: normalizedProviderId })
    if (activeSessionId) {
      dispatch({
        type: 'SET_SESSION_MODEL',
        payload: { sessionId: activeSessionId, modelName: normalized, modelProviderId: normalizedProviderId || null },
      })
    }
  }
  const { handleKeyDown, handleSend, handleWorkbenchSend } = useChatSendActions({
    attachments,
    attachmentsRef,
    directoryApprovalOpen: directory.directoryApproval.open,
    dispatch,
    executeSlashEntry,
    input,
    inputRef,
    isGenerating,
    messageEdit,
    modelReadiness,
    navigateInputHistory,
    setAttachments,
    setInput,
    setMessageEdit,
    setWorkbenchMessage,
    showAuthenticationRequired,
    showModelUnavailable,
    showPendingDirectoryGuidance,
    slashRegistry,
    state,
    stateRef,
    steerActiveTurn,
    t,
    toast,
    triggerSendFlow,
  })
  const {
    handleCancelMessageEdit,
    handleEditMessage,
    handleRetryModelFailure,
  } = useChatReplayActions({
    attachmentsRef,
    inputRef,
    isGenerating,
    messageEdit,
    modelReadiness,
    setAttachments,
    setInput,
    setMessageEdit,
    setShowModelPicker,
    showModelUnavailable,
    stateRef,
    triggerSendFlow,
  })
  useEffect(() => {
    const handler = (event) => {
      const { choiceId, choiceTitle } = event.detail || {}
      if (choiceId && choiceTitle) triggerSendFlow(`[[choice:${choiceId}]] ${choiceTitle}`)
    }
    window.addEventListener('choice-selected', handler)
    return () => window.removeEventListener('choice-selected', handler)
  }, [triggerSendFlow])
  const { handleExpandCompaction, handleFileChange } = useChatAttachmentActions({
    attachments,
    dispatch,
    preserveAttachmentsForSessionRef,
    setAttachments,
    setWorkbenchMessage,
    state,
    t,
  })
  const handlePermAllow = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    const pending = [...state.tasks].reverse().find((task) => task.status === 'pending')
    if (pending) dispatch({ type: 'UPDATE_TASK', payload: { id: pending.id, updates: { status: TASK_STATUS.RUNNING, stepLabel: t('chatReliability.permissionReady') } } })
    dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionGranted') })
  }
  const handleManageModels = () => {
    if (isLoggedInLocally()) { navigate(CHAT_MODEL_SETTINGS_PATH); return }
    window.dispatchEvent(new CustomEvent('auth:required', { detail: { path: CHAT_MODEL_SETTINGS_PATH, message: t('chatReliability.signInForModels') } }))
  }

  return (
    <ChatSplitView
      activeSession={activeSession} activeSessionId={activeSessionId} approvalMode={approvals.approvalSettings?.mode || 'normal'}
      attachments={attachments} contextSystemPrompt={contextSystemPrompts[state.activeSessionId || '__draft__'] || ''}
      contextToolSpecs={contextToolSpecs} contextWindow={selectedContextWindow} desktopPetVisible={desktopPetVisible}
      contextWindowAuthoritative={selectedContextWindowAuthoritative}
      directoryApproval={directory.directoryApproval} input={input} isGenerating={isGenerating} messages={messages}
      modelOptions={modelOptions} modelReadiness={modelReadiness} onAbort={handleAbort} onApprovalModeChange={approvals.changeApprovalMode}
      onClearWorkspace={handleWorkspaceClear} onSelectWorkspace={handleWorkspaceSelect}
      onAuthorizeDirectoryRequest={handleAuthorizeDirectoryRequest}
      onAuthorizeDirectory={directory.authorizeDirectory} onCloseDesktopPet={() => setDesktopPetVisible(false)}
      onCloseInlinePanel={() => setSlashInlinePanel(null)} onCloseModelPicker={() => setShowModelPicker(false)}
      onActivatePreviewTab={(tabId) => dispatch({ type: 'ACTIVATE_PREVIEW_TAB', payload: tabId })}
      onClosePreviewTab={(tabId) => dispatch({ type: 'CLOSE_PREVIEW_TAB', payload: tabId })}
      onClosePreview={() => setWorkbenchOpen(false)} onCloseWorkbench={() => setWorkbenchOpen(false)}
      onDirectoryReject={directory.cancelDirectoryApproval} onDismissResume={handleDismissResume}
      onExpandCompaction={handleExpandCompaction} onFileChange={handleFileChange}
      onGoalsChange={(todos) => persistSlashGoals(dispatch, stateRef.current.activeSessionId, todos, getSlashActionCopy(lang).goals[0])}
      onInlineContext={() => { setSlashInlinePanel(null); setShowContextUsage(true); setShowContextPanel(true) }}
      onInlineTasks={() => { setSlashInlinePanel(null); navigate('/tasks') }} onKeyDown={handleKeyDown}
      onManageMcp={() => { setSlashInlinePanel(null); navigate('/mcp') }} onManageModels={handleManageModels}
      onModelChange={setModelForActiveSession} onModelRetry={retryModels} onNavigatePermissions={() => navigate('/permissions')}
      editingMessageId={messageEdit?.sourceMessageId || ''} onCancelMessageEdit={handleCancelMessageEdit}
      onEditMessage={handleEditMessage}
      onRetryModelFailure={handleRetryModelFailure}
      onOpenArtifact={(artifact) => { setWorkbenchOpen(true); dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: artifact ? { ...artifact } : null }) }}
      onOpenInPreview={(msg, preview) => { setWorkbenchOpen(true); dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: { messageId: msg.id, content: msg.meta?.artifactSource || msg.content, preview } }) }}
      onOpenModelPicker={() => setShowModelPicker(true)} onPermAllow={handlePermAllow}
      onPermDeny={() => { dispatch({ type: 'SET_PERM_REQUEST', payload: null }); dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionDenied') }) }}
      onPreviewMessage={setWorkbenchMessage} onQuoteSelection={(text) => { const quoted = String(text || '').split('\n').map((line) => `> ${line}`).join('\n'); const current = inputRef.current || ''; dispatch({ type: 'SET_DRAFT_INPUT', payload: current ? `${quoted}\n\n${current}` : `${quoted}\n\n` }) }}
      onResume={handleResume}
      onSend={handleSend} onSlashCommandSelect={executeSlashEntry}
      onSubmitFeedback={(value) => recordChatFeedback(value, stateRef.current.activeSessionId)}
      onToolApproval={approvals.resolveToolApproval} onVoiceClick={handleVoice} onWorkbenchSend={handleWorkbenchSend}
      onWorkbenchTabChange={setWorkbenchTab} onWorkbenchToggle={() => setWorkbenchOpen((open) => !open)}
      previewArtifact={state.previewArtifact} previewTabs={state.previewTabs} previewActiveId={state.previewActiveId}
      resumeAvailable={resumeAvailable}
      runtimeSkillIds={runtimeSkills.filter((skill) => skill.runnable !== false).map((skill) => skill.id)}
      selectedModel={effectiveSelectedModel} selectedModelProviderId={effectiveSelectedModelProviderId}
      selectedWorkspacePath={selectedWorkspacePath} recentWorkspaces={recentWorkspaces}
      setAttachments={setAttachments} setInput={setInput}
      setShowContextPanel={setShowContextPanel} showContextPanel={showContextPanel} showContextUsage={showContextUsage}
      showModelPicker={showModelPicker} slashCommands={slashCommands} slashInlinePanel={slashInlinePanel}
      workspaceBusy={workspaceBusy} workspaceError={workspaceError}
      state={state} t={t} tasks={state.tasks} toolApproval={approvals.toolApproval} voiceState={voiceState}
      workbenchMessage={workbenchMessage} workbenchOpen={workbenchOpen} workbenchTab={workbenchTab}
    />
  )
}

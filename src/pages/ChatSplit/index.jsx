import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '../../lib/router.jsx'
import { useAppContext } from '../../store/AppContext'
import { describeAttachmentPrompt } from '../../lib/attachments.js'
import { SERVER_TURN_TOOL_TOGGLE_NAMES } from '../../lib/serverToolConfig.js'
import {
  buildServerToolCatalogFallback,
  fetchServerToolCatalog,
  selectEnabledServerToolSpecs,
} from '../../lib/serverToolCatalog.js'
import {
  readStoredModelSelection,
  resolveSessionModelSelection,
  writeStoredModelSelection,
} from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { SETTINGS_TAB_MODELS, settingsPathForSection } from '../../lib/settingsNavigation.js'
import { useActiveAgent } from '../../agents/activeAgentContext.js'
import { parseSlashCommandInput } from '../../lib/slashCommandRegistry.js'
import { getSlashActionCopy } from '../../lib/slashCoreCommands.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import { persistSlashGoals } from '../../lib/slashGoals.js'
import { recordChatFeedback } from '../../lib/evolutionClient.js'
import { fetchCompactionArchive } from '../../lib/compactionClient.js'
import { resolveModelContextWindow } from '../../lib/contextUsage.js'
import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE } from '../../lib/chatAttachmentParser.js'
import { attachmentSendState, createPendingChatAttachment, prepareChatAttachment } from '../../lib/chatAttachmentUpload.js'
import { authorizeChatDirectoryRequest } from '../../lib/chatDirectoryRequest.js'
import { readContextUsageVisible, readDesktopPetVisible, readWorkbenchOpen } from '../../lib/chatUiPreferences.js'
import { useToast } from '../../components/Toast.jsx'
import { useT } from '../../i18n/I18nProvider.jsx'
import ChatSplitView from './ChatSplitView.jsx'
import useInputHistory from './useInputHistory.js'
import useChatApprovals from './useChatApprovals.js'
import useDirectoryApproval from './useDirectoryApproval.js'
import useServerTurnResume from './useServerTurnResume.js'
import useVoiceRecognition from './useVoiceRecognition.js'
import useChatRuntimeCatalog from './useChatRuntimeCatalog.js'
import useChatSessionLifecycle from './useChatSessionLifecycle.js'
import useChatSendFlow from './useChatSendFlow.js'
import useTurnSteering from './useTurnSteering.js'
import useSlashCommandExecution from './useSlashCommandExecution.js'
import { cancelTurnRun } from './turnRunRegistry.js'
import { buildServerTurnResumeMeta, isResumeNudge, resolvePendingDirectorySend } from './pausedTurnResume.js'
import { modelReadinessMessageKey, resolveChatModelReadiness } from './chatModelReadiness.js'
import useManualRecoveryRouteResume from './useManualRecoveryRouteResume.js'
import { buildModelFailureRetryRequest } from './modelFailureRetry.js'
import { readSessionDraft } from '../../lib/chatDrafts.js'
import { createChatSessionId } from './chatSessionId.js'
import {
  buildStreamResumeState,
  buildStreamResumeStateFromMessages,
  getStreamResumeStateForSession,
  isStreamResumeStateForSession,
  updateStreamResumeStates,
  updateStreamResumeStatesFromTurnResult,
} from './streamResumeState.js'

const EMPTY_MESSAGES = []
const CHAT_MODEL_SETTINGS_PATH = settingsPathForSection(SETTINGS_TAB_MODELS, [], { returnTo: '/chat' })

export default function ChatSplit() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
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
  const [contextSystemPrompts, setContextSystemPrompts] = useState({})
  const [resumeStates, setResumeStates] = useState({})
  const [failedTurnRetry, setFailedTurnRetry] = useState(null)
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
  const resumeState = getStreamResumeStateForSession(resumeStates, activeSessionId)
  const latestServerAssistant = [...messages].reverse().find((message) => message?.role === 'assistant' && message?.meta?.serverTurnId)
  const serverResumeSignal = [
    activeSessionId || '',
    latestServerAssistant?.id || '',
    latestServerAssistant?.meta?.serverTurnId || '',
    latestServerAssistant?.meta?.streaming ? 'streaming' : 'idle',
    latestServerAssistant?.meta?.serverConnectionState || '',
    latestServerAssistant?.meta?.serverLastSequence ?? '',
    latestServerAssistant?.meta?.serverResumeResolution ? 'resolution' : '',
  ].join(':')
  const navigateInputHistory = useInputHistory({
    messages,
    input,
    setInput,
    sessionId: activeSessionId,
    enabled: state.inputHistoryNavigationEnabled !== false,
  })
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
  const modelReadiness = resolveChatModelReadiness({
    catalogState: modelCatalogState,
    modelName: effectiveSelectedModel,
    modelProviderId: effectiveSelectedModelProviderId,
    modelOptions,
  })
  const selectedContextWindow = resolveModelContextWindow(
    modelOptions,
    effectiveSelectedModel,
    undefined,
    effectiveSelectedModelProviderId,
  )
  const approvals = useChatApprovals({ setWorkbenchMessage, toast, t })
  const directory = useDirectoryApproval({ lang, t, toast })
  const { handleVoice, voiceState } = useVoiceRecognition({ dispatch, input, lang, permissions: state.permissions, setInput, setMessage: setWorkbenchMessage, t })
  const { abortSessionIdRef, inputRef } = useChatSessionLifecycle({
    abortCtrlRef, attachments, desktopPetVisible, dispatch, input, isGenerating, messages, preserveAttachmentsForSessionRef, setAttachments, setDesktopPetVisible,
    setInput, setIsGenerating, setWorkbenchMessage, showContextUsage, state, toolApproval: approvals.toolApproval,
    workbenchOpen,
  })
  const showModelUnavailable = (readiness = modelReadiness) => {
    const messageKey = modelReadinessMessageKey(readiness)
    if (messageKey) setWorkbenchMessage(t(messageKey))
    setShowModelPicker(true)
  }
  const handleTurnStart = useCallback(({ sessionId }) => {
    setResumeStates((current) => updateStreamResumeStates(current, sessionId, null))
  }, [])
  const handleTurnResult = useCallback(({ sessionId, turnId, result }) => {
    const nextResumeState = buildStreamResumeState(result, { sessionId, turnId })
    setResumeStates((current) => updateStreamResumeStates(current, sessionId, nextResumeState))
  }, [])
  const triggerSendFlow = useChatSendFlow({
    abortCtrlRef, abortSessionIdRef, attachments,
    approvalMode: approvals.approvalSettings?.mode || 'normal',
    changeApprovalMode: approvals.changeApprovalMode,
    directoryApprovalResolveRef: directory.directoryApprovalResolveRef,
    dispatch, effectiveAgentId, ensureLocalPathAccess: directory.ensureLocalPathAccess, isGenerating, modelOptions, modelReadiness,
    onModelUnavailable: showModelUnavailable, onTurnResult: handleTurnResult, onTurnStart: handleTurnStart,
    probeLocalPathAccess: directory.probeLocalPathAccess, requestServerToolApproval: approvals.requestServerToolApproval,
    resolveToolApprovalForOwner: approvals.resolveToolApprovalForOwner, runtimeSkills, selectedModel,
    selectedModelProviderId, setContextSystemPrompts,
    clearToolApprovalForOwner: approvals.clearToolApprovalForOwner, state, t,
  })
  const handleWorkbenchSend = (content) => {
    if (!modelReadiness.canSend) {
      showModelUnavailable(modelReadiness)
      return false
    }
    triggerSendFlow(content)
    return true
  }
  const showPendingDirectoryGuidance = useCallback((content = '') => {
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const pending = resolvePendingDirectorySend(session?.messages)
    if (!pending) return false
    setWorkbenchMessage(t(pending.state === 'resuming'
      ? 'chatSteering.directoryResumePending'
      : 'chatSteering.directoryAuthorizationRequired'))
    if (isResumeNudge(content)) {
      setInput('')
      dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: current.activeSessionId, text: '' } })
    }
    window.requestAnimationFrame?.(() => {
      const row = document.getElementById(`message-${pending.message.id}`)
      row?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      row?.querySelector?.('[data-testid="directory-request-card"] input')?.focus?.()
    })
    return true
  }, [dispatch, t])
  const handleAuthorizeDirectoryRequest = useCallback(async ({
    message,
    path,
    accessMode,
    authorizationScope,
  }) => {
    const sessionId = stateRef.current.activeSessionId
    const turnId = message?.meta?.serverTurnId
    const clarification = message?.meta?.serverClarification || {}
    const result = await authorizeChatDirectoryRequest({
      sessionId,
      turnId,
      pausedSequence: message?.meta?.serverLastSequence,
      path,
      accessMode,
      scope: authorizationScope,
      purpose: clarification.purpose || clarification.why || '',
    })
    dispatch({
      type: 'UPDATE_LAST_MESSAGE_META',
      sessionId,
      messageId: message.id,
      payload: buildServerTurnResumeMeta(result.resolution),
    })
    toast.success({ title: t('taskSteering.directoryGranted'), body: result.path })
    return result
  }, [dispatch, t, toast])
  const steerActiveTurn = useTurnSteering({
    dispatch, inputRef, setInput, setWorkbenchMessage, stateRef, t,
  })
  const { manualRecoveryResume, onManualRecoveryConsumed } = useManualRecoveryRouteResume()
  const onFailedTurnRetryConsumed = useCallback((consumed) => {
    setFailedTurnRetry((current) => (
      current?.sessionId === consumed?.sessionId && current?.turnId === consumed?.turnId
        ? null
        : current
    ))
  }, [])
  const onFailedTurnRetrySettled = useCallback((outcome) => {
    setResumeStates((current) => updateStreamResumeStatesFromTurnResult(current, outcome))
  }, [])
  useServerTurnResume({
    abortCtrlRef, dispatch, requestServerToolApproval: approvals.requestServerToolApproval,
    resolveToolApprovalForOwner: approvals.resolveToolApprovalForOwner, resumingTurnIdsRef,
    clearToolApprovalForOwner: approvals.clearToolApprovalForOwner, stateActiveSessionId: state.activeSessionId,
    stateResumeSignal: serverResumeSignal, stateTurnRunActive: isGenerating, stateRef, t,
    manualRecoveryResume, onManualRecoveryConsumed,
    failedTurnRetry, onFailedTurnRetryConsumed, onFailedTurnRetrySettled,
  })
  useEffect(() => {
    if (!activeSessionId) return
    const rebuilt = buildStreamResumeStateFromMessages(messages, { sessionId: activeSessionId })
    const retryPending = rebuilt && (
      failedTurnRetry?.sessionId === rebuilt.sessionId
      && failedTurnRetry?.turnId === rebuilt.turnId
      || resumingTurnIdsRef.current.has(`${rebuilt.sessionId}\u0000${rebuilt.turnId}`)
    )
    setResumeStates((current) => updateStreamResumeStates(
      current,
      activeSessionId,
      retryPending ? null : rebuilt,
    ))
  }, [activeSessionId, failedTurnRetry, messages])
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
    setSelectedModel(normalized, normalizedProviderId)
    writeStoredModelSelection({ modelName: normalized, providerId: normalizedProviderId })
    if (activeSessionId) {
      dispatch({
        type: 'SET_SESSION_MODEL',
        payload: { sessionId: activeSessionId, modelName: normalized, modelProviderId: normalizedProviderId || null },
      })
    }
  }
  const handleSend = async () => {
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    if (showPendingDirectoryGuidance(typedContent)) return
    if (isGenerating) {
      if (!typedContent) {
        setWorkbenchMessage(t('chatSteering.textOnly'))
        return
      }
      await steerActiveTurn(typedContent)
      return
    }
    if (directory.directoryApproval.open) return
    const attachmentState = attachmentSendState(attachments)
    if (attachmentState.uploading) {
      setWorkbenchMessage(t('chatAttachments.waitingForUploads'))
      return
    }
    if (attachmentState.failed) {
      setWorkbenchMessage(t('chatAttachments.removeFailed'))
      return
    }
    const parsedSlash = parseSlashCommandInput(typedContent)
    const slashEntry = parsedSlash ? slashRegistry.getCommand(parsedSlash.name) : null
    if (slashEntry && slashEntry.kind !== 'skill') {
      if (slashEntry.requiresModel && !modelReadiness.canSend) {
        showModelUnavailable(modelReadiness)
        return
      }
      setInput('')
      executeSlashEntry(slashEntry, parsedSlash.args)
      return
    }
    if (!modelReadiness.canSend) {
      showModelUnavailable(modelReadiness)
      return
    }
    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    if (state.activeSessionId) dispatch({
      type: 'SET_SESSION_DRAFT',
      payload: { sessionId: state.activeSessionId, text: '', attachments: [] },
    })
    triggerSendFlow(typedContent || describeAttachmentPrompt(currentAttachments), currentAttachments)
  }
  const handleAbort = useCallback(() => {
    if (activeSessionId) {
      setResumeStates((current) => updateStreamResumeStates(current, activeSessionId, null))
      setFailedTurnRetry((current) => current?.sessionId === activeSessionId ? null : current)
    }
    if (!cancelTurnRun(activeSessionId)) abortCtrlRef.current?.abort()
  }, [activeSessionId])
  const handleRetryModelFailure = (failedMessage) => {
    if (isGenerating) return false
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const request = buildModelFailureRetryRequest(session?.messages, failedMessage)
    if (!request) return false
    if (!modelReadiness.canSend) {
      showModelUnavailable(modelReadiness)
      return false
    }
    setShowModelPicker(false)
    triggerSendFlow(
      request.content || describeAttachmentPrompt(request.attachments),
      request.attachments,
      request.historyLimit,
    )
    return true
  }
  useEffect(() => {
    const handler = (event) => {
      const { choiceId, choiceTitle } = event.detail || {}
      if (choiceId && choiceTitle) triggerSendFlow(`[[choice:${choiceId}]] ${choiceTitle}`)
    }
    window.addEventListener('choice-selected', handler)
    return () => window.removeEventListener('choice-selected', handler)
  }, [triggerSendFlow])
  const handleKeyDown = (event) => {
    if (navigateInputHistory(event)) return
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSend() }
  }
  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    const available = Math.max(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE - attachments.length)
    const accepted = files.slice(0, available)
    if (!accepted.length) {
      setWorkbenchMessage(t('chatAttachments.maxCountNotice', { count: files.length }))
      return
    }
    let targetSessionId = state.activeSessionId
    if (!targetSessionId) {
      targetSessionId = createChatSessionId()
      preserveAttachmentsForSessionRef.current = targetSessionId
      dispatch({
        type: 'NEW_SESSION',
        payload: { id: targetSessionId, title: t('chatReliability.newConversation'), agentId: effectiveAgentId || null },
      })
    }
    const pending = accepted.map(createPendingChatAttachment)
    setAttachments((current) => [...current, ...pending].slice(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE))
    setWorkbenchMessage(t('chatAttachments.uploading'))
    const parserMessages = Object.fromEntries(['imageLimit', 'imageTooLarge', 'compressedTooLarge', 'excelTooLong', 'wordTooLong', 'pptTooLong', 'textTooLong', 'unsupportedFormat', 'readFailed'].map((key) => [key, t(`chatAttachments.${key}`)]))
    const existingImageCount = attachments.filter((item) => item.kind === 'image').length
    const prepared = await Promise.all(accepted.map(async (file, index) => ({
      pendingId: pending[index].id,
      result: await prepareChatAttachment(file, pending[index], {
        sessionId: targetSessionId,
        parserOptions: {
          existingImageCount: existingImageCount + accepted.slice(0, index).filter((item) => item.type.startsWith('image/')).length,
          messages: parserMessages,
        },
      }),
    })))
    const byPendingId = new Map(prepared.map((item) => [item.pendingId, item.result]))
    setAttachments((current) => current.map((item) => byPendingId.get(item.id) || item))
    const failed = prepared.filter((item) => item.result.uploadStatus === 'error').length
    if (failed) setWorkbenchMessage(t('chatAttachments.uploadFailedCount', { count: failed }))
    else if (files.length > accepted.length) setWorkbenchMessage(t('chatAttachments.maxCountNotice', { count: files.length - accepted.length }))
    else setWorkbenchMessage(t('chatAttachments.addedNotice', { count: prepared.length }))
  }
  const handleExpandCompaction = async (archiveId) => {
    if (!archiveId) return
    try {
      const archive = await fetchCompactionArchive(archiveId)
      dispatch({ type: 'EXPAND_COMPACTED', payload: { sessionId: state.activeSessionId, archiveId, archivedMessages: archive.archivedMessages || [] } })
      setWorkbenchMessage(`Restored ${archive.replacedMessageCount || 0} archived messages.`)
    } catch (error) { setWorkbenchMessage(error.message || 'Failed to restore compacted context.') }
  }
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
      directoryApproval={directory.directoryApproval} input={input} isGenerating={isGenerating} messages={messages}
      modelOptions={modelOptions} modelReadiness={modelReadiness} onAbort={handleAbort} onApprovalModeChange={approvals.changeApprovalMode}
      onAuthorizeDirectoryRequest={handleAuthorizeDirectoryRequest}
      onAuthorizeDirectory={directory.authorizeDirectory} onCloseDesktopPet={() => setDesktopPetVisible(false)}
      onCloseInlinePanel={() => setSlashInlinePanel(null)} onCloseModelPicker={() => setShowModelPicker(false)}
      onActivatePreviewTab={(tabId) => dispatch({ type: 'ACTIVATE_PREVIEW_TAB', payload: tabId })}
      onClosePreviewTab={(tabId) => dispatch({ type: 'CLOSE_PREVIEW_TAB', payload: tabId })}
      onClosePreview={() => setWorkbenchOpen(false)} onCloseWorkbench={() => setWorkbenchOpen(false)}
      onDirectoryReject={directory.cancelDirectoryApproval} onDismissResume={() => {
        if (activeSessionId) {
          setResumeStates((current) => updateStreamResumeStates(current, activeSessionId, null))
        }
      }}
      onExpandCompaction={handleExpandCompaction} onFileChange={handleFileChange}
      onGoalsChange={(todos) => persistSlashGoals(dispatch, stateRef.current.activeSessionId, todos, getSlashActionCopy(lang).goals[0])}
      onInlineContext={() => { setSlashInlinePanel(null); setShowContextUsage(true); setShowContextPanel(true) }}
      onInlineTasks={() => { setSlashInlinePanel(null); navigate('/tasks') }} onKeyDown={handleKeyDown}
      onManageMcp={() => { setSlashInlinePanel(null); navigate('/mcp') }} onManageModels={handleManageModels}
      onModelChange={setModelForActiveSession} onModelRetry={reloadModels} onNavigatePermissions={() => navigate('/permissions')}
      onRetryModelFailure={handleRetryModelFailure}
      onOpenArtifact={(artifact) => { setWorkbenchOpen(true); dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: artifact ? { ...artifact } : null }) }}
      onOpenInPreview={(msg, preview) => { setWorkbenchOpen(true); dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: { messageId: msg.id, content: msg.meta?.artifactSource || msg.content, preview } }) }}
      onOpenModelPicker={() => setShowModelPicker(true)} onPermAllow={handlePermAllow}
      onPermDeny={() => { dispatch({ type: 'SET_PERM_REQUEST', payload: null }); dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionDenied') }) }}
      onPreviewMessage={setWorkbenchMessage} onQuoteSelection={(text) => { const quoted = String(text || '').split('\n').map((line) => `> ${line}`).join('\n'); const current = inputRef.current || ''; dispatch({ type: 'SET_DRAFT_INPUT', payload: current ? `${quoted}\n\n${current}` : `${quoted}\n\n` }) }}
      onResume={() => {
        if (!isStreamResumeStateForSession(resumeState, activeSessionId)) return
        if (resumeState.code !== 'TURN_INCOMPLETE') return
        setResumeStates((current) => updateStreamResumeStates(current, activeSessionId, null))
        setFailedTurnRetry(resumeState)
      }}
      onSend={handleSend} onSlashCommandSelect={executeSlashEntry}
      onSubmitFeedback={(value) => recordChatFeedback(value, stateRef.current.activeSessionId)}
      onToolApproval={approvals.resolveToolApproval} onVoiceClick={handleVoice} onWorkbenchSend={handleWorkbenchSend}
      onWorkbenchTabChange={setWorkbenchTab} onWorkbenchToggle={() => setWorkbenchOpen((open) => !open)}
      previewArtifact={state.previewArtifact} previewTabs={state.previewTabs} previewActiveId={state.previewActiveId}
      resumeAvailable={isStreamResumeStateForSession(resumeState, activeSessionId)
        && resumeState.code === 'TURN_INCOMPLETE'}
      runtimeSkillIds={runtimeSkills.filter((skill) => skill.runnable !== false).map((skill) => skill.id)}
      selectedModel={effectiveSelectedModel} selectedModelProviderId={effectiveSelectedModelProviderId}
      setAttachments={setAttachments} setInput={setInput}
      setShowContextPanel={setShowContextPanel} showContextPanel={showContextPanel} showContextUsage={showContextUsage}
      showModelPicker={showModelPicker} slashCommands={slashCommands} slashInlinePanel={slashInlinePanel}
      state={state} t={t} tasks={state.tasks} toolApproval={approvals.toolApproval} voiceState={voiceState}
      workbenchMessage={workbenchMessage} workbenchOpen={workbenchOpen} workbenchTab={workbenchTab}
    />
  )
}

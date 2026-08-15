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
import { readStoredModel, resolveSessionModel, writeStoredModel } from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { useActiveAgent } from '../../agents/activeAgentContext.js'
import { parseSlashCommandInput } from '../../lib/slashCommandRegistry.js'
import { getSlashActionCopy } from '../../lib/slashCoreCommands.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import { persistSlashGoals } from '../../lib/slashGoals.js'
import { recordLocalChatFeedback } from '../../lib/localChatFeedback.js'
import { fetchCompactionArchive } from '../../lib/compactionClient.js'
import { resolveModelContextWindow } from '../../lib/contextUsage.js'
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

const EMPTY_MESSAGES = []

export default function ChatSplit() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const toast = useToast()
  const { t, lang } = useT()
  const { activeAgentId: globalActiveAgentId } = useActiveAgent()
  const [input, setInput] = useState('')
  const [workbenchMessage, setWorkbenchMessage] = useState('')
  const [attachments, setAttachments] = useState([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [showContextUsage, setShowContextUsage] = useState(readContextUsageVisible)
  const [workbenchOpen, setWorkbenchOpen] = useState(readWorkbenchOpen)
  const [workbenchTab, setWorkbenchTab] = useState('files')
  const [desktopPetVisible, setDesktopPetVisible] = useState(readDesktopPetVisible)
  const [slashInlinePanel, setSlashInlinePanel] = useState(null)
  const [showContextPanel, setShowContextPanel] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [contextSystemPrompts, setContextSystemPrompts] = useState({})
  const [resumeState, setResumeState] = useState(null)
  const abortCtrlRef = useRef(null)
  const resumingTurnIdsRef = useRef(new Set())
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => {
    if (!workbenchMessage) return undefined
    const timer = setTimeout(() => setWorkbenchMessage(''), 5000)
    return () => clearTimeout(timer)
  }, [workbenchMessage])

  const { modelOptions, runtimeSkills, selectedModel, setSelectedModel, slashRegistry } = useChatRuntimeCatalog({ lang, skillConfigs: state.skillConfigs, t })
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId)
  const activeSessionId = activeSession?.id || null
  const effectiveAgentId = activeSession?.agentId || globalActiveAgentId || null
  const messages = activeSession?.messages ?? EMPTY_MESSAGES
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
  const navigateInputHistory = useInputHistory({ messages, input, setInput, sessionId: activeSessionId })
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
  const effectiveSelectedModel = resolveSessionModel(modelOptions, {
    sessionModel: activeSession?.modelName,
    selectedModel,
    storedModel: readStoredModel(),
  }) || activeSession?.modelName || selectedModel || readStoredModel()
  const selectedContextWindow = resolveModelContextWindow(modelOptions, effectiveSelectedModel)
  const approvals = useChatApprovals({ setWorkbenchMessage, toast, t })
  const directory = useDirectoryApproval({ lang, t, toast })
  const { handleVoice, voiceState } = useVoiceRecognition({ dispatch, input, lang, permissions: state.permissions, setInput, setMessage: setWorkbenchMessage, t })
  const { abortSessionIdRef, inputRef } = useChatSessionLifecycle({
    abortCtrlRef, desktopPetVisible, dispatch, input, isGenerating, messages, setAttachments, setDesktopPetVisible,
    setInput, setIsGenerating, setWorkbenchMessage, showContextUsage, state, toolApproval: approvals.toolApproval,
    workbenchOpen,
  })
  const triggerSendFlow = useChatSendFlow({
    abortCtrlRef, abortSessionIdRef, attachments, directoryApprovalResolveRef: directory.directoryApprovalResolveRef,
    dispatch, effectiveAgentId, ensureLocalPathAccess: directory.ensureLocalPathAccess, isGenerating, modelOptions,
    probeLocalPathAccess: directory.probeLocalPathAccess, requestServerToolApproval: approvals.requestServerToolApproval,
    resolveToolApprovalForOwner: approvals.resolveToolApprovalForOwner, runtimeSkills, selectedModel, setContextSystemPrompts,
    clearToolApprovalForOwner: approvals.clearToolApprovalForOwner, state, t, toast,
  })
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
    usePicker = false,
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
      usePicker,
      purpose: clarification.purpose || clarification.why || '',
    })
    if (result.cancelled) {
      toast.info({ title: t('taskSteering.directoryPickerCancelled') })
      return result
    }
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
  useServerTurnResume({
    abortCtrlRef, dispatch, requestServerToolApproval: approvals.requestServerToolApproval,
    resolveToolApprovalForOwner: approvals.resolveToolApprovalForOwner, resumingTurnIdsRef,
    clearToolApprovalForOwner: approvals.clearToolApprovalForOwner, stateActiveSessionId: state.activeSessionId,
    stateResumeSignal: serverResumeSignal, stateTurnRunActive: isGenerating, stateRef, t,
  })
  const executeSlashEntry = useSlashCommandExecution({
    changeApprovalMode: approvals.changeApprovalMode, dispatch, modelName: effectiveSelectedModel, navigate, setDesktopPetVisible, setInput,
    setSlashInlinePanel, setWorkbenchMessage, setWorkbenchOpen, setWorkbenchTab, slashRegistry, stateRef, triggerSendFlow,
  })
  const slashQuery = input.match(/^\/([^\s/]*)$/i)?.[1]
  const slashCommands = slashQuery === undefined ? [] : slashRegistry.listCommands({ query: slashQuery })

  const setModelForActiveSession = useCallback((modelName) => {
    const normalized = String(modelName || '').trim()
    if (!normalized) return
    setSelectedModel(normalized)
    writeStoredModel(normalized)
    if (activeSessionId) dispatch({ type: 'SET_SESSION_MODEL', payload: { sessionId: activeSessionId, modelName: normalized } })
  }, [activeSessionId, dispatch, setSelectedModel])
  const handleSend = useCallback(async () => {
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
    if (slashEntry && slashEntry.kind !== 'skill') { setInput(''); executeSlashEntry(slashEntry, parsedSlash.args); return }
    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    if (state.activeSessionId) dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: state.activeSessionId, text: '' } })
    triggerSendFlow(typedContent || describeAttachmentPrompt(currentAttachments), currentAttachments)
  }, [attachments, directory.directoryApproval.open, dispatch, executeSlashEntry, input, isGenerating, showPendingDirectoryGuidance, slashRegistry, state.activeSessionId, steerActiveTurn, t, triggerSendFlow])
  const handleAbort = useCallback(() => {
    if (!cancelTurnRun(activeSessionId)) abortCtrlRef.current?.abort()
  }, [activeSessionId])
  useEffect(() => {
    const handler = (event) => {
      const { choiceId, choiceTitle } = event.detail || {}
      if (choiceId && choiceTitle) triggerSendFlow(`[[choice:${choiceId}]] ${choiceTitle}`)
    }
    window.addEventListener('choice-selected', handler)
    return () => window.removeEventListener('choice-selected', handler)
  }, [triggerSendFlow])
  const handleKeyDown = useCallback((event) => {
    if (navigateInputHistory(event)) return
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSend() }
  }, [handleSend, navigateInputHistory])
  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    const available = Math.max(0, 8 - attachments.length)
    const accepted = files.slice(0, available)
    if (!accepted.length) {
      setWorkbenchMessage(t('chatAttachments.maxCountNotice', { count: files.length }))
      return
    }
    let targetSessionId = state.activeSessionId
    if (!targetSessionId) {
      targetSessionId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      dispatch({
        type: 'NEW_SESSION',
        payload: { id: targetSessionId, title: t('chatReliability.newConversation'), agentId: effectiveAgentId || null },
      })
    }
    const pending = accepted.map(createPendingChatAttachment)
    setAttachments((current) => [...current, ...pending].slice(0, 8))
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
    if (isLoggedInLocally()) { navigate('/settings?tab=models'); return }
    window.dispatchEvent(new CustomEvent('auth:required', { detail: { path: '/settings?tab=models', message: t('chatReliability.signInForModels') } }))
  }

  return (
    <ChatSplitView
      activeSession={activeSession} activeSessionId={activeSessionId} approvalMode={approvals.approvalSettings?.mode || 'normal'}
      attachments={attachments} contextSystemPrompt={contextSystemPrompts[state.activeSessionId || '__draft__'] || ''}
      contextToolSpecs={contextToolSpecs} contextWindow={selectedContextWindow} desktopPetVisible={desktopPetVisible}
      directoryApproval={directory.directoryApproval} input={input} isGenerating={isGenerating} messages={messages}
      modelOptions={modelOptions} onAbort={handleAbort} onApprovalModeChange={approvals.changeApprovalMode}
      onAuthorizeDirectoryRequest={handleAuthorizeDirectoryRequest}
      onAuthorizeDirectory={directory.authorizeDirectory} onCloseDesktopPet={() => setDesktopPetVisible(false)}
      onCloseInlinePanel={() => setSlashInlinePanel(null)} onCloseModelPicker={() => setShowModelPicker(false)}
      onClosePreview={() => dispatch({ type: 'CLOSE_PREVIEW_ARTIFACT' })} onCloseWorkbench={() => setWorkbenchOpen(false)}
      onDirectoryReject={() => directory.resolveDirectoryApproval({ approved: false })} onDismissResume={() => setResumeState(null)}
      onExpandCompaction={handleExpandCompaction} onFileChange={handleFileChange}
      onGoalsChange={(todos) => persistSlashGoals(dispatch, stateRef.current.activeSessionId, todos, getSlashActionCopy(lang).goals[0])}
      onInlineContext={() => { setSlashInlinePanel(null); setShowContextUsage(true); setShowContextPanel(true) }}
      onInlineTasks={() => { setSlashInlinePanel(null); navigate('/tasks') }} onKeyDown={handleKeyDown}
      onManageMcp={() => { setSlashInlinePanel(null); navigate('/mcp') }} onManageModels={handleManageModels}
      onModelChange={setModelForActiveSession} onNavigatePermissions={() => navigate('/permissions')}
      onOpenArtifact={(artifact) => { setWorkbenchOpen(false); dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: artifact ? { ...artifact } : null }) }}
      onOpenInPreview={(msg, preview) => { setWorkbenchOpen(false); dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: { messageId: msg.id, content: msg.meta?.artifactSource || msg.content, preview } }) }}
      onOpenModelPicker={() => setShowModelPicker(true)} onPermAllow={handlePermAllow}
      onPermDeny={() => { dispatch({ type: 'SET_PERM_REQUEST', payload: null }); dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionDenied') }) }}
      onPreviewMessage={setWorkbenchMessage} onQuoteSelection={(text) => { const quoted = String(text || '').split('\n').map((line) => `> ${line}`).join('\n'); const current = inputRef.current || ''; dispatch({ type: 'SET_DRAFT_INPUT', payload: current ? `${quoted}\n\n${current}` : `${quoted}\n\n` }) }}
      onResume={() => {
        if (!resumeState) return
        const prompt = t('chatReliability.continuePrompt')
        if (showPendingDirectoryGuidance(prompt)) return
        setResumeState(null)
        triggerSendFlow(prompt)
      }}
      onSend={handleSend} onSlashCommandSelect={executeSlashEntry}
      onSubmitFeedback={(value) => recordLocalChatFeedback(value, stateRef.current.activeSessionId)}
      onToolApproval={approvals.resolveToolApproval} onVoiceClick={handleVoice} onWorkbenchSend={triggerSendFlow}
      onWorkbenchTabChange={setWorkbenchTab} onWorkbenchToggle={() => setWorkbenchOpen((open) => !open)}
      previewArtifact={state.previewArtifact} resumeAvailable={!!resumeState}
      runtimeSkillIds={runtimeSkills.filter((skill) => skill.runnable !== false).map((skill) => skill.id)}
      selectedModel={effectiveSelectedModel} setAttachments={setAttachments} setInput={setInput}
      setShowContextPanel={setShowContextPanel} showContextPanel={showContextPanel} showContextUsage={showContextUsage}
      showModelPicker={showModelPicker} slashCommands={slashCommands} slashInlinePanel={slashInlinePanel}
      state={state} t={t} tasks={state.tasks} toolApproval={approvals.toolApproval} voiceState={voiceState}
      workbenchMessage={workbenchMessage} workbenchOpen={workbenchOpen} workbenchTab={workbenchTab}
    />
  )
}

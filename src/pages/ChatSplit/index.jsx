import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '../../lib/router.jsx'
import { useAppContext } from '../../store/AppContext'
import { describeAttachmentPrompt } from '../../lib/attachments.js'
import { buildToolSpecs } from '../../lib/tools/index.js'
import { SERVER_TURN_TOOL_TOGGLE_NAMES } from '../../lib/serverToolConfig.js'
import { readStoredModel, resolveSessionModel, writeStoredModel } from '../../lib/modelSelection.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { useActiveAgent } from '../../agents/activeAgentContext.js'
import { parseSlashCommandInput } from '../../lib/slashCommandRegistry.js'
import { getSlashActionCopy } from '../../lib/slashCoreCommands.js'
import { TASK_STATUS } from '../../store/taskStatus.js'
import { persistSlashGoals } from '../../lib/slashGoals.js'
import { recordLocalChatFeedback } from '../../lib/localChatFeedback.js'
import { fetchCompactionArchive } from '../../lib/compactionClient.js'
import { parseChatAttachments } from '../../lib/chatAttachmentParser.js'
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
import useSlashCommandExecution from './useSlashCommandExecution.js'

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
  const navigateInputHistory = useInputHistory({ messages, input, setInput, sessionId: activeSessionId })
  const contextToolSpecs = useMemo(() => {
    try { return buildToolSpecs(SERVER_TURN_TOOL_TOGGLE_NAMES.filter((name) => state.toolsConfig?.[name] === true)) }
    catch { return [] }
  }, [state.toolsConfig])
  const effectiveSelectedModel = resolveSessionModel(modelOptions, {
    sessionModel: activeSession?.modelName,
    selectedModel,
    storedModel: readStoredModel(),
  }) || activeSession?.modelName || selectedModel || readStoredModel()
  const selectedContextWindow = modelOptions.find((model) => model.name === effectiveSelectedModel)?.contextWindow || 1_000_000
  const approvals = useChatApprovals({ setWorkbenchMessage, toast, t })
  const directory = useDirectoryApproval({ lang, t, toast })
  const { handleVoice, voiceState } = useVoiceRecognition({ dispatch, input, lang, permissions: state.permissions, setInput, setMessage: setWorkbenchMessage, t })
  const { abortSessionIdRef, inputRef } = useChatSessionLifecycle({
    abortCtrlRef, desktopPetVisible, dispatch, input, isGenerating, messages, setAttachments, setDesktopPetVisible,
    setInput, setWorkbenchMessage, showContextUsage, state, toolApproval: approvals.toolApproval,
    toolApprovalResolveRef: approvals.toolApprovalResolveRef, workbenchOpen,
  })
  const triggerSendFlow = useChatSendFlow({
    abortCtrlRef, abortSessionIdRef, attachments, directoryApprovalResolveRef: directory.directoryApprovalResolveRef,
    dispatch, effectiveAgentId, ensureLocalPathAccess: directory.ensureLocalPathAccess, isGenerating, modelOptions,
    probeLocalPathAccess: directory.probeLocalPathAccess, requestServerToolApproval: approvals.requestServerToolApproval,
    resolveToolApproval: approvals.resolveToolApproval, runtimeSkills, selectedModel, setContextSystemPrompts,
    setIsGenerating, setToolApproval: approvals.setToolApproval, state, t, toast,
    toolApprovalResolveRef: approvals.toolApprovalResolveRef,
  })
  useServerTurnResume({
    abortCtrlRef, dispatch, requestServerToolApproval: approvals.requestServerToolApproval,
    resolveToolApproval: approvals.resolveToolApproval, resumingTurnIdsRef, setIsGenerating,
    setToolApproval: approvals.setToolApproval, stateActiveSessionId: state.activeSessionId, stateRef, t,
    toolApprovalResolveRef: approvals.toolApprovalResolveRef,
  })
  const executeSlashEntry = useSlashCommandExecution({
    changeApprovalMode: approvals.changeApprovalMode, dispatch, navigate, setDesktopPetVisible, setInput,
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
  const handleSend = useCallback(() => {
    if (directory.directoryApproval.open) return
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    const parsedSlash = parseSlashCommandInput(typedContent)
    const slashEntry = parsedSlash ? slashRegistry.getCommand(parsedSlash.name) : null
    if (slashEntry && slashEntry.kind !== 'skill') { setInput(''); executeSlashEntry(slashEntry, parsedSlash.args); return }
    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    if (state.activeSessionId) dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId: state.activeSessionId, text: '' } })
    triggerSendFlow(typedContent || describeAttachmentPrompt(currentAttachments), currentAttachments)
  }, [attachments, directory.directoryApproval.open, dispatch, executeSlashEntry, input, slashRegistry, state.activeSessionId, triggerSendFlow])
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
    const next = await parseChatAttachments(files, {
      existingImageCount: attachments.filter((item) => item.kind === 'image').length,
      messages: Object.fromEntries(['imageLimit', 'imageTooLarge', 'compressedTooLarge', 'excelTooLong', 'wordTooLong', 'pptTooLong', 'textTooLong', 'unsupportedFormat', 'readFailed'].map((key) => [key, t(`chatAttachments.${key}`)])),
    })
    setAttachments((current) => {
      const merged = [...current, ...next]
      setWorkbenchMessage(merged.length > 8 ? t('chatAttachments.maxCountNotice', { count: merged.length - 8 }) : t('chatAttachments.addedNotice', { count: next.length }))
      return merged.slice(0, 8)
    })
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
      modelOptions={modelOptions} onAbort={() => abortCtrlRef.current?.abort()} onApprovalModeChange={approvals.changeApprovalMode}
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
      onOpenArtifact={(artifact) => dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: artifact })}
      onOpenInPreview={(msg, preview) => dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: { messageId: msg.id, content: msg.meta?.artifactSource || msg.content, preview } })}
      onOpenModelPicker={() => setShowModelPicker(true)} onPermAllow={handlePermAllow}
      onPermDeny={() => { dispatch({ type: 'SET_PERM_REQUEST', payload: null }); dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionDenied') }) }}
      onPreviewMessage={setWorkbenchMessage} onQuoteSelection={(text) => { const quoted = String(text || '').split('\n').map((line) => `> ${line}`).join('\n'); const current = inputRef.current || ''; dispatch({ type: 'SET_DRAFT_INPUT', payload: current ? `${quoted}\n\n${current}` : `${quoted}\n\n` }) }}
      onResume={() => { if (resumeState) { setResumeState(null); triggerSendFlow(t('chatReliability.continuePrompt')) } }}
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

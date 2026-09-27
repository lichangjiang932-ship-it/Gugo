import AppLayout from '../../components/AppLayout.jsx'
import DirectoryApprovalModal from '../../components/DirectoryApprovalModal.jsx'
import ToolApprovalCard from '../../components/ToolApprovalCard.jsx'
import PermissionRequestCard from './chatMessages/PermissionRequestCard.jsx'
import ChatComposer from './ChatComposer'
import ChatMessages from './ChatMessages'
import ChatDesktopPetHost from './chatSplitView/ChatDesktopPetHost.jsx'
import ChatRightPanels from './chatSplitView/ChatRightPanels.jsx'
import PlanCard from './chatSplitView/PlanCard.jsx'
import { revealTurnInConversation } from '../../lib/chatMessageSignals.js'
import { ListChecks } from 'lucide-react'
import { ChatSessionHeading, ChatWorkbenchToggle } from './chatSplitView/ChatSessionHeader.jsx'
import SessionChangesReview from './chatSplitView/SessionChangesReview.jsx'
import SlashInlinePanelHost from './SlashInlinePanelHost.jsx'
import ChatNoticeDocks from './chatSplitView/ChatNoticeDocks.jsx'
import { estimateClientContextUsage, sumSessionModelUsage } from '../../lib/contextUsage.js'

export { ChatRightPanels }
export default function ChatSplitView({
  activeSession,
  activeSessionId,
  recoveryOwnerScope,
  onSideEffectResolved,
  approvalMode,
  attachments,
  contextSystemPrompt,
  contextToolSpecs,
  contextWindow,
  contextWindowAuthoritative,
  desktopPetVisible,
  directoryApproval,
  input,
  isGenerating,
  messages, messageRouteHash, modelReadiness,
  modelOptions,
  onAbort, onPause,
  onApprovalModeChange,
  onClearWorkspace, onAuthorizeDirectoryRequest,
  onRejectDirectoryRequest,
  onAuthorizeDirectory,
  onCloseDesktopPet, onCloseInlinePanel,
  onCloseModelPicker,
  onClosePreview, onCloseWorkbench,
  onDirectoryReject,
  onDismissResume, onForkMessage,
  forkingMessageId,
  onExpandCompaction, onFileChange,
  onGoalsChange,
  onInlineContext, onInlineTasks, onKeyDown,
  onManageMcp, onManageModels,
  onModelChange,
  onModelRetry,
  onNavigatePermissions,
  onOpenArtifact, onOpenInPreview,
  onOpenModelPicker,
  onPermAllow,
  onPermDeny,
  onPreviewMessage,
  onRetryModelFailure,
  onSelectWorkspace,
  onResume,
  onSend,
  onSubmitFeedback,
  onSlashCommandSelect,
  onToolApproval,
  onWorkbenchSend,
  onWorkbenchTabChange,
  onWorkbenchToggle,
  manualRetryAvailable, resumeAvailable,
  continueSameTaskAvailable, handleContinueSameTask,
  runtimeSkillIds,
  selectedModel,
  selectedModelProviderId,
  selectedWorkspacePath,
  setAttachments,
  setInput,
  setShowContextPanel,
  showContextPanel,
  showModelPicker,
  slashCommands,
  slashInlinePanel,
  state,
  t,
  tasks,
  toolApproval,
  workbenchMessage,
  workbenchOpen,
  planVisible,
  planArtifacts = [],
  onClosePlan, onOpenPlan,
  sessionChangesReview = null,
  workbenchTab,
  previewArtifact,
  previewTabs,
  previewActiveId,
  onActivatePreviewTab,
  onClosePreviewTab,
  recentWorkspaces,
  workspaceBusy,
  workspaceError,
}) {
  const latestAssistantMessage = [...messages].reverse().find((message) => message?.role === 'assistant')
  const actualPromptTokens = latestAssistantMessage?.meta?.actualPromptTokens, serverEstimatedPromptTokens = latestAssistantMessage?.meta?.serverEstimatedPromptTokens
  // 优先显示服务端真实 usage；缺失时用服务端最终请求估算，避免压缩后按完整 UI 历史高估。
  const contextUsage = {
    ...estimateClientContextUsage({
      messages,
      tools: contextToolSpecs,
      systemPrompt: contextSystemPrompt,
      contextWindow,
      actualPromptTokens,
      serverEstimatedPromptTokens,
    }),
    cumulativeTokens: sumSessionModelUsage(messages),
    modelUsage: latestAssistantMessage?.meta?.modelUsage,
    contextWindowAuthoritative,
  }
  const toggleContextPanel = () => setShowContextPanel((current) => !current)
  const hasWorkspace = Boolean(selectedWorkspacePath || activeSession?.workspacePath)

  return (
    <AppLayout className="flex h-screen min-w-0 overflow-hidden bg-paper" mainAs="main" mainClassName="relative flex min-w-0 flex-1 overflow-hidden" mainProps={{ 'data-chat-main-area': true }}>
      <div className="chat-main-pane flex min-w-0 flex-[1_1_640px] flex-col overflow-hidden">
        <header className="chat-session-header flex h-12 shrink-0 items-center gap-2.5 px-4 backdrop-blur-sm" data-chat-context={hasWorkspace ? 'project' : 'conversation'}>
          <ChatSessionHeading hasWorkspace={hasWorkspace} title={activeSession?.title || t('nav.newChat')} data-testid="chat-session-title" />
          <button type="button" data-testid="header-plan-toggle" aria-pressed={planVisible || undefined} onClick={() => (planVisible ? onClosePlan?.() : onOpenPlan?.())} title={t('workbench.planCardTitle')} aria-label={t('workbench.planCardTitle')} className="chat-chrome-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade hover:text-ink"><ListChecks className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" /></button>
          <SessionChangesReview review={sessionChangesReview} t={t} />
          <ChatWorkbenchToggle
            open={workbenchOpen}
            onClick={onWorkbenchToggle}
            title={t(workbenchOpen ? 'workbench.hide' : 'workbench.show')}
            aria-label={t(workbenchOpen ? 'workbench.hide' : 'workbench.show')}
            aria-controls="right-workbench"
            aria-expanded={workbenchOpen}
            data-testid="workbench-toggle"
          />
        </header>
        <ChatMessages key={JSON.stringify([recoveryOwnerScope, activeSessionId || '__draft__'])}
          sessionId={activeSessionId} recoveryOwnerScope={recoveryOwnerScope}
          onSideEffectResolved={onSideEffectResolved}
          messages={messages} routeHash={messageRouteHash}
          workbenchMessage={workbenchMessage} isGenerating={isGenerating}
          onForkMessage={onForkMessage}
          forkingMessageId={forkingMessageId}
          onAuthorizeDirectoryRequest={onAuthorizeDirectoryRequest}
          onRejectDirectoryRequest={onRejectDirectoryRequest}
          onManageModels={onManageModels}
          onRetryModelFailure={onRetryModelFailure}
          onPromptSelect={setInput}
          onOpenArtifact={onOpenArtifact}
          onOpenInPreview={onOpenInPreview}
          onExpandCompaction={onExpandCompaction}
        />
        <SlashInlinePanelHost
          panel={slashInlinePanel}
          onClose={onCloseInlinePanel}
          statusProps={{
            session: activeSession,
            messages,
            tasks,
            model: selectedModel,
            contextWindow,
            toolSpecs: contextToolSpecs,
            systemPrompt: contextSystemPrompt,
            approvalMode,
            onOpenTasks: onInlineTasks, onOpenContext: onInlineContext,
          }}
          todos={activeSession?.todos || []}
          sessionId={activeSessionId || ''}
          onGoalsChange={onGoalsChange}
          onSubmitFeedback={onSubmitFeedback} onManageMcp={onManageMcp}
        />
        {directoryApproval.open && (
          <DirectoryApprovalModal
            key={directoryApproval.requestId || directoryApproval.request?.suggestGrantPath || directoryApproval.request?.path || 'request'}
            open={directoryApproval.open}
            request={directoryApproval.request}
            busy={directoryApproval.busy}
            error={directoryApproval.error}
            onAuthorize={onAuthorizeDirectory}
            onReject={onDirectoryReject}
          />
        )}
        {(state.permRequest || toolApproval.open) && (
          <div
            className="chat-notice-dock mx-auto flex w-full min-w-0 max-w-[780px] flex-col gap-2 px-4 pb-2 sm:px-6"
            data-testid="chat-approval-dock"
          >
            <PermissionRequestCard
              request={state.permRequest}
              onAllow={onPermAllow}
              onDeny={onPermDeny}
              onNavigate={onNavigatePermissions}
              t={t}
            />
            <ToolApprovalCard
              open={toolApproval.open}
              request={toolApproval.request}
              busy={toolApproval.busy}
              onDecide={onToolApproval}
            />
          </div>
        )}
        <ChatNoticeDocks
          continueSameTaskAvailable={continueSameTaskAvailable}
          handleContinueSameTask={handleContinueSameTask}
          isGenerating={isGenerating}
          manualRetryAvailable={manualRetryAvailable}
          onDismissResume={onDismissResume}
          onResume={onResume}
          resumeAvailable={resumeAvailable}
          t={t}
        />
        <ChatComposer
          input={input}
          setInput={setInput}
          onSend={onSend}
          attachments={attachments}
          setAttachments={setAttachments}
          contextPanelOpen={showContextPanel}
          contextUsage={contextUsage}
          modelPickerOpen={showModelPicker}
          modelOptions={modelOptions}
          modelReadiness={modelReadiness}
          selectedModel={selectedModel}
          selectedModelProviderId={selectedModelProviderId}
          isGenerating={isGenerating}
          onAbort={onAbort} onPause={onPause}
          onFileChange={onFileChange}
          onToggleContext={toggleContextPanel}
          onOpenModelPicker={onOpenModelPicker}
          onCloseModelPicker={onCloseModelPicker}
          onModelChange={onModelChange}
          onModelRetry={onModelRetry}
          onManageModels={onManageModels}
          onOpenAttachment={onOpenArtifact}
          approvalMode={approvalMode}
          onApprovalModeChange={onApprovalModeChange}
          handleKeyDown={onKeyDown}
          skillIds={runtimeSkillIds}
          slashCommands={slashCommands}
          onSlashCommandSelect={onSlashCommandSelect}
          onClearWorkspace={onClearWorkspace}
          onSelectWorkspace={onSelectWorkspace}
          recentWorkspaces={recentWorkspaces}
          selectedWorkspacePath={selectedWorkspacePath}
          showWorkspacePicker={messages.length === 0}
          workspaceBusy={workspaceBusy}
          workspaceError={workspaceError}
        />
      </div>

      <ChatRightPanels
        workbenchOpen={workbenchOpen}
        sessionId={activeSessionId}
        todos={activeSession?.todos || []}
        messages={messages}
        attachments={attachments}
        workbenchTab={workbenchTab}
        onWorkbenchTabChange={onWorkbenchTabChange}
        onCloseWorkbench={onCloseWorkbench}
        onOpenArtifact={onOpenArtifact}
        onWorkbenchSend={onWorkbenchSend}
        isGenerating={isGenerating}
        workbenchMessage={workbenchMessage}
        previewArtifact={previewArtifact}
        previewTabs={previewTabs}
        previewActiveId={previewActiveId}
        onActivatePreviewTab={onActivatePreviewTab}
        onClosePreviewTab={onClosePreviewTab}
        onClosePreview={onClosePreview}
        onPreviewMessage={onPreviewMessage}
        selectedWorkspacePath={selectedWorkspacePath}
      />

      {/* The plan card belongs to the session, not to the tool panel, so it is
          drawn over the main area and stays put whether or not the panel is open. */}
      {planVisible && (
        <PlanCard
          artifacts={planArtifacts}
          onClose={onClosePlan}
          onOpenArtifact={onOpenArtifact}
          onRevealTurn={revealTurnInConversation}
          sessionId={activeSessionId}
          t={t}
          todos={activeSession?.todos || []}
        />
      )}

      <ChatDesktopPetHost isGenerating={isGenerating} messages={messages} onClose={onCloseDesktopPet}
        tasks={tasks} toolApproval={toolApproval} visible={desktopPetVisible} />
    </AppLayout>
  )
}

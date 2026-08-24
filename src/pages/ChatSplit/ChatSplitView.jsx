import { Folder, PanelRightClose, PanelRightOpen } from 'lucide-react'
import AppLayout from '../../components/AppLayout.jsx'
import DirectoryApprovalModal from '../../components/DirectoryApprovalModal.jsx'
import ToolApprovalCard from '../../components/ToolApprovalCard.jsx'
import PermissionRequestCard from './chatMessages/PermissionRequestCard.jsx'
import ChatComposer from './ChatComposer'
import ChatMessages from './ChatMessages'
import DesktopPet from './DesktopPet.jsx'
import ChatRightPanels from './chatSplitView/ChatRightPanels.jsx'
import SlashInlinePanelHost from './SlashInlinePanelHost.jsx'
import { estimateClientContextUsage, sumSessionModelUsage } from '../../lib/contextUsage.js'

export { ChatRightPanels }

export default function ChatSplitView({
  activeSession,
  activeSessionId,
  approvalMode,
  attachments,
  contextSystemPrompt,
  contextToolSpecs,
  contextWindow,
  contextWindowAuthoritative,
  desktopPetVisible,
  directoryApproval,
  editingMessageId,
  input,
  isGenerating,
  messages,
  modelReadiness,
  modelOptions,
  onAbort,
  onApprovalModeChange,
  onClearWorkspace,
  onAuthorizeDirectoryRequest,
  onAuthorizeDirectory,
  onCancelMessageEdit,
  onCloseDesktopPet,
  onCloseInlinePanel,
  onCloseModelPicker,
  onClosePreview,
  onCloseWorkbench,
  onDirectoryReject,
  onDismissResume,
  onEditMessage,
  onExpandCompaction,
  onFileChange,
  onGoalsChange,
  onInlineContext,
  onInlineTasks,
  onKeyDown,
  onManageMcp,
  onManageModels,
  onModelChange,
  onModelRetry,
  onNavigatePermissions,
  onOpenArtifact,
  onOpenInPreview,
  onOpenModelPicker,
  onPermAllow,
  onPermDeny,
  onPreviewMessage,
  onQuoteSelection,
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
  resumeAvailable,
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
  const latestAssistantMessage = [...messages].reverse()
    .find((message) => message?.role === 'assistant')
  const actualPromptTokens = latestAssistantMessage?.meta?.actualPromptTokens
  const serverEstimatedPromptTokens = latestAssistantMessage?.meta?.serverEstimatedPromptTokens
  // 优先显示服务端真实 usage；上游不返回 usage 时使用服务端最终请求估算，
  // 避免压缩后仍按完整 UI 历史高估当前上下文。
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
    contextWindowAuthoritative,
  }
  const toggleContextPanel = () => setShowContextPanel((current) => !current)

  return (
    <AppLayout className="flex h-screen min-w-0 overflow-hidden bg-paper">
      <div className="chat-main-pane flex min-w-0 flex-[1_1_640px] flex-col overflow-hidden">
        <header className="chat-session-header flex h-12 shrink-0 items-center gap-3 px-4 backdrop-blur-sm">
          <Folder className="h-4 w-4 shrink-0 text-ink-fade" aria-hidden="true" />
          <h1
            className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-ink"
            data-testid="chat-session-title"
            title={activeSession?.title || t('nav.newChat')}
          >
            {activeSession?.title || t('nav.newChat')}
          </h1>
          <button
            type="button"
            onClick={onWorkbenchToggle}
            className="chat-chrome-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade hover:text-ink"
            title={t(workbenchOpen ? 'workbench.hide' : 'workbench.show')}
            aria-label={t(workbenchOpen ? 'workbench.hide' : 'workbench.show')}
            aria-controls="right-workbench"
            aria-expanded={workbenchOpen}
            data-testid="workbench-toggle"
          >
            {workbenchOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </header>
        <ChatMessages
          key={activeSessionId || '__draft__'}
          messages={messages}
          workbenchMessage={workbenchMessage}
          isGenerating={isGenerating}
          onEditMessage={onEditMessage}
          onAuthorizeDirectoryRequest={onAuthorizeDirectoryRequest}
          onManageModels={onManageModels}
          onQuoteSelection={onQuoteSelection}
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
            onOpenTasks: onInlineTasks,
            onOpenContext: onInlineContext,
          }}
          todos={activeSession?.todos || []}
          onGoalsChange={onGoalsChange}
          onSubmitFeedback={onSubmitFeedback}
          onManageMcp={onManageMcp}
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
            className="mx-auto flex w-full min-w-0 max-w-[min(780px,calc(100vw-320px))] flex-col gap-2 px-4 pb-2"
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
        {resumeAvailable && !isGenerating && (
          <div className="mx-auto w-full min-w-0 max-w-[min(780px,calc(100vw-320px))] px-4 pb-1.5">
            <div className="flex items-center gap-2 rounded-md border border-ink/10 border-l-2 border-l-warning/55 bg-paper-2/45 px-3 py-2 text-xs">
              <span className="flex-1 text-ink-soft">{t('toast.chatResumeHint')}</span>
              <button type="button" onClick={onResume} className="h-7 px-3 rounded-md bg-accent text-accent-contrast">
                {t('toast.chatResumeButton')}
              </button>
              <button type="button" onClick={onDismissResume} className="h-7 px-2 text-ink-fade hover:text-ink">
                {t('toast.chatResumeDismiss')}
              </button>
            </div>
          </div>
        )}

        <ChatComposer
          input={input}
          editingMessageId={editingMessageId}
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
          onAbort={onAbort}
          onCancelMessageEdit={onCancelMessageEdit}
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
          showWorkspacePicker={messages.length === 0 && !String(selectedWorkspacePath || '').trim()}
          workspaceBusy={workspaceBusy}
          workspaceError={workspaceError}
        />
      </div>

      <ChatRightPanels
        workbenchOpen={workbenchOpen}
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
      />

      {desktopPetVisible && !window.gugoDesktop?.isDesktop && (
        <DesktopPet
          onClose={onCloseDesktopPet}
          isGenerating={isGenerating}
          messages={messages}
          tasks={tasks}
          toolApproval={toolApproval}
        />
      )}

    </AppLayout>
  )
}

import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import LeftRail from '../../components/LeftRail'
import DirectoryApprovalModal from '../../components/DirectoryApprovalModal.jsx'
import ToolApprovalCard from '../../components/ToolApprovalCard.jsx'
import ChatComposer from './ChatComposer'
import ChatMessages from './ChatMessages'
import DesktopPet from './DesktopPet.jsx'
import RightPreviewPane from './RightPreviewPane'
import RightWorkbench from './RightWorkbench'
import SlashInlinePanelHost from './SlashInlinePanelHost.jsx'
import { estimateClientContextUsage } from '../../lib/contextUsage.js'

export function ChatRightPanels({
  workbenchOpen,
  messages,
  workbenchTab,
  onWorkbenchTabChange,
  onCloseWorkbench,
  onOpenArtifact,
  onWorkbenchSend,
  isGenerating,
  workbenchMessage,
  previewArtifact,
  previewTabs,
  previewActiveId,
  onActivatePreviewTab,
  onClosePreviewTab,
  onClosePreview,
  onPreviewMessage,
}) {
  if (!workbenchOpen) return null
  if (previewArtifact) {
    return <RightPreviewPane
      artifact={previewArtifact}
      previewTabs={previewTabs}
      activePreviewId={previewActiveId}
      onActivateTab={onActivatePreviewTab}
      onCloseTab={onClosePreviewTab}
      onClose={onClosePreview}
      onMessage={onPreviewMessage}
    />
  }
  return (
    <RightWorkbench
      messages={messages}
      activeTab={workbenchTab}
      onTabChange={onWorkbenchTabChange}
      onClose={onCloseWorkbench}
      onOpenArtifact={onOpenArtifact}
      onSendMessage={onWorkbenchSend}
      isGenerating={isGenerating}
      statusMessage={workbenchMessage}
    />
  )
}

export default function ChatSplitView({
  activeSession,
  activeSessionId,
  approvalMode,
  attachments,
  contextSystemPrompt,
  contextToolSpecs,
  contextWindow,
  desktopPetVisible,
  directoryApproval,
  input,
  isGenerating,
  messages,
  modelOptions,
  onAbort,
  onApprovalModeChange,
  onAuthorizeDirectoryRequest,
  onAuthorizeDirectory,
  onCloseDesktopPet,
  onCloseInlinePanel,
  onCloseModelPicker,
  onClosePreview,
  onCloseWorkbench,
  onDirectoryReject,
  onDismissResume,
  onExpandCompaction,
  onFileChange,
  onGoalsChange,
  onInlineContext,
  onInlineTasks,
  onKeyDown,
  onManageMcp,
  onManageModels,
  onModelChange,
  onNavigatePermissions,
  onOpenArtifact,
  onOpenInPreview,
  onOpenModelPicker,
  onPermAllow,
  onPermDeny,
  onPreviewMessage,
  onQuoteSelection,
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
}) {
  const latestAssistantMessage = [...messages].reverse()
    .find((message) => message?.role === 'assistant')
  const actualPromptTokens = latestAssistantMessage?.meta?.actualPromptTokens
  // 优先显示服务端最新一次模型调用的真实 prompt tokens；缺失时再估算。
  const contextUsage = estimateClientContextUsage({
    messages,
    tools: contextToolSpecs,
    systemPrompt: contextSystemPrompt,
    contextWindow,
    actualPromptTokens,
  })
  const toggleContextPanel = () => setShowContextPanel((current) => !current)

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex h-12 shrink-0 items-center justify-end border-b border-ink/10 px-3">
          <button
            type="button"
            onClick={onWorkbenchToggle}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-paper-2 hover:text-ink"
            title={t(workbenchOpen ? 'workbench.hide' : 'workbench.show')}
            aria-label={t(workbenchOpen ? 'workbench.hide' : 'workbench.show')}
            aria-controls="right-workbench"
            aria-expanded={workbenchOpen}
            data-testid="workbench-toggle"
          >
            {workbenchOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
        <ChatMessages
          key={activeSessionId || '__draft__'}
          messages={messages}
          state={state}
          workbenchMessage={workbenchMessage}
          isGenerating={isGenerating}
          onPermAllow={onPermAllow}
          onPermDeny={onPermDeny}
          onAuthorizeDirectoryRequest={onAuthorizeDirectoryRequest}
          onNavigatePermissions={onNavigatePermissions}
          onQuoteSelection={onQuoteSelection}
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

        {toolApproval.open && (
          <div className="mx-auto w-full max-w-[872px] px-4 pb-2">
            <ToolApprovalCard
              open={toolApproval.open}
              request={toolApproval.request}
              busy={toolApproval.busy}
              onDecide={onToolApproval}
            />
          </div>
        )}

        {resumeAvailable && !isGenerating && (
          <div className="mx-auto w-full max-w-[872px] px-4 pb-1.5">
            <div className="flex items-center gap-2 text-xs border border-amber-500/40 bg-amber-500/5 rounded-md px-3 py-2">
              <span className="flex-1 text-ink-soft">{t('toast.chatResumeHint')}</span>
              <button type="button" onClick={onResume} className="h-7 px-3 rounded-md bg-ember text-paper">
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
          setInput={setInput}
          onSend={onSend}
          attachments={attachments}
          setAttachments={setAttachments}
          contextPanelOpen={showContextPanel}
          contextUsage={contextUsage}
          modelPickerOpen={showModelPicker}
          modelOptions={modelOptions}
          selectedModel={selectedModel}
          isGenerating={isGenerating}
          onAbort={onAbort}
          onFileChange={onFileChange}
          onToggleContext={toggleContextPanel}
          onOpenModelPicker={onOpenModelPicker}
          onCloseModelPicker={onCloseModelPicker}
          onModelChange={onModelChange}
          onManageModels={onManageModels}
          approvalMode={approvalMode}
          onApprovalModeChange={onApprovalModeChange}
          handleKeyDown={onKeyDown}
          skillIds={runtimeSkillIds}
          slashCommands={slashCommands}
          onSlashCommandSelect={onSlashCommandSelect}
        />
      </div>

      <ChatRightPanels
        workbenchOpen={workbenchOpen}
        messages={messages}
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

    </div>
  )
}

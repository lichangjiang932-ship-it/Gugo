import RightPreviewPane from '../RightPreviewPane.jsx'
import RightWorkbench from '../RightWorkbench.jsx'

export default function ChatRightPanels({
  workbenchOpen,
  sessionId,
  todos,
  messages,
  attachments,
  workbenchTab,
  onWorkbenchTabChange,
  selectedWorkspacePath,
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
      sessionId={sessionId}
      todos={todos}
      messages={messages}
      attachments={attachments}
      activeTab={workbenchTab}
      onTabChange={onWorkbenchTabChange}
      onClose={onCloseWorkbench}
      onOpenArtifact={onOpenArtifact}
      onSendMessage={onWorkbenchSend}
      selectedWorkspacePath={selectedWorkspacePath}
      isGenerating={isGenerating}
      statusMessage={workbenchMessage}
    />
  )
}

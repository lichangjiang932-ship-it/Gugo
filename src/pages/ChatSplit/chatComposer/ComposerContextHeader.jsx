import WorkspaceProjectPicker from '../chatMessages/WorkspaceProjectPicker.jsx'

export default function ComposerContextHeader({
  editingMessageId,
  onCancelMessageEdit,
  onClearWorkspace,
  onSelectWorkspace,
  recentWorkspaces,
  selectedWorkspacePath,
  showWorkspacePicker,
  t,
  workspaceBusy,
  workspaceError,
}) {
  return (
    <>
      {editingMessageId && (
        <div
          className="chat-message-edit-banner mb-2 flex items-center gap-3 px-1 text-xs text-ink-soft"
          data-testid="message-edit-banner"
        >
          <span className="min-w-0 flex-1 truncate">{t('chatMessages.editResend')}</span>
          <button
            type="button"
            onClick={onCancelMessageEdit}
            className="chat-chrome-button rounded-control px-2 py-1 text-ink-fade hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}
      {showWorkspacePicker && (
        <div className="chat-composer-project-strip" data-testid="chat-composer-project-strip">
          <WorkspaceProjectPicker
            onClearWorkspace={onClearWorkspace}
            onSelectWorkspace={onSelectWorkspace}
            recentWorkspaces={recentWorkspaces}
            selectedWorkspacePath={selectedWorkspacePath}
            t={t}
            workspaceBusy={workspaceBusy}
            workspaceError={workspaceError}
          />
        </div>
      )}
    </>
  )
}

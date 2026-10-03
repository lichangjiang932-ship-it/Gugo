import WorkspaceProjectPicker from '../chatMessages/WorkspaceProjectPicker.jsx'

export default function ComposerContextHeader({
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

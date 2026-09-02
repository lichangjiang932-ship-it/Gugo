import {
  Check,
  Folder,
  FolderOpen,
  LoaderCircle,
  Plus,
  Search,
  X,
} from 'lucide-react'
import Modal from '../../../components/Modal.jsx'

function sameWorkspacePath(left, right) {
  const normalize = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

export function WorkspaceProjectPopover({
  busy,
  choosingPath,
  closePicker,
  filteredGroups,
  onClearWorkspace,
  onSelectProject,
  openCreate,
  pickerRef,
  query,
  searchRef,
  selectedWorkspacePath,
  setQuery,
  t,
}) {
  const renderProjectOption = (project) => {
    const selected = sameWorkspacePath(project.path, selectedWorkspacePath)
    const loading = sameWorkspacePath(project.path, choosingPath)
    return (
      <button
        key={project.path}
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => void onSelectProject(project)}
        disabled={busy}
        className="group flex h-8 w-full items-center gap-2 rounded-control px-2 text-left transition-colors hover:bg-ink/[0.045] focus-visible:bg-ink/[0.045] focus-visible:outline-none disabled:opacity-50"
        data-testid="workspace-project-option"
        title={project.path}
      >
        <Folder className="h-3.5 w-3.5 shrink-0 text-ink-fade group-hover:text-ink-soft" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{project.name}</span>
        {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-ink-fade" /> : selected ? <Check className="h-3.5 w-3.5 text-ink-soft" /> : null}
      </button>
    )
  }

  return (
    <div
      id="workspace-project-popover"
      role="dialog"
      aria-label={t('chatMessages.workspaceSelectProject')}
      className="absolute bottom-[calc(100%+0.4rem)] left-0 z-30 flex max-h-[min(54vh,22rem)] w-[min(18rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-[14px] border border-ink/10 bg-paper shadow-xl"
      data-testid="workspace-project-popover"
    >
      <div className="border-b border-ink/8 p-1.5">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-fade" aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') return
              event.preventDefault()
              pickerRef.current?.querySelector('[data-testid="workspace-project-option"]')?.focus()
            }}
            placeholder={t('chatMessages.workspaceSearchProjects')}
            aria-label={t('chatMessages.workspaceSearchProjects')}
            className="h-7 w-full rounded-control border border-ink/10 bg-paper-2/45 pl-7 pr-2 text-xs text-ink outline-none placeholder:text-ink-fade focus:border-ink/20 focus:bg-paper"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label={t('chatMessages.workspaceSelectProject')}>
        {filteredGroups.projects.length === 0 && filteredGroups.recent.length === 0 && query.trim() ? (
          <p className="px-2 py-4 text-center text-xs text-ink-fade">{t('chatMessages.workspaceNoMatchingProjects')}</p>
        ) : (
          <>
            {filteredGroups.projects.length > 0 && (
              <div role="group" aria-label={t('chatMessages.workspaceProjects')} data-testid="workspace-projects-group">
                <p className="px-2 pb-0.5 pt-1 text-xs text-ink-fade">
                  {t('chatMessages.workspaceProjects')}
                </p>
                {filteredGroups.projects.map(renderProjectOption)}
              </div>
            )}
            {(!query.trim() || filteredGroups.recent.length > 0) && (
              <div className="mt-0.5 border-t border-ink/8 pt-0.5" role="group" aria-label={t('chatMessages.workspaceRecent')} data-testid="workspace-recent-group">
                <p className="px-2 pb-0.5 pt-1 text-xs text-ink-fade">
                  {t('chatMessages.workspaceRecent')}
                </p>
                {filteredGroups.recent.length > 0
                  ? filteredGroups.recent.map(renderProjectOption)
                  : <p className="px-2 py-1.5 text-xs text-ink-fade">{t('chatMessages.workspaceRecentEmpty')}</p>}
              </div>
            )}
          </>
        )}
      </div>

      {selectedWorkspacePath ? (
        <div className="border-t border-ink/8 px-1 py-0.5">
          <button
            type="button"
            onClick={async () => {
              try {
                await onClearWorkspace?.()
                closePicker({ restoreFocus: true })
              } catch {
                // The caller exposes the persistence failure and keeps the picker open.
              }
            }}
            disabled={busy}
            className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-xs text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50"
            data-testid="workspace-use-default"
          >
            <X className="h-3.5 w-3.5 text-ink-fade" />
            {t('chatMessages.workspaceUseDefault')}
          </button>
        </div>
      ) : null}

      <div className="border-t border-ink/8 p-1">
        <button
          type="button"
          onClick={openCreate}
          className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-xs text-ink transition-colors hover:bg-ink/[0.045] focus-visible:bg-ink/[0.045] focus-visible:outline-none"
          data-testid="workspace-new-project"
        >
          <Plus className="h-3.5 w-3.5 text-ink-soft" />
          {t('chatMessages.workspaceNewProject')}
        </button>
      </div>
    </div>
  )
}

export function WorkspaceProjectCreateModal({
  DirectoryBrowser,
  busy,
  chooseSourceDirectory,
  closeCreate,
  createError,
  createOpen,
  createProject,
  creating,
  directoryOpen,
  projectName,
  projectNameRef,
  selectedWorkspacePath,
  setDirectoryOpen,
  setProjectName,
  setSourcePath,
  sourceButtonRef,
  sourcePath,
  sourcePickerBusy,
  t,
  workspaceError,
}) {
  return (
    <Modal
      open={createOpen}
      onClose={closeCreate}
      closeOnBackdrop={!creating}
      initialFocusRef={sourceButtonRef}
      restoreFocusSelector="[data-testid='workspace-project-trigger']"
      ariaLabelledby="workspace-create-project-title"
      className="max-h-[calc(100vh-2rem)] max-w-[640px] overflow-y-auto"
      testId="workspace-create-project-overlay"
    >
      <div className="flex items-start gap-4 px-6 pb-3 pt-6">
        <div className="min-w-0 flex-1">
          <h2 id="workspace-create-project-title" className="text-xl font-semibold tracking-[-0.02em] text-ink">
            {t('chatMessages.workspaceCreateTitle')}
          </h2>
          <p className="mt-1.5 text-sm leading-5 text-ink-fade">{t('chatMessages.workspaceCreateHint')}</p>
        </div>
        <button
          type="button"
          onClick={closeCreate}
          disabled={creating}
          className="flex h-8 w-8 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/[0.045] hover:text-ink disabled:opacity-50"
          aria-label={t('chatMessages.workspaceCloseCreate')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-5 px-6 py-4">
        <div>
          <span className="mb-1.5 block text-xs font-medium text-ink-soft">{t('chatMessages.workspaceSourceFolder')}</span>
          <div className="flex min-h-[124px] flex-col items-center justify-center gap-2 rounded-card border border-ink/10 bg-paper-2/35 px-5 py-4 text-center shadow-sm">
            <span className="flex h-9 w-9 items-center justify-center rounded-control bg-ink/[0.045] text-ink-fade">
              {sourcePickerBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" aria-hidden="true" />}
            </span>
            <span className={`max-w-full truncate text-xs leading-5 ${sourcePath ? 'font-mono text-ink-soft' : 'text-ink-fade'}`} title={sourcePath} data-testid="workspace-source-path">
              {sourcePath || t('chatMessages.workspaceSourceFolderEmpty')}
            </span>
            <button
              ref={sourceButtonRef}
              type="button"
              onClick={() => void chooseSourceDirectory()}
              disabled={creating || sourcePickerBusy}
              className="h-8 shrink-0 rounded-control border border-ink/12 bg-paper px-3 text-xs text-ink-soft transition-colors hover:border-ink/20 hover:text-ink disabled:opacity-50"
              aria-expanded={directoryOpen}
              data-testid="workspace-choose-source"
            >
              {t('chatMessages.workspaceChooseSource')}
            </button>
          </div>
          {directoryOpen ? (
            <DirectoryBrowser
              initialPath={sourcePath || selectedWorkspacePath}
              onSelect={(path) => {
                setSourcePath(String(path || '').trim())
                setDirectoryOpen(false)
              }}
              onCancel={() => setDirectoryOpen(false)}
              neutral
              t={t}
            />
          ) : null}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-soft">{t('chatMessages.workspaceProjectName')}</span>
          <span className="flex min-h-12 items-center gap-3 rounded-card border border-ink/10 bg-paper px-3.5 shadow-sm transition-colors focus-within:border-ink/25 focus-within:ring-2 focus-within:ring-focus/15">
            <Folder className="h-4 w-4 shrink-0 text-ink-fade" aria-hidden="true" />
            <input
              ref={projectNameRef}
              value={projectName}
              onInput={(event) => setProjectName(event.currentTarget.value)}
              disabled={creating}
              maxLength={80}
              placeholder={t('chatMessages.workspaceProjectNamePlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-fade"
              data-testid="workspace-project-name"
            />
          </span>
        </label>

        {createError || workspaceError ? (
          <p className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger" role="alert">
            {createError || workspaceError}
          </p>
        ) : null}
      </div>

      <div className="flex justify-end gap-2 px-6 pb-6 pt-3">
        <button type="button" onClick={closeCreate} disabled={creating} className="btn-ghost">
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void createProject()}
          disabled={busy || (!projectName.trim() && !sourcePath.trim())}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-control bg-ink px-4 text-sm font-medium text-paper transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="workspace-create-project"
        >
          {creating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {creating ? t('chatMessages.workspaceCreating') : t('chatMessages.workspaceCreate')}
        </button>
      </div>
    </Modal>
  )
}

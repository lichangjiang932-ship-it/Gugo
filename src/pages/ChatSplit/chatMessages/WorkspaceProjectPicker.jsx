import { ChevronDown, Folder, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import InlineDirectoryBrowser from '../../../components/InlineDirectoryBrowser.jsx'
import {
  chatWorkspaceName,
  createManagedChatProject,
  deriveVisibleChatProjectGroups,
  pickNativeChatWorkspaceDirectory,
  rememberChatProject,
} from '../../../lib/chatWorkspaceSelection.js'
import {
  WorkspaceProjectCreateModal,
  WorkspaceProjectPopover,
} from './WorkspaceProjectPickerViews.jsx'

function sameWorkspacePath(left, right) {
  const normalize = (value) => String(value || '').replace(/[\\/]+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

export default function WorkspaceProjectPicker({
  createManagedProject = createManagedChatProject,
  DirectoryBrowser = InlineDirectoryBrowser,
  onClearWorkspace,
  onSelectWorkspace,
  pickSourceDirectory = pickNativeChatWorkspaceDirectory,
  recentWorkspaces = [],
  selectedWorkspacePath = '',
  t,
  workspaceBusy = false,
  workspaceError = '',
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [projectName, setProjectName] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [choosingPath, setChoosingPath] = useState('')
  const [sourcePickerBusy, setSourcePickerBusy] = useState(false)
  const pickerRef = useRef(null)
  const triggerRef = useRef(null)
  const searchRef = useRef(null)
  const projectNameRef = useRef(null)
  const sourceButtonRef = useRef(null)

  const { projects: savedProjects, recent: recentProjects } = useMemo(
    () => deriveVisibleChatProjectGroups(recentWorkspaces, selectedWorkspacePath),
    [recentWorkspaces, selectedWorkspacePath],
  )
  const projects = useMemo(() => [...savedProjects, ...recentProjects], [recentProjects, savedProjects])
  const selectedProject = projects.find((project) => (
    sameWorkspacePath(project.path, selectedWorkspacePath)
  ))
  const selectedName = selectedProject?.name || chatWorkspaceName(selectedWorkspacePath)
  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const filterProjects = (items) => !normalizedQuery ? items : items.filter((project) => (
      `${project.name}\n${project.path}`.toLocaleLowerCase().includes(normalizedQuery)
    ))
    return {
      projects: filterProjects(savedProjects),
      recent: filterProjects(recentProjects),
    }
  }, [query, recentProjects, savedProjects])
  const busy = workspaceBusy || creating || sourcePickerBusy || Boolean(choosingPath)

  const closePicker = useCallback(({ restoreFocus = false } = {}) => {
    setPickerOpen(false)
    setQuery('')
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!pickerOpen) return undefined
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0)
    const onMouseDown = (event) => {
      if (!pickerRef.current?.contains(event.target)) closePicker()
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closePicker({ restoreFocus: true })
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closePicker, pickerOpen])

  const rememberProject = useCallback((project) => {
    rememberChatProject(project)
  }, [])

  const chooseProject = async (project) => {
    if (busy) return
    setChoosingPath(project.path)
    try {
      const activated = await onSelectWorkspace?.(project.path)
      const path = String(activated?.path || project.path).trim()
      rememberProject({ path, name: project.name })
      closePicker({ restoreFocus: true })
    } catch {
      // The caller provides an actionable workspaceError and the picker stays open.
    } finally {
      setChoosingPath('')
    }
  }

  const openCreate = () => {
    closePicker()
    setProjectName('')
    setSourcePath('')
    setCreateError('')
    setDirectoryOpen(false)
    setCreateOpen(true)
  }

  const closeCreate = useCallback(() => {
    if (creating || sourcePickerBusy) return
    setCreateOpen(false)
    setDirectoryOpen(false)
  }, [creating, sourcePickerBusy])

  const chooseSourceDirectory = async () => {
    if (creating || sourcePickerBusy) return
    if (directoryOpen) {
      setDirectoryOpen(false)
      return
    }
    setSourcePickerBusy(true)
    setCreateError('')
    try {
      const result = await pickSourceDirectory(sourcePath)
      if (result?.supported) {
        if (!result.canceled && result.path) setSourcePath(String(result.path).trim())
        return
      }
      setDirectoryOpen(true)
    } catch (error) {
      setCreateError(String(error?.message || t('chatMessages.workspaceSelectionFailed')))
    } finally {
      setSourcePickerBusy(false)
    }
  }

  const createProject = async () => {
    const requestedPath = sourcePath.trim()
    const name = projectName.trim()
      || chatWorkspaceName(requestedPath)
      || requestedPath
    if (!name || busy) return
    setCreating(true)
    setCreateError('')
    try {
      const created = requestedPath
        ? { path: requestedPath }
        : await createManagedProject(name)
      const createdPath = String(created?.path || '').trim()
      if (!createdPath) throw new Error('Project workspace path is missing')
      const activated = await onSelectWorkspace?.(createdPath)
      const path = String(activated?.path || createdPath).trim()
      rememberProject({ path, name })
      setCreateOpen(false)
      setDirectoryOpen(false)
    } catch (error) {
      setCreateError(error?.code === 'PROJECT_CREATION_RESTART_REQUIRED'
        ? t('chatMessages.workspaceServiceRestartRequired')
        : String(error?.message || t('chatMessages.workspaceSelectionFailed')))
      // Keep the form open so the creation/activation error remains actionable.
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="relative w-fit max-w-full" ref={pickerRef} data-testid="chat-workspace-picker">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (pickerOpen) closePicker()
          else setPickerOpen(true)
        }}
        disabled={workspaceBusy}
        className="group inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-pill bg-ink/[0.045] px-2 text-left text-xs text-ink-soft transition-colors hover:bg-ink/[0.075] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/25 disabled:opacity-50"
        title={selectedWorkspacePath || t('chatMessages.workspaceDefaultHint')}
        aria-expanded={pickerOpen}
        aria-haspopup="dialog"
        aria-controls="workspace-project-popover"
        data-testid="workspace-project-trigger"
      >
        {workspaceBusy ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{selectedName || t('chatMessages.workspaceSelectProject')}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-ink-fade transition-transform ${pickerOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {pickerOpen ? (
        <WorkspaceProjectPopover
          busy={busy}
          choosingPath={choosingPath}
          closePicker={closePicker}
          filteredGroups={filteredGroups}
          onClearWorkspace={onClearWorkspace}
          onSelectProject={chooseProject}
          openCreate={openCreate}
          pickerRef={pickerRef}
          query={query}
          searchRef={searchRef}
          selectedWorkspacePath={selectedWorkspacePath}
          setQuery={setQuery}
          t={t}
        />
      ) : null}

      {workspaceError && !createOpen ? (
        <p className="mt-2 px-1 text-xs leading-5 text-danger" role="alert">{workspaceError}</p>
      ) : null}

      <WorkspaceProjectCreateModal
        DirectoryBrowser={DirectoryBrowser}
        busy={busy}
        chooseSourceDirectory={chooseSourceDirectory}
        closeCreate={closeCreate}
        createError={createError}
        createOpen={createOpen}
        createProject={createProject}
        creating={creating}
        directoryOpen={directoryOpen}
        projectName={projectName}
        projectNameRef={projectNameRef}
        setDirectoryOpen={setDirectoryOpen}
        setProjectName={setProjectName}
        setSourcePath={setSourcePath}
        sourceButtonRef={sourceButtonRef}
        sourcePath={sourcePath}
        sourcePickerBusy={sourcePickerBusy}
        t={t}
        workspaceError={workspaceError}
      />
    </div>
  )
}

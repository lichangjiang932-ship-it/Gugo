import {
  createManagedProjectDirectoryApi,
  grantLocalPathApi,
  selectLocalDirectoryApi,
  setWorkspaceTrustApi,
} from './localFileAccessClient.js'

export const CHAT_PROJECTS_STORAGE_KEY = 'gugo:chat-projects:v1'
export const CHAT_PROJECTS_CHANGED_EVENT = 'chat-projects:changed'

const MAX_STORED_PROJECTS = 24
const MAX_PROJECT_NAME_LENGTH = 80
const MAX_PROJECT_PATH_LENGTH = 2048

export function normalizeChatWorkspacePath(value) {
  return String(value || '').trim()
}

function normalizeDirectoryPickerResult(result) {
  if (result?.supported === false) {
    return { supported: false, canceled: false, path: '' }
  }
  const selectedPath = normalizeChatWorkspacePath(
    typeof result === 'string' ? result : result?.path,
  )
  return {
    supported: true,
    canceled: result?.canceled === true || !selectedPath,
    path: selectedPath,
  }
}

function directoryPickerUnsupported(error) {
  return [
    'NATIVE_DIRECTORY_PICKER_UNSUPPORTED',
    'DIRECTORY_PICKER_UNSUPPORTED',
    'NOT_SUPPORTED',
  ].includes(String(error?.code || '').trim().toUpperCase())
}

export async function pickNativeChatWorkspaceDirectory(
  defaultPath = '',
  {
    desktopBridge = globalThis.window?.gugoDesktop,
    selectLocalDirectory = selectLocalDirectoryApi,
    signal,
  } = {},
) {
  const normalizedDefaultPath = normalizeChatWorkspacePath(defaultPath)
  const openDirectory = typeof desktopBridge?.openDirectory === 'function'
    ? desktopBridge.openDirectory
    : desktopBridge?.selectDirectory
  if (typeof openDirectory === 'function') {
    try {
      const result = await openDirectory.call(desktopBridge, {
        defaultPath: normalizedDefaultPath,
      })
      const normalized = normalizeDirectoryPickerResult(result)
      if (normalized.supported) return normalized
    } catch {
      // The local service can still expose a native host picker when the
      // desktop bridge is missing or temporarily unavailable.
    }
  }

  if (typeof selectLocalDirectory !== 'function') {
    return { supported: false, canceled: false, path: '' }
  }
  try {
    return normalizeDirectoryPickerResult(await selectLocalDirectory(
      normalizedDefaultPath,
      { signal },
    ))
  } catch (error) {
    if (directoryPickerUnsupported(error)) {
      return { supported: false, canceled: false, path: '' }
    }
    throw error
  }
}

function workspacePathKey(value) {
  const normalized = normalizeChatWorkspacePath(value).replace(/[\\/]+$/, '')
  return /^[a-z]:[\\/]/i.test(normalized) ? normalized.toLowerCase() : normalized
}

function browserStorage() {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

function normalizeStoredProject(project, fallbackUsedAt = 0) {
  const path = normalizeChatWorkspacePath(project?.path).slice(0, MAX_PROJECT_PATH_LENGTH)
  if (!path) return null
  const name = String(project?.name || chatWorkspaceName(path)).trim().slice(0, MAX_PROJECT_NAME_LENGTH)
  return {
    path,
    name: name || chatWorkspaceName(path),
    usedAt: Number(project?.usedAt) || fallbackUsedAt,
  }
}

export function chatWorkspaceName(value) {
  const normalized = normalizeChatWorkspacePath(value).replace(/[\\/]+$/, '')
  if (!normalized) return ''
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized
}

export function deriveRecentChatWorkspaces(sessions, { limit = 5 } = {}) {
  const byPath = new Map()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const path = normalizeChatWorkspacePath(session?.workspacePath)
    if (!path) continue
    const key = workspacePathKey(path)
    const usedAt = Number(session?.updatedAt || session?.createdAt) || 0
    const current = byPath.get(key)
    if (!current || usedAt > current.usedAt) {
      byPath.set(key, {
        path,
        name: chatWorkspaceName(path),
        usedAt,
      })
    }
  }
  return [...byPath.values()]
    .sort((left, right) => right.usedAt - left.usedAt)
    .slice(0, Math.max(0, Number(limit) || 0))
}

export function readStoredChatProjects(storage = browserStorage()) {
  if (!storage?.getItem) return []
  try {
    const parsed = JSON.parse(storage.getItem(CHAT_PROJECTS_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    const byPath = new Map()
    for (const candidate of parsed.slice(0, MAX_STORED_PROJECTS * 2)) {
      const project = normalizeStoredProject(candidate)
      if (!project) continue
      const key = workspacePathKey(project.path)
      const current = byPath.get(key)
      if (!current || project.usedAt > current.usedAt) byPath.set(key, project)
    }
    return [...byPath.values()]
      .sort((left, right) => right.usedAt - left.usedAt)
      .slice(0, MAX_STORED_PROJECTS)
  } catch {
    return []
  }
}

export function rememberChatProject(project, {
  storage = browserStorage(),
  now = Date.now(),
} = {}) {
  const normalized = normalizeStoredProject(project, now)
  if (!normalized) return readStoredChatProjects(storage)
  const next = [normalized, ...readStoredChatProjects(storage)]
  const byPath = new Map()
  for (const candidate of next) {
    const key = workspacePathKey(candidate.path)
    if (!byPath.has(key)) byPath.set(key, candidate)
  }
  const projects = [...byPath.values()].slice(0, MAX_STORED_PROJECTS)
  try {
    storage?.setItem?.(CHAT_PROJECTS_STORAGE_KEY, JSON.stringify(projects))
  } catch {
    // Project activation must still succeed when browser persistence is blocked.
  }
  try {
    const EventConstructor = globalThis.CustomEvent || globalThis.window?.CustomEvent
    globalThis.window?.dispatchEvent?.(new EventConstructor(CHAT_PROJECTS_CHANGED_EVENT, {
      detail: { projects },
    }))
  } catch {
    // Project persistence is also used in non-browser tests and runtimes.
  }
  return projects
}

export function mergeChatProjects(
  recentWorkspaces,
  storedProjects,
  selectedWorkspacePath = '',
) {
  const storedByPath = new Map(
    (Array.isArray(storedProjects) ? storedProjects : [])
      .map((project) => normalizeStoredProject(project))
      .filter(Boolean)
      .map((project) => [workspacePathKey(project.path), project]),
  )
  const merged = []
  const seen = new Set()
  const append = (candidate) => {
    const normalized = normalizeStoredProject(candidate)
    if (!normalized) return
    const key = workspacePathKey(normalized.path)
    if (seen.has(key)) return
    seen.add(key)
    const stored = storedByPath.get(key)
    merged.push(stored ? { ...normalized, name: stored.name } : normalized)
  }
  for (const project of Array.isArray(recentWorkspaces) ? recentWorkspaces : []) append(project)
  for (const project of Array.isArray(storedProjects) ? storedProjects : []) append(project)
  if (selectedWorkspacePath) append({ path: selectedWorkspacePath, usedAt: Date.now() })
  return merged
}

export async function activateChatWorkspace(
  value,
  {
    grantPath = grantLocalPathApi,
    trustWorkspace = setWorkspaceTrustApi,
    signal,
  } = {},
) {
  const requestedPath = normalizeChatWorkspacePath(value)
  if (!requestedPath) return { path: '' }
  const grantResult = await grantPath({
    path: requestedPath,
    accessMode: 'read_write',
    scope: 'persistent',
  }, { signal })
  const grant = grantResult?.grant || grantResult
  const path = normalizeChatWorkspacePath(grant?.path || requestedPath)
  await trustWorkspace({ path, trusted: true, scope: 'persistent' }, { signal })
  return { path, grant }
}

export async function createManagedChatProject(
  name,
  {
    createProject = createManagedProjectDirectoryApi,
    signal,
  } = {},
) {
  const projectName = String(name || '').trim()
  if (!projectName) throw new TypeError('project name is required')
  const result = await createProject(projectName, { signal })
  const path = normalizeChatWorkspacePath(result?.project?.path)
  if (!path) {
    const error = new Error('Managed project creation returned no workspace path')
    error.code = 'MANAGED_PROJECT_PATH_MISSING'
    throw error
  }
  return { path }
}

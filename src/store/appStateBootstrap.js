import { PERMISSIONS } from '../data.js'
import { backfillMessageTimestamps } from '../lib/messageTime.js'
import { normalizeThemeMode } from '../lib/themeMode.js'
import {
  PERSIST_KEYS,
  readBootstrapPayloads,
  selectPersistedSnapshot,
} from './appStatePersistence.js'

export function createInitialState() {
  return {
    user: { name: null, email: null, avatar: null, plan: null, joinedAt: null, totalCalls: 0 },
    isLoggedIn: false,
    authMode: 'unknown',
    authReady: false,
    sessions: [],
    activeSessionId: null,
    tasks: [],
    history: [],
    permissions: PERMISSIONS.map((permission) => ({ ...permission, enabled: false, icon: permission.icon ?? null })),
    permRequest: null,
    choiceRequest: null,
    theme: 'white',
    accentColor: '#E86A3C',
    strongAccent: false,
    fontSize: 'medium',
    density: 'comfortable',
    animationsEnabled: true,
    draftInput: '',
    newDraftVersion: 0,
    skillConfigs: {},
    agentMode: 'chat',
    previewArtifact: null,
    toolsConfig: { web_search: false, fetch_url: false, create_pptx: true, create_docx: true, create_xlsx: true, create_react_component: true, create_mermaid: true, create_chart: true, create_svg: true, create_html_app: true, Agent: true, list_directory: false, read_file: false, write_file: false, edit_file: false, bash_exec: false, git_status: false, git_diff: false, run_project_check: false, manage_todos: true },
    sessionDrafts: {},
    persistenceNotice: null,
  }
}

export function normalizePersistedFields(saved, { cancelRunningTasks = false } = {}) {
  const base = createInitialState()
  const normalized = {}
  for (const key of PERSIST_KEYS) if (saved?.[key] !== undefined) normalized[key] = saved[key]
  if (normalized.theme !== undefined) normalized.theme = normalizeThemeMode(normalized.theme)
  if (saved?.toolsConfig && typeof saved.toolsConfig === 'object') normalized.toolsConfig = { ...base.toolsConfig, ...saved.toolsConfig }
  if (normalized.sessions !== undefined) normalized.sessions = backfillMessageTimestamps(normalized.sessions)
  if (Array.isArray(saved?.permissions)) {
    const enabledMap = new Map(saved.permissions.map((permission) => [permission.id, !!permission.enabled]))
    normalized.permissions = base.permissions.map((permission) => ({ ...permission, enabled: enabledMap.has(permission.id) ? enabledMap.get(permission.id) : permission.enabled }))
  }
  if (cancelRunningTasks && Array.isArray(normalized.tasks)) {
    normalized.tasks = normalized.tasks.map((task) => task?.status === 'running' ? { ...task, status: 'cancelled', stepLabel: '\u5df2\u4e2d\u65ad\uff08\u9875\u9762\u5237\u65b0\uff09' } : task)
  }
  return normalized
}

export function getLocalStorage() {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch (error) { console.warn('[AppContext] localStorage unavailable:', error?.name || error); return null }
}

export function readBootstrapState() {
  const base = createInitialState()
  const storage = getLocalStorage()
  if (!storage) return base
  try {
    const bootstrap = readBootstrapPayloads(storage, 0)
    const saved = bootstrap.settings?.snapshot || bootstrap.legacy?.snapshot
    return saved ? { ...base, ...normalizePersistedFields(saved) } : base
  } catch (error) {
    console.warn('[AppContext] failed to read bootstrap state:', error?.name || error)
    return base
  }
}

export function completeSnapshot(saved, options) {
  return selectPersistedSnapshot({ ...createInitialState(), ...normalizePersistedFields(saved, options) })
}

export function indexedDbNoticeResult(result) {
  if (result?.ok) return { ok: true, level: 'full' }
  if (result?.status === 'quota') return { ok: false, level: 'quota', error: result.error }
  return { ok: false, level: 'error', error: result?.error }
}

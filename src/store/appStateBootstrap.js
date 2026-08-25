import { PERMISSIONS } from '../data.js'
import { backfillMessageTimestamps } from '../lib/messageTime.js'
import { normalizeThemeMode } from '../lib/themeMode.js'
import {
  PERSIST_KEYS,
  readBootstrapPayloads,
  selectPersistedSnapshot,
} from './appStatePersistence.js'

export const TOOLS_CONFIG_SCHEMA_VERSION = 11

export function needsToolsConfigSchemaMigration(saved) {
  if (!saved?.toolsConfig || typeof saved.toolsConfig !== 'object') return false
  const savedSchemaVersion = Number(saved.toolsConfigSchemaVersion) || 0
  return savedSchemaVersion < TOOLS_CONFIG_SCHEMA_VERSION
}

export function createInitialState() {
  return {
    user: { name: null, email: null, avatar: null, joinedAt: null, totalCalls: 0 },
    isLoggedIn: false,
    authMode: 'unknown',
    authReady: false,
    sessions: [],
    activeSessionId: null,
    tasks: [],
    history: [],
    permissions: PERMISSIONS.map((permission) => ({
      ...permission,
      enabled: permission.enabled !== false,
      icon: permission.icon ?? null,
    })),
    permRequest: null,
    choiceRequest: null,
    theme: 'white',
    fontSize: 'medium',
    density: 'comfortable',
    animationsEnabled: true,
    inputHistoryNavigationEnabled: true,
    draftInput: '',
    draftSessionId: null,
    draftWorkspacePath: '',
    newDraftVersion: 0,
    skillConfigs: {},
    agentMode: 'chat',
    previewArtifact: null,
    previewTabs: [],
    previewActiveId: '',
    toolsConfigSchemaVersion: TOOLS_CONFIG_SCHEMA_VERSION,
    toolsConfig: {
      fetch_url: true,
      create_pptx: true,
      create_docx: true,
      create_xlsx: true,
      create_pdf: true,
      render_pdf_pages: true,
      create_react_component: true,
      create_mermaid: true,
      create_chart: true,
      create_svg: true,
      create_html_app: true,
      Agent: true,
      list_directory: true,
      read_file: true,
      write_file: true,
      edit_file: true,
      apply_patch: true,
      patch_file: true,
      bash_exec: true,
      run_command: true,
      run_test: true,
      docker_exec: true,
      file_download: true,
      git_status: true,
      git_diff: true,
      git_commit: true,
      git_push: true,
      git_rollback: true,
      git_write: true,
      run_project_check: true,
      image_info: true,
      image_transform: true,
      media_probe: true,
      media_transform: true,
      pdf_info: true,
      pdf_text: true,
      pdf_transform: true,
      archive_list: true,
      archive_create: true,
      archive_extract: true,
      batch_rename: true,
      file_hash_manifest: true,
      manage_todos: true,
    },
    sessionDrafts: {},
    persistenceNotice: null,
  }
}

export function normalizePersistedFields(saved, { cancelRunningTasks = false } = {}) {
  const base = createInitialState()
  const normalized = {}
  for (const key of PERSIST_KEYS) if (saved?.[key] !== undefined) normalized[key] = saved[key]
  if (normalized.inputHistoryNavigationEnabled !== undefined && typeof normalized.inputHistoryNavigationEnabled !== 'boolean') {
    delete normalized.inputHistoryNavigationEnabled
  }
  if (normalized.theme !== undefined) normalized.theme = normalizeThemeMode(normalized.theme)
  if (saved?.toolsConfig && typeof saved.toolsConfig === 'object') {
    normalized.toolsConfig = { ...base.toolsConfig, ...saved.toolsConfig }
    const savedSchemaVersion = Number(saved.toolsConfigSchemaVersion) || 0
    if (savedSchemaVersion < 1) {
      normalized.toolsConfig.bash_exec = true
    }
    if (savedSchemaVersion < 2) normalized.toolsConfig.run_project_check = true
    if (savedSchemaVersion < 3) {
      normalized.toolsConfig.image_info = true
      normalized.toolsConfig.image_transform = true
      normalized.toolsConfig.media_probe = true
      normalized.toolsConfig.media_transform = true
      normalized.toolsConfig.pdf_info = true
      normalized.toolsConfig.pdf_transform = true
    }
    if (savedSchemaVersion < 4) {
      normalized.toolsConfig.archive_create = true
      normalized.toolsConfig.archive_extract = true
      normalized.toolsConfig.batch_rename = true
      normalized.toolsConfig.file_hash_manifest = true
    }
    if (savedSchemaVersion < 5) {
      normalized.toolsConfig.pdf_text = true
      normalized.toolsConfig.archive_list = true
    }
    if (savedSchemaVersion < 6) {
      for (const name of [
        'list_directory',
        'read_file',
        'write_file',
        'edit_file',
        'apply_patch',
        'bash_exec',
        'git_status',
        'git_diff',
        'git_commit',
        'git_push',
        'git_rollback',
        'run_project_check',
      ]) normalized.toolsConfig[name] = true
    }
    if (savedSchemaVersion < 7) {
      normalized.toolsConfig.run_test = true
      normalized.toolsConfig.docker_exec = true
      normalized.toolsConfig.file_download = true
    }
    if (savedSchemaVersion < 8) {
      for (const name of [
        'patch_file',
        'run_command',
        'git_write',
      ]) normalized.toolsConfig[name] = true
    }
    if (savedSchemaVersion < 9) normalized.toolsConfig.create_pdf = true
    // The per-tool settings UI was removed in favour of the single runtime
    // permission mode. Older snapshots may still contain disabled switches
    // that users can no longer see or restore, so migrate every built-in tool
    // back to the current all-enabled default once.
    if (savedSchemaVersion < 10) {
      for (const name of Object.keys(base.toolsConfig)) normalized.toolsConfig[name] = true
    }
    if (savedSchemaVersion < 11) normalized.toolsConfig.render_pdf_pages = true
  }
  normalized.toolsConfigSchemaVersion = TOOLS_CONFIG_SCHEMA_VERSION
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

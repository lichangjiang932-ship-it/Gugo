import { normalizeThemeMode } from '../../lib/themeMode.js'
import { createInitialState } from '../appStateBootstrap.js'
import { TASK_STATUS } from '../taskStatus.js'
import { writeSessionDraft } from '../../lib/chatDrafts.js'
import {
  activatePreviewTab,
  createPreviewTabState,
  removePreviewTab,
  upsertPreviewTab,
} from '../../pages/ChatSplit/preview/previewTabs.js'

function currentPreviewTabState(state) {
  const tabs = Array.isArray(state.previewTabs) ? state.previewTabs : []
  if (tabs.length > 0) {
    const activeId = tabs.some((tab) => tab.id === state.previewActiveId)
      ? state.previewActiveId
      : tabs[0].id
    return { tabs, activeId }
  }
  return createPreviewTabState(state.previewArtifact)
}

function mergePreviewTabState(state, tabState) {
  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeId) || tabState.tabs[0] || null
  return {
    ...state,
    previewArtifact: activeTab?.artifact || null,
    previewTabs: tabState.tabs,
    previewActiveId: activeTab?.id || '',
  }
}

export function reduceTaskSettingsState(state, action) {
  switch (action.type) {
    case 'ADD_TASK': {
      const task = {
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: '',
        detail: '',
        status: TASK_STATUS.PENDING,
        progress: 0,
        step: 0,
        stepLabel: '',
        perms: [],
        ...action.payload,
        createdAt: Date.now(),
      }
      return { ...state, tasks: [...state.tasks, task] }
    }

    case 'UPDATE_TASK': {
      const { id, updates } = action.payload ?? {}
      if (!id) return state
      return {
        ...state,
        tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      }
    }

    case 'REMOVE_TASK': {
      const id = action.payload
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== id),
      }
    }

    case 'TOGGLE_PERM': {
      return {
        ...state,
        permissions: state.permissions.map((p) =>
          p.id === action.payload ? { ...p, enabled: !p.enabled } : p
        ),
      }
    }

    case 'SET_PERM_REQUEST': {
      return { ...state, permRequest: action.payload ?? null }
    }

    case 'SET_CHOICE_REQUEST': {
      return { ...state, choiceRequest: action.payload ?? null }
    }

    case 'SET_THEME': {
      return { ...state, theme: normalizeThemeMode(action.payload) }
    }

    case 'SET_FONT_SIZE': {
      return { ...state, fontSize: action.payload }
    }

    case 'SET_DENSITY': {
      return { ...state, density: action.payload }
    }

    case 'SET_ANIMATIONS': {
      return { ...state, animationsEnabled: !!action.payload }
    }

    case 'SET_INPUT_HISTORY_NAVIGATION': {
      return { ...state, inputHistoryNavigationEnabled: !!action.payload }
    }

    case 'ADD_HISTORY': {
      const item = {
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: '',
        skill: '',
        status: '',
        detail: '',
        state: '',
        date: Date.now(),
        ...action.payload,
      }
      return { ...state, history: [item, ...state.history] }
    }

    case 'CLEAR_HISTORY': {
      return { ...state, history: [] }
    }

    case 'CLEAR_ALL_DATA': {
      return createInitialState()
    }

    case 'IMPORT_SESSIONS': {
      // payload: \u5df2\u7ecf\u8fc7 schema \u6821\u9a8c\u7684 sessions \u6570\u7ec4
      const incoming = Array.isArray(action.payload) ? action.payload : []
      // id \u51b2\u7a81\u65f6\u628a\u5bfc\u5165\u9879\u91cd\u65b0\u5206\u914d id,\u907f\u514d\u8986\u76d6
      const existingIds = new Set(state.sessions.map((s) => s.id))
      const remapped = incoming.map((s) => {
        if (existingIds.has(s.id)) {
          const newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`
          return { ...s, id: newId }
        }
        return s
      })
      return {
        ...state,
        sessions: [...remapped, ...state.sessions],
      }
    }

    case 'IMPORT_SETTINGS': {
      // ★ #26: \u652f\u6301 merge / replace \u4e24\u79cd\u6a21\u5f0f (\u9ed8\u8ba4 merge,\u5411\u540e\u517c\u5bb9)
      // payload \u53ef\u4ee5\u662f { settings, mode } \u6216\u8001\u683c\u5f0f\u76f4\u63a5\u4f20 settings
      const raw = action.payload || {}
      const hasMode = raw && typeof raw === 'object' && 'mode' in raw && 'settings' in raw
      const p = hasMode ? (raw.settings || {}) : raw
      const mode = hasMode && raw.mode === 'replace' ? 'replace' : 'merge'
      const next = { ...state }
      const stringFields = ['fontSize', 'density']
      for (const k of stringFields) {
        if (typeof p[k] === 'string') next[k] = p[k]
      }
      if (typeof p.theme === 'string') next.theme = normalizeThemeMode(p.theme)
      if (typeof p.animationsEnabled === 'boolean') next.animationsEnabled = p.animationsEnabled
      if (typeof p.inputHistoryNavigationEnabled === 'boolean') next.inputHistoryNavigationEnabled = p.inputHistoryNavigationEnabled
      if (Array.isArray(p.permissions)) {
        const incomingMap = new Map(p.permissions.map((perm) => [perm.id, !!perm.enabled]))
        if (mode === 'replace') {
          // \u8986\u76d6\u6a21\u5f0f:\u4e0d\u5728\u5bfc\u5165\u6587\u4ef6\u91cc\u7684\u6743\u9650\u9879\u5173\u6389
          next.permissions = state.permissions.map((perm) => ({
            ...perm,
            enabled: incomingMap.has(perm.id) ? incomingMap.get(perm.id) : false,
          }))
        } else {
          // \u5408\u5e76\u6a21\u5f0f:\u4e0d\u5728\u5bfc\u5165\u91cc\u7684\u4fdd\u7559\u539f\u503c
          next.permissions = state.permissions.map((perm) => ({
            ...perm,
            enabled: incomingMap.has(perm.id) ? incomingMap.get(perm.id) : perm.enabled,
          }))
        }
      }
      if (p.skillConfigs && typeof p.skillConfigs === 'object' && !Array.isArray(p.skillConfigs)) {
        next.skillConfigs = mode === 'replace'
          ? { ...p.skillConfigs }
          : { ...state.skillConfigs, ...p.skillConfigs }
      }
      return next
    }

    case 'SET_DRAFT_INPUT': {
      return { ...state, draftInput: action.payload ?? '' }
    }

    case 'SET_SESSION_DRAFT': {
      // payload: { sessionId, text?, attachments? }
      const { sessionId } = action.payload || {}
      if (!sessionId) return state
      const drafts = { ...(state.sessionDrafts || {}) }
      const nextDraft = writeSessionDraft(drafts[sessionId], action.payload)
      if (nextDraft) drafts[sessionId] = nextDraft
      else delete drafts[sessionId]
      return { ...state, sessionDrafts: drafts }
    }

    case 'SET_SKILL_CONFIG': {
      const { skillId, config } = action.payload ?? {}
      if (!skillId) return state
      return {
        ...state,
        skillConfigs: {
          ...state.skillConfigs,
          [skillId]: { ...state.skillConfigs[skillId], ...config },
        },
      }
    }

    case 'RESET_SKILL_CONFIGS': {
      return { ...state, skillConfigs: {} }
    }

    // ★ \u63a8\u7406\u6a21\u578b\u7684\u601d\u8003\u8fc7\u7a0b。\u5355\u72ec\u5b58\u8fdb meta.reasoning,\u7edd\u4e0d\u6df7\u8fdb content ——
    // \u5b83\u4e0d\u662f\u56de\u7b54,\u4e0d\u8be5\u8fdb\u6b63\u6587,\u4e5f\u4e0d\u8be5\u88ab\u5f53\u6210\u4e0a\u4e0b\u6587\u53d1\u56de\u7ed9\u6a21\u578b。

    case 'OPEN_PREVIEW_ARTIFACT': {
      // payload: { messageId, content, preview }
      if (!action.payload) return mergePreviewTabState(state, { tabs: [], activeId: '' })
      return mergePreviewTabState(
        state,
        upsertPreviewTab(currentPreviewTabState(state), action.payload),
      )
    }

    case 'ACTIVATE_PREVIEW_TAB': {
      return mergePreviewTabState(
        state,
        activatePreviewTab(currentPreviewTabState(state), String(action.payload || '')),
      )
    }

    case 'CLOSE_PREVIEW_TAB': {
      return mergePreviewTabState(
        state,
        removePreviewTab(currentPreviewTabState(state), String(action.payload || '')),
      )
    }

    case 'CLOSE_PREVIEW_ARTIFACT': {
      return mergePreviewTabState(state, { tabs: [], activeId: '' })
    }

    case 'SET_TOOLS_CONFIG': {
      const next = { ...(state.toolsConfig || {}), ...(action.payload || {}) }
      return { ...state, toolsConfig: next }
    }

    case 'SET_AGENT_MODE': {
      const mode = ['chat', 'plan', 'code'].includes(action.payload) ? action.payload : 'chat'
      return { ...state, agentMode: mode }
    }

    // Feature 8: Todo \u8ffd\u8e2a — \u6574\u7ec4\u66ff\u6362\u5f53\u524d\u4f1a\u8bdd\u7684 todos

    case 'SET_TODOS': {
      // payload: { sessionId?, todos } — \u4e0d\u6307\u5b9a sessionId \u7528 activeSessionId
      const targetId = action.payload?.sessionId || state.activeSessionId
      if (!targetId) return state
      const todos = Array.isArray(action.payload?.todos) ? action.payload.todos : []
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === targetId
            ? { ...s, todos, updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'CLEAR_TODOS': {
      const targetId = action.payload?.sessionId || state.activeSessionId
      if (!targetId) return state
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === targetId
            ? { ...s, todos: [], updatedAt: Date.now() }
            : s
        ),
      }
    }

    default:
      return null
  }
}

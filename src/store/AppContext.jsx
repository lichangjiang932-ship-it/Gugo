import { createContext, useContext, useReducer, useEffect } from 'react'
import { PERMISSIONS } from '../data.js'

const STORAGE_KEY = 'your-model-atelier:state:v1'

// ── 哪些字段需要持久化（避免把临时 UI 状态也存了）──
const PERSIST_KEYS = [
  'user',
  'isLoggedIn',
  'sessions',
  'activeSessionId',
  'tasks',
  'history',
  'permissions',
  'theme',
  'accentColor',
  'fontSize',
  'density',
  'animationsEnabled',
  'skillConfigs',
  'toolsConfig',
]

function createInitialState() {
  return {
    user: { name: null, email: null, avatar: null, plan: null, joinedAt: null, totalCalls: 0 },
    isLoggedIn: false,
    sessions: [],
    activeSessionId: null,
    tasks: [],
    history: [],
    permissions: PERMISSIONS.map((p) => ({ ...p, enabled: false, icon: p.icon ?? null })),
    permRequest: null,
    theme: 'system',
    accentColor: '#E86A3C',
    fontSize: 'medium',
    density: 'comfortable',
    animationsEnabled: true,
    draftInput: '',
    skillConfigs: {}, // { skillId: { enabled, systemPrompt, temperature, maxTokens } }
    previewArtifact: null, // { messageId, content, preview } — 右侧 artifact 预览面板
    toolsConfig: { web_search: false, fetch_url: false, run_js: false }, // 工具开关
  }
}

function loadPersistedState() {
  if (typeof window === 'undefined') return createInitialState()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return createInitialState()
    const saved = JSON.parse(raw)
    const base = createInitialState()
    const merged = { ...base }
    for (const key of PERSIST_KEYS) {
      if (saved[key] !== undefined) merged[key] = saved[key]
    }
    // 权限定义可能升级，按 id 合并保留 enabled 状态
    if (Array.isArray(saved.permissions)) {
      const enabledMap = new Map(saved.permissions.map((p) => [p.id, !!p.enabled]))
      merged.permissions = base.permissions.map((p) => ({
        ...p,
        enabled: enabledMap.has(p.id) ? enabledMap.get(p.id) : p.enabled,
      }))
    }
    return merged
  } catch (err) {
    console.warn('[AppContext] failed to load persisted state:', err)
    return createInitialState()
  }
}

const initialState = loadPersistedState()

function reducer(state, action) {
  switch (action.type) {
    case 'LOGIN': {
      const payload = action.payload ?? {}
      // 登录成功后若没有任何会话，自动建一个，这样 /chat 一进就能发消息
      let nextSessions = state.sessions
      let nextActiveId = state.activeSessionId
      if (nextSessions.length === 0) {
        const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const now = Date.now()
        nextSessions = [{ id, title: '新对话', messages: [], createdAt: now, updatedAt: now }]
        nextActiveId = id
      } else if (!nextActiveId) {
        nextActiveId = nextSessions[0].id
      }
      return {
        ...state,
        user: {
          name: payload.name ?? state.user.name,
          email: payload.email ?? state.user.email,
          avatar: payload.avatar ?? state.user.avatar,
          plan: payload.plan ?? state.user.plan,
          joinedAt: payload.joinedAt ?? state.user.joinedAt ?? Date.now(),
          totalCalls: payload.totalCalls ?? state.user.totalCalls ?? 0,
        },
        isLoggedIn: true,
        sessions: nextSessions,
        activeSessionId: nextActiveId,
      }
    }

    case 'LOGOUT': {
      return {
        ...state,
        user: { name: null, email: null, avatar: null, plan: null, joinedAt: null, totalCalls: 0 },
        isLoggedIn: false,
      }
    }

    case 'NEW_SESSION': {
      const title = action.payload ?? `新会话 ${new Date().toLocaleTimeString()}`
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const now = Date.now()
      const newSession = {
        id,
        title,
        messages: [],
        createdAt: now,
        updatedAt: now,
      }
      return {
        ...state,
        sessions: [newSession, ...state.sessions],
        activeSessionId: id,
      }
    }

    case 'SWITCH_SESSION': {
      const id = action.payload
      if (!id) return state
      const exists = state.sessions.some((s) => s.id === id)
      return exists ? { ...state, activeSessionId: id } : state
    }

    case 'DELETE_SESSION': {
      const id = action.payload
      const filtered = state.sessions.filter((s) => s.id !== id)
      let nextActiveId = state.activeSessionId
      if (state.activeSessionId === id) {
        nextActiveId = filtered[0]?.id ?? null
      }
      return {
        ...state,
        sessions: filtered,
        activeSessionId: nextActiveId,
      }
    }

    case 'SEND_MESSAGE': {
      const content =
        typeof action.payload === 'string'
          ? action.payload
          : action.payload?.content ?? ''
      if (!state.activeSessionId) return state

      const userMsg = {
        id: crypto.randomUUID?.() ?? `${Date.now()}-u`,
        role: 'user',
        content,
        timestamp: Date.now(),
      }

      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === state.activeSessionId
            ? { ...s, messages: [...s.messages, userMsg], updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'RECEIVE_MESSAGE': {
      const content =
        typeof action.payload === 'string'
          ? action.payload
          : action.payload?.content ?? ''
      const meta = typeof action.payload === 'object' ? action.payload?.meta ?? null : null
      if (!state.activeSessionId) return state

      const assistantMsg = {
        id: crypto.randomUUID?.() ?? `${Date.now() + 1}-a`,
        role: 'assistant',
        content,
        meta,
        timestamp: Date.now() + 1,
      }

      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === state.activeSessionId
            ? { ...s, messages: [...s.messages, assistantMsg], updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'CLEAR_CURRENT_SESSION': {
      if (!state.activeSessionId) return state
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === state.activeSessionId
            ? { ...s, messages: [], updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'COMPRESS_CURRENT_SESSION': {
      if (!state.activeSessionId) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== state.activeSessionId || s.messages.length <= 8) return s
          const older = s.messages.slice(0, -6)
          const recent = s.messages.slice(-6)
          const summary = older
            .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${(m.content || '').slice(0, 180)}`)
            .join('\n')
            .slice(0, 1800)
          return {
            ...s,
            messages: [
              {
                id: crypto.randomUUID?.() ?? `${Date.now()}-summary`,
                role: 'assistant',
                content: `已压缩较早上下文，保留摘要供后续参考：\n\n${summary}`,
                meta: { type: 'context_summary', compressedCount: older.length },
                timestamp: Date.now(),
              },
              ...recent,
            ],
            updatedAt: Date.now(),
          }
        }),
      }
    }

    case 'ADD_TASK': {
      const task = {
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: '',
        detail: '',
        status: 'pending',
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

    case 'SET_THEME': {
      return { ...state, theme: action.payload }
    }

    case 'SET_ACCENT': {
      return { ...state, accentColor: action.payload }
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

    case 'SET_DRAFT_INPUT': {
      return { ...state, draftInput: action.payload ?? '' }
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

    case 'APPEND_TO_LAST_MESSAGE': {
      if (!state.activeSessionId) return state
      const delta = action.payload ?? ''
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== state.activeSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last.role !== 'assistant') return s
          msgs[msgs.length - 1] = { ...last, content: last.content + delta }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'UPDATE_LAST_MESSAGE_META': {
      if (!state.activeSessionId) return state
      const meta = action.payload ?? {}
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== state.activeSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last.role !== 'assistant') return s
          msgs[msgs.length - 1] = { ...last, meta: { ...last.meta, ...meta } }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'UPDATE_SESSION_TITLE': {
      if (!state.activeSessionId) return state
      const title = action.payload ?? '新对话'
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === state.activeSessionId ? { ...s, title, updatedAt: Date.now() } : s
        ),
      }
    }

    case 'TRUNCATE_MESSAGES': {
      if (!state.activeSessionId) return state
      const keepCount = action.payload ?? 0
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === state.activeSessionId
            ? { ...s, messages: s.messages.slice(0, keepCount), updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'OPEN_PREVIEW_ARTIFACT': {
      // payload: { messageId, content, preview }
      return { ...state, previewArtifact: action.payload ?? null }
    }

    case 'CLOSE_PREVIEW_ARTIFACT': {
      return { ...state, previewArtifact: null }
    }

    case 'SET_TOOLS_CONFIG': {
      const next = { ...(state.toolsConfig || {}), ...(action.payload || {}) }
      return { ...state, toolsConfig: next }
    }

    case 'APPEND_TOOL_CALL_TO_LAST_MESSAGE': {
      // payload: { id, name, arguments, status: 'running'|'success'|'error', result, error }
      if (!state.activeSessionId) return state
      const entry = action.payload
      if (!entry) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== state.activeSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last.role !== 'assistant') return s
          const existingMeta = last.meta || {}
          const existingCalls = Array.isArray(existingMeta.toolCalls) ? existingMeta.toolCalls : []
          const idx = existingCalls.findIndex((c) => c.id === entry.id)
          let nextCalls
          if (idx === -1) {
            nextCalls = [...existingCalls, entry]
          } else {
            nextCalls = existingCalls.slice()
            nextCalls[idx] = { ...nextCalls[idx], ...entry }
          }
          msgs[msgs.length - 1] = { ...last, meta: { ...existingMeta, toolCalls: nextCalls } }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    default:
      return state
  }
}

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  // 持久化：state 变化时把白名单字段写回 localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const toSave = {}
      for (const key of PERSIST_KEYS) {
        toSave[key] = state[key]
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
    } catch (err) {
      // QuotaExceeded 等异常静默处理
      console.warn('[AppContext] failed to persist state:', err)
    }
  }, [state])

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  )
}

// 暴露给外部（如 SettingsView "清空全部数据"）调用
// eslint-disable-next-line react-refresh/only-export-components
export function clearPersistedState() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppContext() {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error('useAppContext must be used within <AppProvider>')
  }
  return ctx
}

import { createContext, useCallback, useContext, useReducer, useEffect, useRef, useState } from 'react'
import { PERMISSIONS } from '../data.js'
import { persistWithDegradation, sanitizeForPersist } from './persistDegradation.js'
import { TASK_STATUS } from './taskStatus.js'
import { withSessionModel } from '../lib/modelSelection.js'
import { normalizeThemeMode } from '../lib/themeMode.js'
import { backfillMessageTimestamps } from '../lib/messageTime.js'
import {
  buildSyncMetadata,
  markConvergedMetadata,
  mergePersistedSnapshots,
  persistedSnapshotsEqual,
  readPersistedPayload,
  withSyncMetadata,
} from './stateSync.js'
import {
  LEGACY_STATE_STORAGE_KEY,
  PERSIST_KEYS,
  STATE_SYNC_CHANNEL_NAME,
  STATE_SYNC_SIGNAL_KEY,
  clearLocalPersistence,
  publishStateSyncSignal,
  readBootstrapPayloads,
  readStateSyncSignal,
  removeLegacySnapshot,
  selectPersistedSnapshot,
  writeLightweightSnapshot,
  writeStateClearEpoch,
} from './appStatePersistence.js'
import {
  clearPersistedSnapshot,
  readPersistedSnapshot,
  writePersistedSnapshot,
} from './indexedDbPersistence.js'

const TAB_INSTANCE_ID = globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
const ACTIVE_PERSISTENCE_CONTROLLERS = new Set()

// ── 哪些字段需要持久化（避免把临时 UI 状态也存了）──
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
    choiceRequest: null, // { text, options } — 模型发出的 [[choice:...]] 选择请求
    theme: 'system',
    accentColor: '#E86A3C',
    strongAccent: false,
    fontSize: 'medium',
    density: 'comfortable',
    animationsEnabled: true,
    draftInput: '',
    newDraftVersion: 0,
    skillConfigs: {}, // { skillId: { enabled, systemPrompt, temperature, maxTokens } }
    agentMode: 'chat', // 'chat' | 'plan' | 'code'
    previewArtifact: null, // { messageId, content, preview } — 右侧 artifact 预览面板
    toolsConfig: { web_search: false, fetch_url: false, create_pptx: true, create_docx: true, create_xlsx: true, create_react_component: true, create_mermaid: true, create_chart: true, create_svg: true, create_html_app: true, Agent: true, list_directory: false, read_file: false, write_file: false, edit_file: false, bash_exec: false, git_status: false, git_diff: false, run_project_check: false, manage_todos: true }, // tool toggles
    // #13 切会话保草稿:每个 sessionId → 该会话当前未发送的输入文本
    // 不放进 sessions[].draft 是为了切会话只 dispatch 一个轻动作,不动整棵 sessions 树
    sessionDrafts: {},
    persistenceNotice: null,
  }
}

function normalizePersistedFields(saved, { cancelRunningTasks = false } = {}) {
  const base = createInitialState()
  const normalized = {}
  for (const key of PERSIST_KEYS) {
    if (saved?.[key] !== undefined) normalized[key] = saved[key]
  }
  if (normalized.theme !== undefined) normalized.theme = normalizeThemeMode(normalized.theme)
  if (saved?.toolsConfig && typeof saved.toolsConfig === 'object') {
    normalized.toolsConfig = { ...base.toolsConfig, ...saved.toolsConfig }
  }
  if (normalized.sessions !== undefined) normalized.sessions = backfillMessageTimestamps(normalized.sessions)
  if (Array.isArray(saved?.permissions)) {
    const enabledMap = new Map(saved.permissions.map((permission) => [permission.id, !!permission.enabled]))
    normalized.permissions = base.permissions.map((permission) => ({
      ...permission,
      enabled: enabledMap.has(permission.id) ? enabledMap.get(permission.id) : permission.enabled,
    }))
  }
  if (cancelRunningTasks && Array.isArray(normalized.tasks)) {
    normalized.tasks = normalized.tasks.map((task) => (
      task?.status === 'running'
        ? { ...task, status: 'cancelled', stepLabel: '已中断（页面刷新）' }
        : task
    ))
  }
  return normalized
}

function getLocalStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch (error) {
    console.warn('[AppContext] localStorage unavailable:', error?.name || error)
    return null
  }
}

function readBootstrapState() {
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

function completeSnapshot(saved, options) {
  const base = createInitialState()
  return selectPersistedSnapshot({ ...base, ...normalizePersistedFields(saved, options) })
}

function indexedDbNoticeResult(result) {
  if (result?.ok) return { ok: true, level: 'full' }
  if (result?.status === 'quota') return { ok: false, level: 'quota', error: result.error }
  return { ok: false, level: 'error', error: result?.error }
}

function reducer(state, action) {
  switch (action.type) {
    case 'LOGIN': {
      const payload = action.payload ?? {}
      const nextActiveId = state.sessions.some((session) => session.id === state.activeSessionId)
        ? state.activeSessionId
        : state.sessions[0]?.id ?? null
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
      const title = action.payload?.title ?? action.payload ?? `新会话 ${new Date().toLocaleTimeString()}`
      const agentId = typeof action.payload === 'object' && action.payload ? (action.payload.agentId || null) : null
      const requestedId = typeof action.payload === 'object' && action.payload ? action.payload.id : null
      const id = requestedId || crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const now = Date.now()
      const newSession = {
        id,
        title,
        messages: [],
        createdAt: now,
        updatedAt: now,
        agentId, // 阶段 6：session sticky agent。null 表示跟随全局 active agent
      }
      return {
        ...state,
        sessions: [newSession, ...state.sessions],
        activeSessionId: id,
      }
    }
    case 'START_NEW_DRAFT': {
      return {
        ...state,
        activeSessionId: null,
        newDraftVersion: state.newDraftVersion + 1,
      }
    }
    case 'SET_SESSION_AGENT': {
      const { sessionId, agentId } = action.payload || {}
      if (!sessionId) return state
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, agentId: agentId || null, updatedAt: Date.now() } : s,
        ),
      }
    }

    case 'SET_SESSION_MODEL': {
      const { sessionId, modelName } = action.payload || {}
      const sessions = withSessionModel(state.sessions, sessionId, modelName)
      return sessions === state.sessions ? state : { ...state, sessions }
    }

    case 'SWITCH_SESSION': {
      const id = action.payload
      if (!id) return state
      const exists = state.sessions.some((s) => s.id === id)
      if (!exists) return state
      // ★ #22: 切到该会话即视为已读 — 写入 lastViewedAt
      return {
        ...state,
        activeSessionId: id,
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, lastViewedAt: Date.now() } : s
        ),
      }
    }

    case 'DELETE_SESSION': {
      const id = action.payload
      const filtered = state.sessions.filter((s) => s.id !== id)
      let nextActiveId = state.activeSessionId
      if (state.activeSessionId === id) {
        nextActiveId = filtered[0]?.id ?? null
      }
      // 同步清掉这个会话的草稿,免得 sessionDrafts 越积越多
      const nextDrafts = { ...(state.sessionDrafts || {}) }
      delete nextDrafts[id]
      return {
        ...state,
        sessions: filtered,
        activeSessionId: nextActiveId,
        sessionDrafts: nextDrafts,
      }
    }

    case 'ARCHIVE_SESSION': {
      const id = action.payload
      if (!id) return state
      const now = Date.now()
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, archivedAt: s.archivedAt || now, updatedAt: now } : s
        ),
      }
    }

    case 'UNARCHIVE_SESSION': {
      const id = action.payload
      if (!id) return state
      const now = Date.now()
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, archivedAt: null, updatedAt: now } : s
        ),
      }
    }

    case 'SEND_MESSAGE': {
      const payload = action.payload
      let content = typeof payload === 'string' ? payload : payload?.content ?? ''
      const msgAttachments = typeof payload === 'string' ? [] : payload?.attachments || []
      if (msgAttachments.length > 0) {
        const attachmentInfo = msgAttachments.map((a) => `[附件: ${a.name}, ${a.sizeKB} KB]`).join('\n')
        content = content ? `${content}\n\n${attachmentInfo}` : `请分析附件：${msgAttachments.map((a) => a.name).join('、')}`
      }
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
      const targetSessionId = action.payload?.sessionId || state.activeSessionId
      if (!targetSessionId) return state

      const assistantMsg = {
        id: action.payload?.id || crypto.randomUUID?.() || `${Date.now() + 1}-a`,
        role: 'assistant',
        content,
        meta,
        timestamp: Date.now() + 1,
      }

      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === targetSessionId
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

    // ★ #10: 删除单条消息 — payload: messageId
    case 'DELETE_MESSAGE': {
      if (!state.activeSessionId) return state
      const msgId = action.payload
      if (!msgId) return state
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === state.activeSessionId
            ? { ...s, messages: s.messages.filter((m) => m.id !== msgId), updatedAt: Date.now() }
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

    case 'SET_ACCENT': {
      return { ...state, accentColor: action.payload }
    }

    case 'SET_STRONG_ACCENT': {
      return { ...state, strongAccent: !!action.payload }
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

    case 'IMPORT_SESSIONS': {
      // payload: 已经过 schema 校验的 sessions 数组
      const incoming = Array.isArray(action.payload) ? action.payload : []
      // id 冲突时把导入项重新分配 id,避免覆盖
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
      // ★ #26: 支持 merge / replace 两种模式 (默认 merge,向后兼容)
      // payload 可以是 { settings, mode } 或老格式直接传 settings
      const raw = action.payload || {}
      const hasMode = raw && typeof raw === 'object' && 'mode' in raw && 'settings' in raw
      const p = hasMode ? (raw.settings || {}) : raw
      const mode = hasMode && raw.mode === 'replace' ? 'replace' : 'merge'
      const next = { ...state }
      const stringFields = ['accentColor', 'fontSize', 'density']
      for (const k of stringFields) {
        if (typeof p[k] === 'string') next[k] = p[k]
      }
      if (typeof p.theme === 'string') next.theme = normalizeThemeMode(p.theme)
      if (typeof p.animationsEnabled === 'boolean') next.animationsEnabled = p.animationsEnabled
      if (typeof p.strongAccent === 'boolean') next.strongAccent = p.strongAccent
      if (Array.isArray(p.permissions)) {
        const incomingMap = new Map(p.permissions.map((perm) => [perm.id, !!perm.enabled]))
        if (mode === 'replace') {
          // 覆盖模式:不在导入文件里的权限项关掉
          next.permissions = state.permissions.map((perm) => ({
            ...perm,
            enabled: incomingMap.has(perm.id) ? incomingMap.get(perm.id) : false,
          }))
        } else {
          // 合并模式:不在导入里的保留原值
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
      // payload: { sessionId, text }
      const { sessionId, text } = action.payload || {}
      if (!sessionId) return state
      const drafts = { ...(state.sessionDrafts || {}) }
      const t = text ?? ''
      if (t) drafts[sessionId] = t
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

    // ★ 推理模型的思考过程。单独存进 meta.reasoning,绝不混进 content ——
    // 它不是回答,不该进正文,也不该被当成上下文发回给模型。
    case 'APPEND_REASONING_TO_LAST_MESSAGE': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const delta = action.payload ?? ''
      if (!delta) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          const meta = last.meta || {}
          msgs[messageIndex] = {
            ...last,
            meta: { ...meta, reasoning: (meta.reasoning || '') + delta },
          }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'APPEND_TO_LAST_MESSAGE': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const delta = action.payload ?? ''
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          msgs[messageIndex] = { ...last, content: last.content + delta }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'UPDATE_LAST_MESSAGE_META': {
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const meta = action.payload ?? {}
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          msgs[messageIndex] = { ...last, meta: { ...last.meta, ...meta } }
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

    // ★ #8: 按指定 sessionId 改名 (用于异步 AI 标题回填),
    //   onlyIfMatches: 当前标题必须等于这个值才覆盖, 否则跳过 (防止用户已手动改名时被覆盖)
    case 'UPDATE_SESSION_TITLE_FOR': {
      const { sessionId, title, onlyIfMatches } = action.payload || {}
      if (!sessionId || !title) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== sessionId) return s
          if (onlyIfMatches !== undefined && s.title !== onlyIfMatches) return s
          return { ...s, title, updatedAt: Date.now() }
        }),
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

    case 'SET_AGENT_MODE': {
      const mode = ['chat', 'plan', 'code'].includes(action.payload) ? action.payload : 'chat'
      return { ...state, agentMode: mode }
    }

    // Feature 8: Todo 追踪 — 整组替换当前会话的 todos
    case 'SET_TODOS': {
      // payload: { sessionId?, todos } — 不指定 sessionId 用 activeSessionId
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

    case 'COMPACT_SESSION': {
      const targetId = action.payload?.sessionId || state.activeSessionId
      const messages = Array.isArray(action.payload?.messages) ? action.payload.messages : null
      if (!targetId || !messages) return state
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === targetId
            ? { ...s, messages, updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'EXPAND_COMPACTED': {
      const targetId = action.payload?.sessionId || state.activeSessionId
      const archiveId = action.payload?.archiveId
      const archivedMessages = Array.isArray(action.payload?.archivedMessages) ? action.payload.archivedMessages : []
      if (!targetId || !archiveId || archivedMessages.length === 0) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetId) return s
          const nextMessages = []
          for (const msg of s.messages) {
            if (msg?.meta?.archiveId === archiveId || msg?.meta?.compactionArchiveId === archiveId) {
              nextMessages.push(...archivedMessages)
            } else {
              nextMessages.push(msg)
            }
          }
          return { ...s, messages: nextMessages, updatedAt: Date.now() }
        }),
      }
    }

    case 'APPEND_TOOL_CALL_TO_LAST_MESSAGE': {
      // payload: { id, name, arguments, status, result, error, approvalAuthorization }
      const targetSessionId = action.sessionId || state.activeSessionId
      if (!targetSessionId) return state
      const entry = action.payload
      if (!entry) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const messageIndex = action.messageId ? msgs.findIndex((message) => message.id === action.messageId) : msgs.length - 1
          if (messageIndex < 0) return s
          const last = msgs[messageIndex]
          if (last.role !== 'assistant') return s
          const existingMeta = last.meta || {}
          const existingCalls = Array.isArray(existingMeta.toolCalls) ? existingMeta.toolCalls : []
          const idx = existingCalls.findIndex((c) => c.id === entry.id)
          let nextCalls
          if (idx === -1) {
            // ★ 记下这次工具调用发生时正文已经写到哪 —— 有了这个锚点,
            // 渲染时才能把「说的话」和「做的事」按真实先后顺序交错排列。
            // 以前只存一个 toolCalls 数组,渲染只能整块堆在正文前面,
            // 用户读起来就是「先给结论后干活」,顺序是反的。
            nextCalls = [...existingCalls, { ...entry, textOffset: (last.content || '').length }]
          } else {
            nextCalls = existingCalls.slice()
            nextCalls[idx] = { ...nextCalls[idx], ...entry }
          }
          msgs[messageIndex] = { ...last, meta: { ...existingMeta, toolCalls: nextCalls } }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
    }

    case 'MERGE_EXTERNAL_STATE': {
      const payload = action.payload || {}
      let changed = false
      const next = { ...state }
      for (const key of PERSIST_KEYS) {
        if (payload[key] !== undefined && payload[key] !== state[key]) {
          next[key] = payload[key]
          changed = true
        }
      }
      return changed ? next : state
    }

    case 'SET_PERSISTENCE_NOTICE': {
      const notice = action.payload || null
      if (state.persistenceNotice?.level === notice?.level) return state
      return { ...state, persistenceNotice: notice }
    }

    default:
      return state
  }
}

const AppContext = createContext(null)

function reportPersistenceResult(dispatch, result) {
  if (result.ok && result.level === 'full') {
    dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: null })
  } else if (result.level === 'compact-metadata') {
    dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'compact-metadata' } })
  } else if (result.level === 'quota') {
    dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'quota' } })
  } else if (!result.ok) {
    dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'unavailable' } })
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, readBootstrapState)
  const [hydrated, setHydrated] = useState(typeof window === 'undefined')
  const stateRef = useRef(state)
  const tabIdRef = useRef(TAB_INSTANCE_ID)
  const lastSnapshotRef = useRef(selectPersistedSnapshot(state))
  const syncMetaRef = useRef({})
  const skipPersistSnapshotRef = useRef(null)
  const backendRef = useRef('hydrating')
  const hydrationPromiseRef = useRef(null)
  const pendingWriteRef = useRef(null)
  const writeLoopRef = useRef(null)
  const clearGenerationRef = useRef(0)
  const lastClearedAtRef = useRef(0)
  const channelRef = useRef(null)
  const mountedRef = useRef(true)

  const publishChange = useCallback((type, payload, writtenAt = Date.now()) => {
    const message = { type, source: tabIdRef.current, writtenAt, payload }
    try {
      channelRef.current?.postMessage(message)
    } catch (error) {
      console.warn('[AppContext] BroadcastChannel publish failed:', error?.name || error)
    }
    const storage = getLocalStorage()
    if (storage) {
      try {
        publishStateSyncSignal(storage, tabIdRef.current, writtenAt, type)
      } catch (error) {
        console.warn('[AppContext] storage sync signal failed:', error?.name || error)
      }
    }
  }, [])

  const persistToLegacy = useCallback((snapshot, meta, { broadcast = true } = {}) => {
    const storage = getLocalStorage()
    if (!storage) {
      const result = { ok: false, level: 'error', error: new Error('localStorage unavailable') }
      if (mountedRef.current) reportPersistenceResult(dispatch, result)
      return result
    }
    const payload = sanitizeForPersist(withSyncMetadata(snapshot, meta))
    const result = persistWithDegradation(payload, (key, value) => storage.setItem(key, value))
    if (mountedRef.current) reportPersistenceResult(dispatch, result)
    if (result.ok) {
      lastSnapshotRef.current = snapshot
      syncMetaRef.current = meta
      if (broadcast) publishChange('updated', payload, meta.writtenAt)
    }
    return result
  }, [publishChange])

  const updateLocalMirrorAfterIndexedDbCommit = useCallback((payload) => {
    const storage = getLocalStorage()
    if (!storage) return
    try {
      // Free the legacy full snapshot first so the small settings mirror cannot fail just
      // because the old value already consumes the localStorage quota.
      removeLegacySnapshot(storage)
    } catch (error) {
      console.warn('[AppContext] legacy snapshot cleanup failed:', error?.name || error)
    }
    try {
      writeLightweightSnapshot(storage, payload)
    } catch (error) {
      console.warn('[AppContext] lightweight settings write failed:', error?.name || error)
    }
  }, [])

  function enqueueIndexedDbWrite(snapshot, meta) {
    pendingWriteRef.current = {
      snapshot,
      meta,
      generation: clearGenerationRef.current,
    }
    if (writeLoopRef.current) return writeLoopRef.current

    const loop = (async () => {
      while (pendingWriteRef.current) {
        const item = pendingWriteRef.current
        pendingWriteRef.current = null
        if (item.generation !== clearGenerationRef.current) continue

        const payload = sanitizeForPersist(withSyncMetadata(item.snapshot, item.meta))
        const result = await writePersistedSnapshot(payload)
        if (item.generation !== clearGenerationRef.current) continue

        if (!result.ok) {
          console.warn('[AppContext] IndexedDB write failed; falling back to localStorage:', result.error?.name || result.status)
          backendRef.current = 'localstorage'
          persistToLegacy(item.snapshot, item.meta)
          continue
        }

        lastSnapshotRef.current = item.snapshot
        syncMetaRef.current = item.meta
        updateLocalMirrorAfterIndexedDbCommit(payload)
        if (mountedRef.current) reportPersistenceResult(dispatch, indexedDbNoticeResult(result))
        publishChange('updated', payload, item.meta.writtenAt)
      }
    })().catch((error) => {
      console.error('[AppContext] persistence queue failed:', error)
    }).finally(() => {
      writeLoopRef.current = null
      if (pendingWriteRef.current) enqueueIndexedDbWrite(
        pendingWriteRef.current.snapshot,
        pendingWriteRef.current.meta,
      )
    })
    writeLoopRef.current = loop
    return loop
  }

  const loadHydratedPersistence = useCallback(async () => {
    const storage = getLocalStorage()
    let bootstrap = { settings: null, legacy: null, clearedAt: 0 }
    if (storage) {
      try {
        bootstrap = readBootstrapPayloads(storage, 0)
      } catch (error) {
        console.warn('[AppContext] bootstrap payload read failed:', error?.name || error)
      }
    }

    const clearedAt = Number(bootstrap.clearedAt) || 0
    lastClearedAtRef.current = Math.max(lastClearedAtRef.current, clearedAt)
    if (clearedAt > 0) {
      const writtenBeforeClear = (entry) => entry && (Number(entry.meta?.writtenAt) || 0) <= clearedAt
      if (writtenBeforeClear(bootstrap.settings)) bootstrap.settings = null
      if (writtenBeforeClear(bootstrap.legacy)) bootstrap.legacy = null
    }

    let durable = await readPersistedSnapshot()
    let migrationFailed = false
    if (durable.ok && durable.payload && clearedAt > 0) {
      try {
        const candidate = readPersistedPayload(durable.payload, durable.updatedAt || 0)
        if ((Number(candidate.meta?.writtenAt) || 0) <= clearedAt) {
          const staleClear = await clearPersistedSnapshot()
          if (!staleClear.ok && staleClear.status !== 'unavailable') {
            console.warn('[AppContext] stale IndexedDB snapshot cleanup failed:', staleClear.error?.name || staleClear.status)
          }
          durable = { ...durable, payload: null, updatedAt: null }
        }
      } catch {
        // The normal parsing path below reports malformed snapshots and tries fallbacks.
      }
    }
    const hasMigrationMarker = bootstrap.settings?.snapshot?.__persistence?.durableStore === 'indexeddb'
    if (durable.ok && !durable.payload && !bootstrap.legacy && hasMigrationMarker) {
      // Another tab may have committed IndexedDB and removed the legacy key between our two reads.
      durable = await readPersistedSnapshot()
    }

    if (durable.ok && durable.payload) {
      try {
        const parsed = readPersistedPayload(durable.payload, durable.updatedAt || 0)
        const durableSnapshot = completeSnapshot({ ...(bootstrap.settings?.snapshot || {}), ...parsed.snapshot })

        if (bootstrap.legacy) {
          const legacySnapshot = completeSnapshot({
            ...bootstrap.legacy.snapshot,
            ...(bootstrap.settings?.snapshot || {}),
          })
          const reconciled = mergePersistedSnapshots(
            durableSnapshot,
            parsed.meta,
            legacySnapshot,
            bootstrap.legacy.meta,
          )
          const previousSnapshot = reconciled.snapshot
          const snapshot = completeSnapshot(previousSnapshot, { cancelRunningTasks: true })
          const meta = persistedSnapshotsEqual(snapshot, previousSnapshot)
            ? reconciled.meta
            : buildSyncMetadata(snapshot, previousSnapshot, reconciled.meta, { source: tabIdRef.current })
          const payload = sanitizeForPersist(withSyncMetadata(snapshot, meta))
          const committed = await writePersistedSnapshot(payload)
          if (committed.ok) {
            updateLocalMirrorAfterIndexedDbCommit(payload)
            return {
              backend: 'indexeddb',
              snapshot,
              previousSnapshot: snapshot,
              meta,
              skipInitialWrite: true,
            }
          }

          // The legacy snapshot may contain changes newer than the stale IndexedDB record.
          // Preserve the reconciled union in the fallback store instead of selecting old IDB.
          persistToLegacy(snapshot, meta, { broadcast: false })
          return {
            backend: 'localstorage',
            snapshot,
            previousSnapshot: snapshot,
            meta,
            skipInitialWrite: true,
          }
        }

        const previousSnapshot = durableSnapshot
        const snapshot = completeSnapshot(durableSnapshot, { cancelRunningTasks: true })
        return {
          backend: 'indexeddb',
          snapshot,
          previousSnapshot,
          meta: parsed.meta,
          skipInitialWrite: persistedSnapshotsEqual(snapshot, previousSnapshot),
        }
      } catch (error) {
        console.warn('[AppContext] invalid IndexedDB snapshot; trying legacy data:', error)
      }
    }

    if (durable.ok && bootstrap.legacy) {
      const combined = { ...bootstrap.legacy.snapshot, ...(bootstrap.settings?.snapshot || {}) }
      const previousSnapshot = completeSnapshot(combined)
      const snapshot = completeSnapshot(combined, { cancelRunningTasks: true })
      const meta = buildSyncMetadata(snapshot, previousSnapshot, bootstrap.legacy.meta, {
        source: tabIdRef.current,
      })
      const payload = sanitizeForPersist(withSyncMetadata(snapshot, meta))
      const migrated = await writePersistedSnapshot(payload)
      if (migrated.ok) {
        updateLocalMirrorAfterIndexedDbCommit(payload)
        return {
          backend: 'indexeddb',
          snapshot,
          previousSnapshot: snapshot,
          meta,
          skipInitialWrite: true,
        }
      }
      console.warn('[AppContext] IndexedDB migration failed; preserving legacy snapshot:', migrated.error?.name || migrated.status)
      migrationFailed = true
    }

    const fallback = bootstrap.legacy || bootstrap.settings
    const combined = fallback?.snapshot || {}
    const previousSnapshot = completeSnapshot(combined)
    const snapshot = completeSnapshot(combined, { cancelRunningTasks: true })
    return {
      backend: durable.ok && !migrationFailed ? 'indexeddb' : 'localstorage',
      snapshot,
      previousSnapshot,
      meta: fallback?.meta || {},
      skipInitialWrite: persistedSnapshotsEqual(snapshot, previousSnapshot),
      unavailable: !durable.ok && !storage,
    }
  }, [persistToLegacy, updateLocalMirrorAfterIndexedDbCommit])

  function applyRemotePayload(payload, fallbackTimestamp = Date.now()) {
    let remote
    try {
      remote = readPersistedPayload(payload, fallbackTimestamp)
    } catch {
      return
    }
    if (remote.meta.source && remote.meta.source === tabIdRef.current) return
    const remoteWrittenAt = Number(remote.meta.writtenAt) || Number(fallbackTimestamp) || 0
    if (lastClearedAtRef.current > 0 && remoteWrittenAt <= lastClearedAtRef.current) return

    const currentSnapshot = selectPersistedSnapshot(stateRef.current)
    const normalizedRemote = completeSnapshot(remote.snapshot)
    const merged = mergePersistedSnapshots(
      currentSnapshot,
      syncMetaRef.current,
      normalizedRemote,
      remote.meta,
      { preserveLocalFields: ['activeSessionId'] },
    )
    const stateChanged = !persistedSnapshotsEqual(currentSnapshot, merged.snapshot)
    const needsConvergenceWrite = !persistedSnapshotsEqual(normalizedRemote, merged.snapshot, ['activeSessionId'])

    lastSnapshotRef.current = merged.snapshot
    syncMetaRef.current = merged.meta
    if (stateChanged) {
      skipPersistSnapshotRef.current = merged.snapshot
      stateRef.current = { ...stateRef.current, ...merged.snapshot }
      dispatch({ type: 'MERGE_EXTERNAL_STATE', payload: merged.snapshot })
    }
    if (needsConvergenceWrite) {
      const convergenceMeta = markConvergedMetadata(merged.meta, tabIdRef.current)
      if (backendRef.current === 'indexeddb') {
        enqueueIndexedDbWrite(merged.snapshot, convergenceMeta)
      } else {
        persistToLegacy(merged.snapshot, convergenceMeta)
      }
    }
  }

  async function applyExternalClear(writtenAt = Date.now()) {
    const requestedClearAt = Number(writtenAt) || Date.now()
    lastClearedAtRef.current = Math.max(lastClearedAtRef.current, requestedClearAt)
    clearGenerationRef.current += 1
    pendingWriteRef.current = null
    while (writeLoopRef.current) await writeLoopRef.current
    // A write already in flight when the clear signal arrived may have landed after the sender's delete.
    const durableResult = await clearPersistedSnapshot()
    if (!durableResult.ok && durableResult.status !== 'unavailable') {
      console.warn('[AppContext] external IndexedDB clear failed:', durableResult.error?.name || durableResult.status)
      if (mountedRef.current) reportPersistenceResult(dispatch, { ok: false, level: 'error', error: durableResult.error })
    }
    const storage = getLocalStorage()
    if (storage) {
      try {
        clearLocalPersistence(storage, { preserveClearEpoch: true })
      } catch (error) {
        console.warn('[AppContext] local clear failed:', error?.name || error)
      }
    }
    const previousSnapshot = selectPersistedSnapshot(stateRef.current)
    const resetSnapshot = selectPersistedSnapshot(createInitialState())
    const clearMeta = buildSyncMetadata(resetSnapshot, previousSnapshot, syncMetaRef.current, {
      source: tabIdRef.current,
      now: lastClearedAtRef.current,
    })
    lastClearedAtRef.current = Math.max(lastClearedAtRef.current, clearMeta.writtenAt)
    if (storage) {
      try {
        writeStateClearEpoch(storage, lastClearedAtRef.current)
      } catch (error) {
        console.warn('[AppContext] clear epoch write failed:', error?.name || error)
      }
    }
    lastSnapshotRef.current = resetSnapshot
    syncMetaRef.current = clearMeta
    skipPersistSnapshotRef.current = resetSnapshot
    stateRef.current = { ...stateRef.current, ...resetSnapshot }
    dispatch({ type: 'MERGE_EXTERNAL_STATE', payload: resetSnapshot })
  }

  useEffect(() => {
    mountedRef.current = true
    let active = true
    if (!hydrationPromiseRef.current) hydrationPromiseRef.current = loadHydratedPersistence()
    hydrationPromiseRef.current.then((result) => {
      if (!active) return
      backendRef.current = result.backend
      lastSnapshotRef.current = result.previousSnapshot
      syncMetaRef.current = result.meta
      skipPersistSnapshotRef.current = result.skipInitialWrite ? result.snapshot : null
      stateRef.current = { ...stateRef.current, ...result.snapshot }
      dispatch({ type: 'MERGE_EXTERNAL_STATE', payload: result.snapshot })
      if (result.unavailable) {
        dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'unavailable' } })
      }
      setHydrated(true)
    }).catch((error) => {
      if (!active) return
      console.error('[AppContext] persistence hydration failed:', error)
      backendRef.current = 'localstorage'
      dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'unavailable' } })
      setHydrated(true)
    })
    return () => {
      active = false
      mountedRef.current = false
    }
    // StrictMode reuses the same hydration promise across its effect replay.
  }, [loadHydratedPersistence])

  useEffect(() => {
    const controller = {
      async prepareClear() {
        clearGenerationRef.current += 1
        pendingWriteRef.current = null
        while (writeLoopRef.current) await writeLoopRef.current
      },
      publishClear(writtenAt) {
        const resetSnapshot = selectPersistedSnapshot(createInitialState())
        const clearMeta = buildSyncMetadata(
          resetSnapshot,
          selectPersistedSnapshot(stateRef.current),
          syncMetaRef.current,
          { source: tabIdRef.current, now: writtenAt },
        )
        lastClearedAtRef.current = Math.max(lastClearedAtRef.current, clearMeta.writtenAt)
        lastSnapshotRef.current = resetSnapshot
        syncMetaRef.current = clearMeta
        skipPersistSnapshotRef.current = resetSnapshot
        publishChange('cleared', null, lastClearedAtRef.current)
      },
    }
    ACTIVE_PERSISTENCE_CONTROLLERS.add(controller)
    return () => ACTIVE_PERSISTENCE_CONTROLLERS.delete(controller)
  }, [publishChange])

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return undefined

    let channel = null
    if (typeof BroadcastChannel === 'function') {
      try {
        channel = new BroadcastChannel(STATE_SYNC_CHANNEL_NAME)
        channelRef.current = channel
        channel.onmessage = (event) => {
          const message = event.data
          if (!message || message.source === tabIdRef.current) return
          if (message.type === 'cleared') {
            void applyExternalClear(message.writtenAt)
          } else if (message.type === 'updated' && message.payload) {
            applyRemotePayload(message.payload, message.writtenAt)
          }
        }
      } catch (error) {
        console.warn('[AppContext] BroadcastChannel unavailable:', error?.name || error)
      }
    }

    const onStorage = (event) => {
      if (event.storageArea && event.storageArea !== getLocalStorage()) return
      if (event.key === LEGACY_STATE_STORAGE_KEY) {
        // A null value is migration cleanup, never an implicit data-clear command.
        if (event.newValue) applyRemotePayload(event.newValue, Date.now())
        return
      }
      if (event.key !== STATE_SYNC_SIGNAL_KEY || !event.newValue) return
      const signal = readStateSyncSignal(event.newValue)
      if (!signal || signal.source === tabIdRef.current) return
      if (signal.type === 'cleared') {
        void applyExternalClear(signal.writtenAt)
        return
      }
      void readPersistedSnapshot().then((remote) => {
        if (remote.ok && remote.payload) applyRemotePayload(remote.payload, remote.updatedAt || signal.writtenAt)
      })
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      channel?.close()
      if (channelRef.current === channel) channelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  // 持久化：state 变化时把白名单字段写回 localStorage
  // 防容量炸弹:抓到 QuotaExceededError 走逐步降级策略,见 persistWithDegradation.
  //
  // ★ debounce 250ms。原来每次 state 变化都同步全量 JSON 序列化 ——
  // 流式生成时每个 token 都会 dispatch 一次 APPEND_TO_LAST_MESSAGE,
  // 于是一条长回复要把整个 state(所有会话 + 所有消息)序列化几千次。
  // 本地模型吐字慢反而掩盖了这个问题,云端快模型上会明显掉帧。
  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return undefined
    const timer = setTimeout(() => {
      const snapshot = selectPersistedSnapshot(stateRef.current)
      if (skipPersistSnapshotRef.current && persistedSnapshotsEqual(snapshot, skipPersistSnapshotRef.current)) {
        skipPersistSnapshotRef.current = null
        return
      }
      skipPersistSnapshotRef.current = null
      const syncMeta = buildSyncMetadata(snapshot, lastSnapshotRef.current, syncMetaRef.current, {
        source: tabIdRef.current,
        now: Math.max(Date.now(), lastClearedAtRef.current + 1),
      })
      if (backendRef.current === 'indexeddb') {
        enqueueIndexedDbWrite(snapshot, syncMeta)
        return
      }
      const result = persistWithDegradation(withSyncMetadata(snapshot, syncMeta), (key, value) => window.localStorage.setItem(key, value))
      reportPersistenceResult(dispatch, result)
      if (!result.ok) {
        console.error('[AppContext] localStorage 完全不可写:', result.error)
      } else {
        lastSnapshotRef.current = snapshot
        syncMetaRef.current = syncMeta
      }
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, state.user, state.isLoggedIn, state.sessions, state.activeSessionId, state.tasks, state.history, state.permissions, state.theme, state.accentColor, state.strongAccent, state.fontSize, state.density, state.animationsEnabled, state.skillConfigs, state.toolsConfig, state.agentMode, state.sessionDrafts])

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {hydrated ? children : null}
    </AppContext.Provider>
  )
}

// 暴露给外部（如 SettingsView "清空全部数据"）调用
// eslint-disable-next-line react-refresh/only-export-components
export async function clearPersistedState() {
  if (typeof window === 'undefined') return { ok: true }
  try {
    const controllers = [...ACTIVE_PERSISTENCE_CONTROLLERS]
    await Promise.all(controllers.map((controller) => controller.prepareClear()))
    const durableResult = await clearPersistedSnapshot()
    const storage = getLocalStorage()
    if (!durableResult.ok && durableResult.status !== 'unavailable') {
      return { ok: false, reason: durableResult.error?.message || durableResult.status }
    }
    if (!durableResult.ok && !storage) {
      return { ok: false, reason: durableResult.error?.message || durableResult.status }
    }
    if (storage) clearLocalPersistence(storage)
    const writtenAt = Date.now()
    if (controllers.length) {
      for (const controller of controllers) controller.publishClear(writtenAt)
    } else {
      if (storage) publishStateSyncSignal(storage, TAB_INSTANCE_ID, writtenAt, 'cleared')
      if (typeof BroadcastChannel === 'function') {
        const channel = new BroadcastChannel(STATE_SYNC_CHANNEL_NAME)
        channel.postMessage({ type: 'cleared', source: TAB_INSTANCE_ID, writtenAt, payload: null })
        channel.close()
      }
    }
    return { ok: true }
  } catch (err) {
    // Safari 隐私模式 / 用户禁用 storage / iframe 跨源限制 → SecurityError
    console.warn('[AppContext] localStorage 不可写,清除被忽略:', err?.name || err)
    return { ok: false, reason: err?.name === 'SecurityError' ? 'storage-disabled' : (err?.message || 'unknown') }
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

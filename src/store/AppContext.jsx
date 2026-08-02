import { createContext, useContext, useReducer, useEffect } from 'react'
import { PERMISSIONS } from '../data.js'
import { persistWithDegradation } from './persistDegradation.js'
import { TASK_STATUS } from './taskStatus.js'
import { withSessionModel } from '../lib/modelSelection.js'
import { normalizeThemeMode } from '../lib/themeMode.js'
import { backfillMessageTimestamps } from '../lib/messageTime.js'

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
  'strongAccent',
  'fontSize',
  'density',
  'animationsEnabled',
  'skillConfigs',
  'toolsConfig',
  'agentMode',
  'sessionDrafts',
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
    choiceRequest: null, // { text, options } — 模型发出的 [[choice:...]] 选择请求
    theme: 'system',
    accentColor: '#E86A3C',
    strongAccent: false,
    fontSize: 'medium',
    density: 'comfortable',
    animationsEnabled: true,
    draftInput: '',
    skillConfigs: {}, // { skillId: { enabled, systemPrompt, temperature, maxTokens } }
    agentMode: 'chat', // 'chat' | 'plan' | 'code'
    previewArtifact: null, // { messageId, content, preview } — 右侧 artifact 预览面板
    toolsConfig: { web_search: false, fetch_url: false, create_pptx: true, create_docx: true, create_xlsx: true, create_react_component: true, create_mermaid: true, create_chart: true, create_svg: true, create_html_app: true, Agent: true, list_directory: false, read_file: false, write_file: false, edit_file: false, bash_exec: false, git_status: false, git_diff: false, run_project_check: false, manage_todos: true }, // tool toggles
    // #13 切会话保草稿:每个 sessionId → 该会话当前未发送的输入文本
    // 不放进 sessions[].draft 是为了切会话只 dispatch 一个轻动作,不动整棵 sessions 树
    sessionDrafts: {},
  }
}

function loadPersistedState() {
  if (typeof window === 'undefined') return createInitialState()
  let raw
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch (err) {
    // Safari 隐私模式 / 禁用 storage 直接抛 SecurityError
    console.warn('[AppContext] localStorage 不可读,以默认状态启动:', err?.name || err)
    return createInitialState()
  }
  if (!raw) return createInitialState()
  try {
    const saved = JSON.parse(raw)
    const base = createInitialState()
    const merged = { ...base }
    for (const key of PERSIST_KEYS) {
      if (saved[key] !== undefined) merged[key] = saved[key]
    }
    merged.theme = normalizeThemeMode(merged.theme)
    if (saved.toolsConfig && typeof saved.toolsConfig === 'object') {
      merged.toolsConfig = { ...base.toolsConfig, ...saved.toolsConfig }
    }
    merged.sessions = backfillMessageTimestamps(merged.sessions)
    // 权限定义可能升级，按 id 合并保留 enabled 状态
    if (Array.isArray(saved.permissions)) {
      const enabledMap = new Map(saved.permissions.map((p) => [p.id, !!p.enabled]))
      merged.permissions = base.permissions.map((p) => ({
        ...p,
        enabled: enabledMap.has(p.id) ? enabledMap.get(p.id) : p.enabled,
      }))
    }
    // ★ 清理孤儿任务。
    //
    // tasks 在 PERSIST_KEYS 里,而 RUNNING 状态只靠 setTimeout 调度的
    // REMOVE_TASK 清掉 —— 生成到一半刷新页面,那个 timer 随页面一起没了,
    // 任务就永远卡在「调用模型中」。刷新后没有任何东西在跑,
    // 所以恢复出来的 running 一定是孤儿,标成中断而不是继续骗用户。
    if (Array.isArray(merged.tasks)) {
      merged.tasks = merged.tasks.map((task) => (
        task?.status === 'running'
          ? { ...task, status: 'cancelled', stepLabel: '已中断（页面刷新）' }
          : task
      ))
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
      const title = action.payload?.title ?? action.payload ?? `新会话 ${new Date().toLocaleTimeString()}`
      const agentId = typeof action.payload === 'object' && action.payload ? (action.payload.agentId || null) : null
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
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
      if (!state.activeSessionId) return state
      const delta = action.payload ?? ''
      if (!delta) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== state.activeSessionId || s.messages.length === 0) return s
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last.role !== 'assistant') return s
          const meta = last.meta || {}
          msgs[msgs.length - 1] = {
            ...last,
            meta: { ...meta, reasoning: (meta.reasoning || '') + delta },
          }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }),
      }
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
            // ★ 记下这次工具调用发生时正文已经写到哪 —— 有了这个锚点,
            // 渲染时才能把「说的话」和「做的事」按真实先后顺序交错排列。
            // 以前只存一个 toolCalls 数组,渲染只能整块堆在正文前面,
            // 用户读起来就是「先给结论后干活」,顺序是反的。
            nextCalls = [...existingCalls, { ...entry, textOffset: (last.content || '').length }]
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
  // 防容量炸弹:抓到 QuotaExceededError 走逐步降级策略,见 persistWithDegradation.
  //
  // ★ debounce 250ms。原来每次 state 变化都同步全量 JSON 序列化 ——
  // 流式生成时每个 token 都会 dispatch 一次 APPEND_TO_LAST_MESSAGE,
  // 于是一条长回复要把整个 state(所有会话 + 所有消息)序列化几千次。
  // 本地模型吐字慢反而掩盖了这个问题,云端快模型上会明显掉帧。
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const timer = setTimeout(() => {
      const snapshot = {}
      for (const key of PERSIST_KEYS) snapshot[key] = state[key]
      const result = persistWithDegradation(snapshot, (k, v) => window.localStorage.setItem(k, v))
      if (!result.ok) {
        console.error('[AppContext] localStorage 完全不可写:', result.error)
      } else if (result.level !== 'full') {
        console.warn(`[AppContext] localStorage 容量告急,已降级到: ${result.level}`)
      }
    }, 250)
    return () => clearTimeout(timer)
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
  if (typeof window === 'undefined') return { ok: true }
  try {
    window.localStorage.removeItem(STORAGE_KEY)
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

import { withSessionModelSelection } from '../../lib/modelSelection.js'

const normalizeWorkspacePath = (value) => String(value || '').trim()

export function reduceSessionLifecycleState(state, action) {
  switch (action.type) {
    case 'NEW_SESSION': {
      const title = action.payload?.title ?? action.payload ?? `\u65b0\u4f1a\u8bdd ${new Date().toLocaleTimeString()}`
      const agentId = typeof action.payload === 'object' && action.payload ? (action.payload.agentId || null) : null
      const requestedId = typeof action.payload === 'object' && action.payload ? action.payload.id : null
      const workspacePath = typeof action.payload === 'object' && action.payload
        ? normalizeWorkspacePath(action.payload.workspacePath)
        : ''
      const id = requestedId || crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const now = Date.now()
      const newSession = {
        id,
        title,
        messages: [],
        createdAt: now,
        updatedAt: now,
        pinnedAt: null,
        agentId, // \u9636\u6bb5 6：session sticky agent。null \u8868\u793a\u8ddf\u968f\u5168\u5c40 active agent
        ...(workspacePath ? { workspacePath } : {}),
      }
      return {
        ...state,
        sessions: [newSession, ...state.sessions],
        activeSessionId: id,
        draftSessionId: null,
        draftWorkspacePath: '',
      }
    }

    case 'START_NEW_DRAFT': {
      const hasExplicitWorkspace = Object.prototype.hasOwnProperty.call(action.payload || {}, 'workspacePath')
      // A global default is a file-access convenience, not implicit project
      // membership. Ordinary new chats must start in Recent with no project.
      const workspacePath = normalizeWorkspacePath(hasExplicitWorkspace ? action.payload.workspacePath : '')
      return {
        ...state,
        activeSessionId: null,
        draftSessionId: null,
        draftWorkspacePath: workspacePath,
        newDraftVersion: state.newDraftVersion + 1,
      }
    }

    case 'SET_DEFAULT_WORKSPACE': {
      const workspacePath = normalizeWorkspacePath(action.payload?.workspacePath ?? action.payload)
      return {
        ...state,
        defaultWorkspacePath: workspacePath,
      }
    }

    case 'SET_DRAFT_WORKSPACE': {
      return {
        ...state,
        draftWorkspacePath: normalizeWorkspacePath(action.payload?.workspacePath ?? action.payload),
      }
    }

    case 'SET_DRAFT_SESSION_ID': {
      if (state.activeSessionId) return state
      const draftSessionId = String(action.payload?.sessionId ?? action.payload ?? '').trim() || null
      return { ...state, draftSessionId }
    }

    case 'ADD_SERVER_FORK': {
      const metadata = action.payload?.session
      const id = String(metadata?.id || '').trim()
      if (!id) return state
      const parent = state.sessions.find((session) => session.id === metadata.parentSessionId)
      const suppliedMessages = Array.isArray(action.payload?.messages)
        ? action.payload.messages
        : []
      const revision = Number(metadata.revision)
      const metadataWorkspacePath = Object.prototype.hasOwnProperty.call(metadata, 'workspacePath')
        ? normalizeWorkspacePath(metadata.workspacePath)
        : normalizeWorkspacePath(parent?.workspacePath)
      const forkedSession = {
        id,
        title: metadata.title || parent?.title || '\u65b0\u5bf9\u8bdd',
        messages: suppliedMessages,
        createdAt: Number(metadata.createdAt) || Date.now(),
        updatedAt: Number(metadata.updatedAt) || Number(metadata.createdAt) || Date.now(),
        lastViewedAt: metadata.lastViewedAt ?? null,
        archivedAt: metadata.archivedAt ?? null,
        pinnedAt: metadata.pinnedAt ?? null,
        parentSessionId: metadata.parentSessionId || null,
        branchLabel: metadata.branchLabel || null,
        forkedAt: metadata.forkedAt ?? null,
        serverRevision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
        agentId: parent?.agentId || null,
        ...(metadataWorkspacePath ? { workspacePath: metadataWorkspacePath } : {}),
        ...(parent?.modelName ? { modelName: parent.modelName } : {}),
        ...(parent?.modelProviderId ? { modelProviderId: parent.modelProviderId } : {}),
      }
      const existingIndex = state.sessions.findIndex((session) => session.id === id)
      if (existingIndex >= 0) {
        return {
          ...state,
          sessions: state.sessions.map((session, index) => (
            index === existingIndex
              ? { ...session, ...forkedSession, messages: suppliedMessages.length ? suppliedMessages : session.messages }
              : session
          )),
        }
      }
      return { ...state, sessions: [forkedSession, ...state.sessions] }
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

    case 'SET_SESSION_WORKSPACE': {
      const { sessionId } = action.payload || {}
      if (!sessionId) return state
      const workspacePath = normalizeWorkspacePath(action.payload?.workspacePath)
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== sessionId) return session
          if (workspacePath) return { ...session, workspacePath, updatedAt: Date.now() }
          const next = { ...session, updatedAt: Date.now() }
          delete next.workspacePath
          return next
        }),
      }
    }

    case 'SET_SESSION_MODEL': {
      const { sessionId, modelName, modelProviderId } = action.payload || {}
      const sessions = withSessionModelSelection(
        state.sessions,
        sessionId,
        { modelName, providerId: modelProviderId },
      )
      return sessions === state.sessions ? state : { ...state, sessions }
    }

    case 'SWITCH_SESSION': {
      const id = action.payload
      if (!id) return state
      const exists = state.sessions.some((s) => s.id === id)
      if (!exists) return state
      // ★ #22: \u5207\u5230\u8be5\u4f1a\u8bdd\u5373\u89c6\u4e3a\u5df2\u8bfb — \u5199\u5165 lastViewedAt
      return {
        ...state,
        activeSessionId: id,
        draftWorkspacePath: '',
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
      // \u540c\u6b65\u6e05\u6389\u8fd9\u4e2a\u4f1a\u8bdd\u7684\u8349\u7a3f,\u514d\u5f97 sessionDrafts \u8d8a\u79ef\u8d8a\u591a
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

    case 'SET_SESSION_PIN': {
      const { sessionId, pinnedAt } = action.payload || {}
      if (!sessionId) return state
      return {
        ...state,
        sessions: state.sessions.map((session) => (
          session.id === sessionId ? { ...session, pinnedAt: pinnedAt ?? null } : session
        )),
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

    // ★ #10: \u5220\u9664\u5355\u6761\u6d88\u606f — payload: messageId

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
            .map((m) => `${m.role === 'user' ? '\u7528\u6237' : '\u52a9\u624b'}: ${(m.content || '').slice(0, 180)}`)
            .join('\n')
            .slice(0, 1800)
          return {
            ...s,
            messages: [
              {
                id: crypto.randomUUID?.() ?? `${Date.now()}-summary`,
                role: 'assistant',
                content: `\u5df2\u538b\u7f29\u8f83\u65e9\u4e0a\u4e0b\u6587，\u4fdd\u7559\u6458\u8981\u4f9b\u540e\u7eed\u53c2\u8003：\n\n${summary}`,
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

    case 'UPDATE_SESSION_TITLE': {
      if (!state.activeSessionId) return state
      const title = action.payload ?? '\u65b0\u5bf9\u8bdd'
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === state.activeSessionId ? { ...s, title, updatedAt: Date.now() } : s
        ),
      }
    }

    // ★ #8: \u6309\u6307\u5b9a sessionId \u6539\u540d (\u7528\u4e8e\u5f02\u6b65 AI \u6807\u9898\u56de\u586b),
    //   onlyIfMatches: \u5f53\u524d\u6807\u9898\u5fc5\u987b\u7b49\u4e8e\u8fd9\u4e2a\u503c\u624d\u8986\u76d6, \u5426\u5219\u8df3\u8fc7 (\u9632\u6b62\u7528\u6237\u5df2\u624b\u52a8\u6539\u540d\u65f6\u88ab\u8986\u76d6)

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

    default:
      return null
  }
}

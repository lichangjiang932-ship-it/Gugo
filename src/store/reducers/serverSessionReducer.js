import { mergeServerSessionMessages } from '../sessionServerSync.js'

export function reduceServerSessionState(state, action) {
  switch (action.type) {
    case 'APPLY_SERVER_SESSION_SNAPSHOT': {
      const { sessionId, snapshot } = action.payload || {}
      if (!sessionId || snapshot?.complete !== true || !Array.isArray(snapshot.messages)) return state
      const revision = Math.max(0, Number(snapshot.revision) || 0)
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== sessionId || revision < (Number(session.serverRevision) || 0)) return session
          return {
            ...session,
            messages: mergeServerSessionMessages(session.messages, snapshot.messages),
            ...(Object.prototype.hasOwnProperty.call(snapshot.session || {}, 'pinnedAt')
              ? { pinnedAt: snapshot.session.pinnedAt }
              : {}),
            serverRevision: revision,
            updatedAt: Math.max(Number(session.updatedAt) || 0, revision),
          }
        }),
      }
    }

    case 'APPLY_SERVER_SESSION_METADATA': {
      const { sessionId, session: metadata } = action.payload || {}
      const revision = Number(metadata?.revision)
      if (!sessionId || !Number.isInteger(revision)) return state
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== sessionId) return session
          if (Number.isInteger(session.serverRevision) && revision < session.serverRevision) return session
          return {
            ...session,
            ...(Object.prototype.hasOwnProperty.call(metadata, 'archivedAt')
              ? { archivedAt: metadata.archivedAt }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(metadata, 'pinnedAt')
              ? { pinnedAt: metadata.pinnedAt }
              : {}),
            serverRevision: revision,
            updatedAt: Math.max(Number(session.updatedAt) || 0, Number(metadata.updatedAt) || 0),
          }
        }),
      }
    }

    case 'APPLY_SERVER_SESSION_MESSAGES': {
      const { sessionId, messages, revision } = action.payload || {}
      if (!sessionId || !Array.isArray(messages) || !Number.isInteger(revision)) return state
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== sessionId) return session
          if (Number.isInteger(session.serverRevision) && revision < session.serverRevision) return session
          return {
            ...session,
            messages,
            serverRevision: revision,
            updatedAt: Math.max(Number(session.updatedAt) || 0, revision),
          }
        }),
      }
    }

    case 'APPLY_SERVER_SESSION_DELETE': {
      const sessionId = action.payload?.sessionId
      if (!sessionId) return state
      const sessions = state.sessions.filter((session) => session.id !== sessionId)
      const sessionDrafts = { ...(state.sessionDrafts || {}) }
      delete sessionDrafts[sessionId]
      return {
        ...state,
        sessions,
        activeSessionId: state.activeSessionId === sessionId
          ? sessions[0]?.id ?? null
          : state.activeSessionId,
        sessionDrafts,
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

    default:
      return null
  }
}

/**
 * sessionSlice — 会话管理
 *
 * 参考 openhanako 的 session-slice，管理会话列表、
 * 当前会话、会话历史等。
 */

export const createSessionSlice = (set) => ({
  // Sessions
  sessions: [],
  setSessions: (sessions) => set({ sessions }),

  // Current session
  currentSessionId: null,
  setCurrentSessionId: (id) => set({ currentSessionId: id }),

  // Active session (in-memory only, not persisted)
  activeSession: null,
  setActiveSession: (session) => set({ activeSession: session }),

  // Session model override
  sessionModelsById: {},
  setSessionModel: (sessionId, model) => set(s => ({
    sessionModelsById: { ...s.sessionModelsById, [sessionId]: model },
  })),

  // Session drafts (input per session)
  sessionDrafts: {},
  setSessionDraft: (sessionId, text) => set(s => ({
    sessionDrafts: { ...s.sessionDrafts, [sessionId]: text },
  })),

  // Compacting sessions
  compactingSessions: [],
  setCompactingSessions: (sessions) => set({ compactingSessions: sessions }),

  // Pinned sessions
  pinnedSessions: [],
  setPinnedSessions: (sessions) => set({ pinnedSessions: sessions }),
  togglePinSession: (sessionId) => set(s => {
    const isPinned = s.pinnedSessions.includes(sessionId);
    return {
      pinnedSessions: isPinned
        ? s.pinnedSessions.filter(id => id !== sessionId)
        : [...s.pinnedSessions, sessionId],
    };
  }),
});

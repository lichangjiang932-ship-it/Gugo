export function reduceAuthState(state, action) {
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

    case 'AUTH_BOOTSTRAP': {
      const payload = action.payload || {}
      const authenticated = payload.authenticated === true && !!payload.user
      return {
        ...state,
        authMode: payload.mode || 'unknown',
        authReady: true,
        isLoggedIn: authenticated,
        user: authenticated
          ? {
              name: payload.user.email?.split('@')[0] || null,
              email: payload.user.email || null,
              avatar: null,
              plan: null,
              joinedAt: payload.user.createdAt || Date.now(),
              totalCalls: 0,
            }
          : { name: null, email: null, avatar: null, plan: null, joinedAt: null, totalCalls: 0 },
      }
    }

    case 'AUTH_BOOTSTRAP_FAILED':
      return {
        ...state,
        authMode: 'unknown',
        authReady: true,
        isLoggedIn: false,
        user: { name: null, email: null, avatar: null, plan: null, joinedAt: null, totalCalls: 0 },
      }

    default:
      return null
  }
}


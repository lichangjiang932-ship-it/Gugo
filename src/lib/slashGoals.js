export function persistSlashGoals(dispatch, sessionId, todos, title) {
  let targetId = sessionId
  if (!targetId) {
    targetId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    dispatch({ type: 'NEW_SESSION', payload: { id: targetId, title } })
  }
  dispatch({ type: 'SET_TODOS', payload: { sessionId: targetId, todos } })
}

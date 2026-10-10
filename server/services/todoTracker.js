/**
 * Host-side todo tracking for `manage_todos`.
 *
 * A todo list the model merely echoes back is not planning — the host has no
 * record, cannot tell whether progress is real, and nothing survives a round.
 * This keeps the current list per session and, on every update, compares it to
 * the previous one to surface drift the model should explain:
 *
 *   - a todo that was `completed` and is now `pending`/`in_progress` again is a
 *     **regression** — flagged so the model cannot quietly move a finished step
 *     back to "in progress" to make a stalled task look alive.
 *
 * It records state; it does not decide truth. Completion of real work is still
 * gated by the execution/verification evidence elsewhere in the loop.
 */

const sessions = new Map()

function sessionKey(sessionId) {
  return String(sessionId || '')
}

/**
 * Record a todo update and report drift since the previous one.
 * @returns {{ todos: Array<object>, regressions: Array<{content, from, to}> }}
 */
export function trackTodos(sessionId, todos = []) {
  const key = sessionKey(sessionId)
  const prior = sessions.get(key) || new Map()
  const next = new Map()
  const regressions = []
  for (const todo of todos) {
    const content = String(todo?.content || '')
    if (!content) continue
    const status = String(todo?.status || 'pending')
    const before = prior.get(content)
    if (before === 'completed' && status !== 'completed') {
      regressions.push({ content, from: before, to: status })
    }
    next.set(content, status)
  }
  sessions.set(key, next)
  return { todos, regressions }
}

/** The last recorded statuses for a session (empty map when none). */
export function getTodoStatuses(sessionId) {
  return new Map(sessions.get(sessionKey(sessionId)) || [])
}

/** Clear a session's tracked todos (test / lifecycle hygiene). */
export function clearTodos(sessionId) {
  sessions.delete(sessionKey(sessionId))
}

import { TOOL_CALL_STATUS } from '../store/taskStatus.js'

export const TODO_LIMIT = 50

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed'])

function todoText(todo) {
  if (typeof todo === 'string') return todo.trim()
  return String(todo?.content ?? todo?.title ?? todo?.text ?? '').trim()
}

function todoStatus(todo) {
  const status = String(todo?.status || '').trim()
  if (status === 'done' || status === 'completed') return 'completed'
  if (status === 'in_progress') return 'in_progress'
  if (status === 'pending') return 'pending'
  if (todo?.done === true) return 'completed'
  return 'pending'
}

export function normalizeTodo(todo, index = 0) {
  const content = todoText(todo)
  if (!content) return null
  const activeForm = String(todo?.activeForm || todo?.active_form || '').trim() || content
  return {
    id: String(todo?.id || `${index}:${content}`),
    content,
    activeForm,
    status: VALID_STATUSES.has(todoStatus(todo)) ? todoStatus(todo) : 'pending',
  }
}

export function normalizeSessionTodos(todos) {
  return (Array.isArray(todos) ? todos : [])
    .map((todo, index) => normalizeTodo(todo, index))
    .filter(Boolean)
    .slice(0, TODO_LIMIT)
}

export function todosSignature(todos) {
  return normalizeSessionTodos(todos)
    .map((todo) => `${todo.content}\u0000${todo.status}`)
    .join('\u001f')
}

/** The normalized list a successful `manage_todos` result publishes, or null. */
export function manageTodosFromToolResult(result, args) {
  if (result?.ok === false) return null
  const todos = Array.isArray(result?.todos)
    ? result.todos
    : Array.isArray(args?.todos) ? args.todos : null
  return todos === null ? null : normalizeSessionTodos(todos)
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

function todoListFromCall(call) {
  if (call?.name !== 'manage_todos') return null
  if (call?.status === TOOL_CALL_STATUS.ERROR || call?.status === TOOL_CALL_STATUS.CANCELLED) return null
  const result = parseMaybeJson(call.result)
  if (Array.isArray(result?.todos)) return result.todos
  const args = parseMaybeJson(call.arguments)
  if (Array.isArray(args?.todos)) return args.todos
  return null
}

/**
 * The latest successful `manage_todos` list in the transcript, or null when the
 * agent never wrote one. An empty list is a real answer: it clears the list.
 */
export function deriveSessionTodos(messages) {
  if (!Array.isArray(messages)) return null
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    const calls = message?.meta?.toolCalls || message?.tool_calls
    if (!Array.isArray(calls)) continue
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const todos = todoListFromCall(calls[callIndex])
      if (todos !== null) return normalizeSessionTodos(todos)
    }
  }
  return null
}

/**
 * Stored todos are the live list (agent dispatch or the user's manual goals);
 * the transcript is the fallback that makes a reloaded session show the list the
 * agent last wrote even when that list was never persisted with the session.
 */
export function resolveSessionTodos({ messages = [], storedTodos = [] } = {}) {
  const stored = normalizeSessionTodos(storedTodos)
  if (stored.length > 0) return stored
  return deriveSessionTodos(messages) || []
}

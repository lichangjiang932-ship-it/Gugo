/**
 * When the session's plan or task list may have changed.
 *
 * The plan lives on the server (goal_plans), and the agent changes it through
 * tool calls that run *inside a turn*. A panel that loaded the plan when it was
 * opened has no way to know that — which is why the plan used to look frozen
 * while the agent was visibly working through it.
 *
 * There is no dedicated goal event stream: the agent's plan edits arrive as
 * ordinary `tool.completed` events, so the signal is derived from the tool name
 * plus the turn's end. Keeping the decision in one pure predicate means the
 * dispatcher and its tests cannot disagree about what counts as a change.
 */

/** Tool calls that can add, rewrite, approve or complete part of the plan. */
export const GOAL_PLAN_TOOL_NAMES = Object.freeze([
  'goal_plan_status',
  'goal_step_update',
  'goal_plan_rewrite',
  'manage_todos',
  'set_deliverables',
])

const GOAL_PLAN_TOOLS = new Set(GOAL_PLAN_TOOL_NAMES)

/**
 * Turn ends that can leave the plan changed even when no goal tool was seen —
 * a turn that ends by cancelling, pausing or failing still moved whatever the
 * loop persisted, and every reader would otherwise keep the stale snapshot.
 */
const PLAN_RELEVANT_TURN_EVENTS = new Set([
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'turn.interrupted',
  'turn.blocked',
  'turn.paused',
])

export const GOAL_PLAN_CHANGED_EVENT = 'chat-goals:changed'

/**
 * @returns {{ changed: boolean, reason: string, toolName: string }}
 *   `reason` is for tests and diagnostics only; nothing branches on it.
 */
export function inspectGoalPlanSignal(event) {
  const type = String(event?.type || '')
  if (type === 'tool.completed') {
    const toolName = String(event?.payload?.name || '')
    if (GOAL_PLAN_TOOLS.has(toolName)) return { changed: true, reason: 'goal_tool', toolName }
    return { changed: false, reason: 'other_tool', toolName }
  }
  if (PLAN_RELEVANT_TURN_EVENTS.has(type)) return { changed: true, reason: 'turn_end', toolName: '' }
  return { changed: false, reason: 'unrelated', toolName: '' }
}

export function turnEventChangesGoalPlan(event) {
  return inspectGoalPlanSignal(event).changed
}

/**
 * Build the event from the window that will dispatch it.
 *
 * A bare `CustomEvent` refers to whatever global happens to exist — in a browser
 * that is the window's own, but under jsdom (and any host with its own Event class)
 * the ambient constructor produces an object the target rejects as "not of type
 * Event". Using the window's constructor keeps the two ends of the dispatch from
 * being different classes.
 */
function buildEvent(window, name, detail) {
  const Ctor = window?.CustomEvent
  if (typeof Ctor !== 'function') return null
  return new Ctor(name, { detail })
}

export function announceGoalPlanChanged(detail = {}) {
  if (typeof window === 'undefined') return
  const event = buildEvent(window, GOAL_PLAN_CHANGED_EVENT, detail)
  if (event) window.dispatchEvent(event)
}

/** Subscribe to plan-change announcements. Returns an unsubscribe function. */
export function subscribeGoalPlanChanged(listener) {
  if (typeof window === 'undefined' || typeof listener !== 'function') return () => {}
  const handler = (event) => listener(event?.detail || {})
  window.addEventListener(GOAL_PLAN_CHANGED_EVENT, handler)
  return () => window.removeEventListener(GOAL_PLAN_CHANGED_EVENT, handler)
}

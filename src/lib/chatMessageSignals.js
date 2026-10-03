/**
 * Pointing the conversation at a turn.
 *
 * A plan step's evidence names the turn whose tool call proved it. The reader can
 * be shown that claim in full, but the useful next question is "show me" — and the
 * transcript is already the place that answers it. The message list owns the
 * scrolling (it may be windowed, so only it knows how to bring an old turn into
 * view), so the request travels as an event rather than as a prop threaded through
 * every layer between the plan card and the message list.
 */
export const REVEAL_TURN_EVENT = 'chat-messages:reveal-turn'

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

export function revealTurnInConversation(turnId) {
  const value = String(turnId || '').trim()
  if (!value || typeof window === 'undefined') return false
  const event = buildEvent(window, REVEAL_TURN_EVENT, { turnId: value })
  if (!event) return false
  window.dispatchEvent(event)
  return true
}

export function subscribeRevealTurn(listener) {
  if (typeof window === 'undefined' || typeof listener !== 'function') return () => {}
  const handler = (event) => listener(String(event?.detail?.turnId || ''))
  window.addEventListener(REVEAL_TURN_EVENT, handler)
  return () => window.removeEventListener(REVEAL_TURN_EVENT, handler)
}

/**
 * The index of the message that carries a turn, within the whole message list —
 * the same index `scrollToTurn` takes, so a windowed list can bring it into view.
 * Returns -1 when the turn is not in this transcript (an older session, or a
 * message the user has since deleted).
 */
export function messageIndexForTurn(messages, turnId) {
  const wanted = String(turnId || '').trim()
  if (!wanted) return -1
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (String(list[index]?.meta?.serverTurnId || '') === wanted) return index
  }
  return -1
}

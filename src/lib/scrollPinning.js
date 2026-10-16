// Interaction constants informed by open-claude-ui; Gugo owns the intent/state contract.
export const SCROLL_PIN_TOLERANCE = 40
export const SCROLL_JUMP_DISTANCE = 120
export const SCROLL_INPUT_COOLDOWN = 150
export function preferredScrollBehavior() {
  return globalThis.document?.documentElement.dataset.animations === 'false'
    || globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
export function scrollDistance(element) {
  return Math.max(0, (element?.scrollHeight || 0) - (element?.clientHeight || 0) - Math.max(0, element?.scrollTop || 0))
}
export function scrollEdges(element, size = 28) {
  return { top: (element?.scrollTop || 0) > 2 ? size : 0, bottom: scrollDistance(element) > 2 ? size : 0 }
}
export function createScrollPinning(now = () => performance.now()) {
  let pinned = true, lastInput = -Infinity, released = false, lastTop = null, jumping = false
  return {
    input(direction) {
      lastInput = now(); jumping = false
      if (direction < 0) { pinned = false; released = true }
      else if (direction > 0) released = false
    },
    observe(element) {
      const top = Math.max(0, element.scrollTop || 0), distance = scrollDistance(element)
      if (!jumping && lastTop != null && top < lastTop - 0.5) {
        pinned = false; released = true; lastInput = now()
      }
      if (!jumping && distance > SCROLL_PIN_TOLERANCE) pinned = false
      else if (!released && now() - lastInput > SCROLL_INPUT_COOLDOWN) pinned = true
      if (distance <= 2) jumping = false
      lastTop = top
      return { pinned, showJump: distance > SCROLL_JUMP_DISTANCE }
    },
    shouldPin() { return pinned && !released && now() - lastInput > SCROLL_INPUT_COOLDOWN },
    jump() { pinned = true; released = false; jumping = true; lastInput = -Infinity; lastTop = null },
  }
}

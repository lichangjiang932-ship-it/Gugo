import { useLayoutEffect, useState, useSyncExternalStore } from 'react'

/**
 * What the two side panels may spend, measured from the conversation outward.
 *
 * Each side used to work this out alone, against `window.innerWidth`: the rail
 * reserved 400px of the window for the chat column and the region reserved
 * another 400px of the same window. Neither could see the other, so on a narrow
 * window both reservations were honoured against space that only existed once.
 * At 1024px with the rail's own 280px, the chat column was left 264px and the
 * welcome cards and the composer both broke; at 768px only 228px was left.
 *
 * The budget is measured now, and it is measured from the element the chat
 * column actually lives in rather than from the window. `[data-chat-main-area]`
 * is `flex: 1 1 0%` with `min-w-0`, so the flex algorithm sizes it against the
 * row minus the rail, and a `shrink-0` child cannot change that — which is what
 * makes it safe to measure. Measuring the chat *column* would not be: the
 * region's own width feeds straight back into it.
 */

/** The width the conversation keeps before either side gives ground. */
export const MIN_CHAT_WIDTH = 400

/** The element the chat column lives in — everything right of the navigation rail. */
export const CHAT_AREA_SELECTOR = '[data-chat-main-area]'

export const MIN_REGION_WIDTH = 320
export const MAX_REGION_WIDTH = 900
export const DEFAULT_REGION_WIDTH = 480

export function viewportWidth() {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

/**
 * The space after the rail. Falls back to the window when nothing is laid out
 * yet: jsdom has no layout at all and the value is needed on the first render,
 * so the fallback is load-bearing rather than defensive.
 */
export function measureChatAreaWidth() {
  const element = globalThis.document?.querySelector?.(CHAT_AREA_SELECTOR)
  const measured = element?.getBoundingClientRect?.().width || element?.clientWidth || 0
  return measured > 0 ? measured : viewportWidth()
}

/** The measured chat area, kept current as the window and the rail change. */
export function useChatAreaWidth() {
  const [width, setWidth] = useState(measureChatAreaWidth)
  useLayoutEffect(() => {
    const element = globalThis.document?.querySelector?.(CHAT_AREA_SELECTOR)
    let previous = 0
    const measure = () => {
      const next = measureChatAreaWidth()
      if (next === previous) return
      previous = next
      setWidth(next)
    }
    // Before paint, so the first frame is already sized for this window.
    measure()
    const ResizeObserverClass = globalThis.ResizeObserver
    const observer = element && ResizeObserverClass ? new ResizeObserverClass(measure) : null
    observer?.observe(element)
    globalThis.window?.addEventListener?.('resize', measure)
    return () => {
      observer?.disconnect()
      globalThis.window?.removeEventListener?.('resize', measure)
    }
  }, [])
  return width
}

/** How wide the right region may be before it starts eating the conversation. */
export function regionMaxWidth(chatAreaWidth) {
  return Math.max(
    MIN_REGION_WIDTH,
    Math.min(MAX_REGION_WIDTH, Number(chatAreaWidth) - MIN_CHAT_WIDTH),
  )
}

export function clampRegionWidth(value, chatAreaWidth) {
  const numeric = Number(value)
  const wanted = Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_REGION_WIDTH
  return Math.min(regionMaxWidth(chatAreaWidth), Math.max(MIN_REGION_WIDTH, wanted))
}

/**
 * Whether the right region is on screen.
 *
 * The rail is app-level and the region belongs to the chat page, so the one
 * thing the rail has to know — whether to keep room for the region as well as
 * the conversation — travels here instead of through the props of everything
 * between them. The rail sits outside the chat area and so can only clamp
 * against the window; the region sits inside it and clamps against the measure.
 * They share this and the constants, not one number.
 */
let regionState = Object.freeze({ open: false, revision: 0 })
const regionListeners = new Set()

export function readRegionOpenState() {
  return regionState
}

export function setRegionOpen(open) {
  const next = open === true
  if (regionState.open === next) return regionState
  regionState = Object.freeze({ open: next, revision: regionState.revision + 1 })
  for (const listener of regionListeners) listener(regionState)
  return regionState
}

export function subscribeRegionOpen(listener) {
  regionListeners.add(listener)
  return () => regionListeners.delete(listener)
}

/** The module is shared across a test file, so a set flag has to be clearable. */
export function resetRegionOpenForTests() {
  regionState = Object.freeze({ open: false, revision: 0 })
  regionListeners.clear()
}

export function useRegionOpen() {
  return useSyncExternalStore(
    subscribeRegionOpen,
    () => readRegionOpenState().open,
    () => false,
  )
}

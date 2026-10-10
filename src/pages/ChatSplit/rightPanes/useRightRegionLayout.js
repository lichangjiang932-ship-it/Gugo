import { useCallback, useEffect, useState } from 'react'

/**
 * The right region's own geometry: how wide it is, and how it divides its height
 * and width between the panes stacked inside it.
 *
 * The region used to be three siblings that each owned a width — the workbench,
 * the preview pane and the dock all kept their own and clamped it against their
 * own hard-coded reservation of the conversation (`viewportWidth - 320` in one,
 * `MIN_PREVIEW_CHAT_WIDTH` in another). Stacking them made that untenable: two
 * panels could each claim space from a chat column that only had it once, and
 * neither could be laid out until the other had decided. One owner fixes both —
 * the region decides its width, the panes are told theirs.
 */

export const MIN_CHAT_WIDTH = 400
export const MIN_REGION_WIDTH = 320
export const MAX_REGION_WIDTH = 900
export const DEFAULT_REGION_WIDTH = 480
export const REGION_WIDTH_STORAGE_KEY = 'gugo:right-region-width'

/** Narrower than this and a pane has no readable line left in it. */
export const MIN_PANE_WIDTH = 220
export const GUTTER_PX = 8

/** The share of the region each half may not shrink past. */
const MIN_RATIO = 0.2
const MAX_RATIO = 0.8

export function viewportWidth() {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

/** How wide the region may be before it starts eating the conversation. */
export function regionMaxWidth(viewport = viewportWidth()) {
  return Math.max(MIN_REGION_WIDTH, Math.min(MAX_REGION_WIDTH, Number(viewport) - MIN_CHAT_WIDTH))
}

export function clampRegionWidth(value, viewport = viewportWidth()) {
  const numeric = Number(value)
  const wanted = Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_REGION_WIDTH
  return Math.min(regionMaxWidth(viewport), Math.max(MIN_REGION_WIDTH, wanted))
}

export function clampRatio(value, fallback) {
  const numeric = Number(value)
  const wanted = Number.isFinite(numeric) ? numeric : fallback
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, wanted))
}

/**
 * What the reader wants the region to be — not what it can be right now.
 *
 * Kept unclamped on purpose. Clamping on read, and storing the clamped result,
 * is how the width ratcheted down and stayed there: a narrow window squeezed it
 * to the floor, the floor was written back as the preference, and widening the
 * window could not grow it again because nothing remembered the original.
 */
export function readStoredRegionWidth() {
  try {
    const stored = Number(globalThis.window?.localStorage?.getItem(REGION_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? Math.min(stored, MAX_REGION_WIDTH) : DEFAULT_REGION_WIDTH
  } catch {
    return DEFAULT_REGION_WIDTH
  }
}

/**
 * The region's three dividers, in the one place the three hand-rolled copies of
 * this gesture used to live. Each grows the pane before it by moving the pointer
 * away from it — left for a vertical divider, up for a horizontal one — and
 * writes through the same clamp helpers, so the geometry rules stay in one place.
 */
export function useRightRegionLayout() {
  const [preferredWidth, setPreferredWidth] = useState(readStoredRegionWidth)
  const [topRatio, setTopRatio] = useState(0.5)
  const [bottomLeftRatio, setBottomLeftRatio] = useState(0.5)
  // The width actually drawn is the preference put through the current window,
  // worked out during render so a window that grows gets its room back without
  // anyone having to tell the region about the resize.
  const width = clampRegionWidth(preferredWidth)

  useEffect(() => {
    try {
      globalThis.window?.localStorage?.setItem(REGION_WIDTH_STORAGE_KEY, String(preferredWidth))
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
    }
  }, [preferredWidth])

  /** The region's own edge: dragging left widens it. */
  const beginWidthDrag = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus?.({ preventScroll: true })
    event.currentTarget.setPointerCapture?.(event.pointerId)
    // The drag records what the reader asked for, not what fitted: pulling the
    // edge in a window too narrow to honour it is still a request, and widening
    // the window should answer it rather than leave the region pinned.
    const start = { startX: event.clientX, startWidth: width }
    const onMove = (moveEvent) => setPreferredWidth(Math.max(MIN_REGION_WIDTH, start.startWidth + start.startX - moveEvent.clientX))
    const stop = () => {
      globalThis.window?.removeEventListener?.('pointermove', onMove)
      globalThis.window?.removeEventListener?.('pointerup', stop)
    }
    globalThis.window?.addEventListener?.('pointermove', onMove)
    globalThis.window?.addEventListener?.('pointerup', stop)
  }, [width])

  const resizeWidthWithKeyboard = useCallback((event) => {
    if (event.key === 'ArrowLeft') setPreferredWidth((value) => Math.min(MAX_REGION_WIDTH, value + 24))
    else if (event.key === 'ArrowRight') setPreferredWidth((value) => Math.max(MIN_REGION_WIDTH, value - 24))
    else if (event.key === 'Home') setPreferredWidth(DEFAULT_REGION_WIDTH)
    else return
    event.preventDefault()
  }, [])

  const resetWidth = useCallback(() => setPreferredWidth(DEFAULT_REGION_WIDTH), [])

  /** The horizontal divider between the pane above and the panes below. */
  const beginRowDrag = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const host = event.currentTarget.parentElement?.getBoundingClientRect?.()
    if (!host?.height) return
    const start = { fromY: event.clientY, startRatio: topRatio, height: host.height }
    const onMove = (moveEvent) => {
      setTopRatio(clampRatio(start.startRatio + (moveEvent.clientY - start.fromY) / start.height, 0.5))
    }
    const stop = () => {
      globalThis.window?.removeEventListener?.('pointermove', onMove)
      globalThis.window?.removeEventListener?.('pointerup', stop)
    }
    globalThis.window?.addEventListener?.('pointermove', onMove)
    globalThis.window?.addEventListener?.('pointerup', stop)
  }, [topRatio])

  const resizeRowWithKeyboard = useCallback((event) => {
    const step = 0.04
    if (event.key === 'ArrowUp') setTopRatio((value) => clampRatio(value - step, 0.5))
    else if (event.key === 'ArrowDown') setTopRatio((value) => clampRatio(value + step, 0.5))
    else if (event.key === 'Home') setTopRatio(0.5)
    else return
    event.preventDefault()
  }, [])

  /** The vertical divider between the two panes sharing the bottom row. */
  const beginColumnDrag = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const host = event.currentTarget.parentElement?.getBoundingClientRect?.()
    if (!host?.width) return
    const start = { fromX: event.clientX, startRatio: bottomLeftRatio, width: host.width }
    const onMove = (moveEvent) => {
      setBottomLeftRatio(clampRatio(start.startRatio + (moveEvent.clientX - start.fromX) / start.width, 0.5))
    }
    const stop = () => {
      globalThis.window?.removeEventListener?.('pointermove', onMove)
      globalThis.window?.removeEventListener?.('pointerup', stop)
    }
    globalThis.window?.addEventListener?.('pointermove', onMove)
    globalThis.window?.addEventListener?.('pointerup', stop)
  }, [bottomLeftRatio])

  const resizeColumnWithKeyboard = useCallback((event) => {
    const step = 0.04
    if (event.key === 'ArrowLeft') setBottomLeftRatio((value) => clampRatio(value - step, 0.5))
    else if (event.key === 'ArrowRight') setBottomLeftRatio((value) => clampRatio(value + step, 0.5))
    else if (event.key === 'Home') setBottomLeftRatio(0.5)
    else return
    event.preventDefault()
  }, [])

  return {
    beginColumnDrag,
    beginRowDrag,
    beginWidthDrag,
    bottomLeftRatio,
    minWidth: MIN_REGION_WIDTH,
    resetWidth,
    resizeColumnWithKeyboard,
    resizeRowWithKeyboard,
    resizeWidthWithKeyboard,
    topRatio,
    width,
  }
}

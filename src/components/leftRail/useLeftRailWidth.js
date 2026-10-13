import { useCallback, useEffect, useState } from 'react'
import { MIN_CHAT_WIDTH, MIN_REGION_WIDTH, useRegionOpen } from '../../lib/chatLayoutBudget.js'

/**
 * The left rail's width: adaptive until the reader drags it, theirs after.
 *
 * The rail used to be a fixed `clamp(280px, 20vw, 320px)` — it kept its own
 * proportions and could be collapsed, but never answered to the reader pulling
 * its edge toward the conversation. It does now, and remembers.
 *
 * A preference of 0 is not a width: it means nobody has dragged, so the rail
 * keeps the adaptive width it always had. That is also what Home goes back to.
 */

export const RAIL_WIDTH_STORAGE_KEY = 'gugo:left-rail-width'
export const MIN_RAIL_WIDTH = 220
export const MAX_RAIL_WIDTH = 480

export function viewportWidth() {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

/** The width the rail picks for itself when nobody has chosen one. */
export function adaptiveRailWidth(viewport = viewportWidth()) {
  return Math.min(320, Math.max(280, Math.round(Number(viewport) * 0.2)))
}

/**
 * The rail's share of the window.
 *
 * The rail sits outside the chat area, so the window is the only thing it can
 * measure against — but it must not spend the conversation's reserve and the
 * region's reserve out of the same pixels. With the region open, both come out
 * of this number.
 */
export function railMaxWidth(viewport = viewportWidth(), { regionOpen = false } = {}) {
  const reserve = MIN_CHAT_WIDTH + (regionOpen ? MIN_REGION_WIDTH : 0)
  return Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, Number(viewport) - reserve))
}

export function clampRailWidth(value, viewport = viewportWidth(), { regionOpen = false } = {}) {
  const numeric = Number(value)
  const wanted = Number.isFinite(numeric) && numeric > 0 ? numeric : adaptiveRailWidth(viewport)
  return Math.min(railMaxWidth(viewport, { regionOpen }), Math.max(MIN_RAIL_WIDTH, wanted))
}

/** The reader's width, or 0 for "never dragged". Kept unclamped so a narrow
 *  window cannot ratchet the preference down and pin it there. */
export function readStoredRailWidth() {
  try {
    const stored = Number(globalThis.window?.localStorage?.getItem(RAIL_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? Math.min(stored, MAX_RAIL_WIDTH) : 0
  } catch {
    return 0
  }
}

export function useLeftRailWidth() {
  const [preferred, setPreferred] = useState(readStoredRailWidth)
  const [resizing, setResizing] = useState(false)
  const regionOpen = useRegionOpen()
  // Clamped on the way out rather than on the way in: the preference is what the
  // reader asked for, the width is what this window can give it.
  const width = clampRailWidth(preferred || adaptiveRailWidth(), viewportWidth(), { regionOpen })

  useEffect(() => {
    if (!preferred) return
    try {
      globalThis.window?.localStorage?.setItem(RAIL_WIDTH_STORAGE_KEY, String(preferred))
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
    }
  }, [preferred])

  const clearWidth = useCallback(() => {
    setPreferred(0)
    try {
      globalThis.window?.localStorage?.removeItem(RAIL_WIDTH_STORAGE_KEY)
    } catch {
      // Nothing to clear if storage is unavailable.
    }
  }, [])

  const beginResize = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus?.({ preventScroll: true })
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const from = event.currentTarget.parentElement?.getBoundingClientRect?.().width || width
    const startX = event.clientX
    setResizing(true)
    const onMove = (moveEvent) => {
      // Rightward grows the rail, away from the conversation it borders.
      setPreferred(Math.max(MIN_RAIL_WIDTH, Math.round(from + (moveEvent.clientX - startX))))
    }
    const stop = () => {
      setResizing(false)
      globalThis.window?.removeEventListener?.('pointermove', onMove)
      globalThis.window?.removeEventListener?.('pointerup', stop)
    }
    globalThis.window?.addEventListener?.('pointermove', onMove)
    globalThis.window?.addEventListener?.('pointerup', stop)
  }, [width])

  const resizeWithKeyboard = useCallback((event) => {
    const step = 24
    if (event.key === 'ArrowRight') setPreferred((value) => Math.min(MAX_RAIL_WIDTH, (value || width) + step))
    else if (event.key === 'ArrowLeft') setPreferred((value) => Math.max(MIN_RAIL_WIDTH, (value || width) - step))
    else if (event.key === 'Home') clearWidth()
    else return
    event.preventDefault()
  }, [clearWidth, width])

  return { beginResize, clearWidth, hasCustomWidth: preferred > 0, resizeWithKeyboard, resizing, width }
}

export default useLeftRailWidth


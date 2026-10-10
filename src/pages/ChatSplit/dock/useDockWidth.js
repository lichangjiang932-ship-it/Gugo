import { useCallback, useEffect, useRef, useState } from 'react'
import { clampWidth, DEFAULT_WIDTH, MIN_WIDTH } from '../rightWorkbench/rightWorkbenchLayout.js'

/**
 * The width of a right-docked panel: clamped, remembered, and draggable.
 *
 * One hook because three panels (review, plan, terminal/browser) must behave the
 * same way — the same minimum, the same memory across reloads, the same "grab the
 * edge" gesture — instead of each growing its own rules.
 */
export const DOCK_WIDTH_STORAGE_KEY = 'gugo:dock-width'
export const EXPANDED_WIDTH = clampWidth(Number.MAX_SAFE_INTEGER)

export function readStoredDockWidth() {
  try {
    const stored = Number(globalThis.window?.localStorage?.getItem(DOCK_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : clampWidth(DEFAULT_WIDTH)
  } catch {
    return clampWidth(DEFAULT_WIDTH)
  }
}

export function useDockWidth({ storageKey = DOCK_WIDTH_STORAGE_KEY } = {}) {
  const [width, setWidth] = useState(readStoredDockWidth)
  const [expanded, setExpanded] = useState(false)
  const restoreRef = useRef(clampWidth(DEFAULT_WIDTH))
  const resizeRef = useRef(null)

  useEffect(() => {
    try {
      globalThis.window?.localStorage?.setItem(storageKey, String(width))
    } catch {
      // Storage can be unavailable in privacy-restricted contexts.
    }
  }, [storageKey, width])

  const beginResize = useCallback((event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus?.({ preventScroll: true })
    resizeRef.current = { startX: event.clientX, startWidth: width }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const onMove = (moveEvent) => {
      const start = resizeRef.current
      if (!start) return
      setWidth(clampWidth(start.startWidth + start.startX - moveEvent.clientX))
    }
    const stop = () => {
      resizeRef.current = null
      globalThis.window?.removeEventListener('pointermove', onMove)
      globalThis.window?.removeEventListener('pointerup', stop)
    }
    globalThis.window?.addEventListener('pointermove', onMove)
    globalThis.window?.addEventListener('pointerup', stop)
  }, [width])

  const resizeWithKeyboard = useCallback((event) => {
    if (event.key === 'ArrowLeft') setWidth((value) => clampWidth(value + 24))
    else if (event.key === 'ArrowRight') setWidth((value) => clampWidth(value - 24))
    else if (event.key === 'Home') setWidth(clampWidth(DEFAULT_WIDTH))
    else return
    event.preventDefault()
  }, [])

  const reset = useCallback(() => setWidth(clampWidth(DEFAULT_WIDTH)), [])

  const toggleExpand = useCallback(() => {
    setExpanded((current) => {
      if (current) {
        setWidth(clampWidth(restoreRef.current || DEFAULT_WIDTH))
        return false
      }
      restoreRef.current = width
      setWidth(EXPANDED_WIDTH)
      return true
    })
  }, [width])

  return { beginResize, expanded, reset, resizeWithKeyboard, setWidth, toggleExpand, width, minWidth: MIN_WIDTH }
}

import { useLayoutEffect, useState } from 'react'
import { previewViewportWidth } from './previewPaneLayout.js'

/** Measure the space after the navigation rail, not the whole browser window. */
export default function usePreviewContainerWidth(paneRef, onWidthChange) {
  const [availableWidth, setAvailableWidth] = useState(previewViewportWidth)
  useLayoutEffect(() => {
    const container = paneRef?.current?.closest('[data-chat-main-area]') || paneRef?.current?.parentElement
    let previousWidth = null
    const measure = () => {
      const width = container?.getBoundingClientRect().width || container?.clientWidth || previewViewportWidth()
      if (previousWidth !== null && previousWidth !== width) onWidthChange?.()
      previousWidth = width
      setAvailableWidth(width)
    }
    measure()
    const ResizeObserverClass = window.ResizeObserver || globalThis.ResizeObserver
    const observer = container && ResizeObserverClass ? new ResizeObserverClass(measure) : null
    observer?.observe(container)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [paneRef, onWidthChange])
  return availableWidth
}

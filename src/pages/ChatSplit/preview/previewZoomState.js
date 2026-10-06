import { createContext, useContext, useEffect, useState } from 'react'

export const ZOOM_LEVELS = Object.freeze([50, 75, 100, 125, 150, 200])
/** Kinds whose renderer lays out a fixed-size page and can be scaled. */
export const ZOOMABLE_KINDS = Object.freeze(new Set(['docx', 'pptx', 'image']))

/**
 * Zoom shared by a preview's toolbar and its renderer. `fit` is the default:
 * the page is scaled to the pane's width, so a document opens readable at any
 * pane size. The renderer reports the scale fitting produced, which is what the
 * control shows — "70%" means what the reader sees, not a setting.
 */
const PreviewZoomContext = createContext({ zoom: 'fit', setZoom: () => {}, fitPercent: null, setFitPercent: () => {} })

export function usePreviewZoomState() {
  const [zoom, setZoom] = useState('fit')
  const [fitPercent, setFitPercent] = useState(null)
  return { zoom, setZoom, fitPercent, setFitPercent }
}

export const PreviewZoomProvider = PreviewZoomContext.Provider
export const usePreviewZoom = () => useContext(PreviewZoomContext)

/** Scale for a page `pageWidth` wide in a frame `frameWidth` wide. */
export function previewScale(zoom, pageWidth, frameWidth, gutter = 32) {
  if (zoom !== 'fit') return Number(zoom) / 100
  if (!(pageWidth > 0) || !(frameWidth > 0)) return 1
  return Math.min(1, Math.max(0.1, (frameWidth - gutter) / pageWidth))
}

/**
 * Width of an element, kept current as the pane is resized. Returns a callback
 * ref: a renderer's frame often mounts only after its content loads, and a ref
 * object read once on mount would never see it.
 */
export function useElementWidth() {
  const [element, setElement] = useState(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!element) return undefined
    const update = () => setWidth(element.clientWidth || 0)
    update()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width]
}

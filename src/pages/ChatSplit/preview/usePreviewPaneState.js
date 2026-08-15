import { useEffect, useRef, useState } from 'react'
import { isHtmlDeckLike } from '../../../lib/artifactPreview.js'

export const DEFAULT_PREVIEW_PANE_WIDTH = 520
export const MIN_PREVIEW_PANE_WIDTH = 360
const MAX_PREVIEW_PANE_WIDTH = 900
const MIN_CHAT_WIDTH = 360

function viewportWidth() {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

export function previewPaneMaxWidth(width = viewportWidth()) {
  return Math.max(MIN_PREVIEW_PANE_WIDTH, Math.min(MAX_PREVIEW_PANE_WIDTH, Number(width) - MIN_CHAT_WIDTH))
}

export function clampPreviewPaneWidth(value, width = viewportWidth()) {
  const numeric = Number(value) || DEFAULT_PREVIEW_PANE_WIDTH
  return Math.min(previewPaneMaxWidth(width), Math.max(MIN_PREVIEW_PANE_WIDTH, numeric))
}

export function isPresentationArtifact(artifact) {
  const preview = artifact?.preview
  return preview?.type === 'pptx' || (preview?.type === 'html' && isHtmlDeckLike(preview.html || ''))
}

function readStoredWidth() {
  try { return clampPreviewPaneWidth(localStorage.getItem('preview-pane-width')) }
  catch { return clampPreviewPaneWidth(DEFAULT_PREVIEW_PANE_WIDTH) }
}

export default function usePreviewPaneState({ artifact, onClose }) {
  const [view, setView] = useState('preview')
  const [maximized, setMaximized] = useState(() => isPresentationArtifact(artifact))
  const [paneWidth, setPaneWidth] = useState(readStoredWidth)
  const [resizing, setResizing] = useState(false)
  const dragStateRef = useRef(null)
  const touchStateRef = useRef(null)
  const previousArtifactRef = useRef(null)

  useEffect(() => {
    try { localStorage.setItem('preview-pane-width', String(paneWidth)) } catch { /* ignore blocked storage */ }
  }, [paneWidth])

  useEffect(() => {
    const handleResize = () => setPaneWidth((width) => clampPreviewPaneWidth(width))
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (!onClose) return undefined
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    if (artifact === previousArtifactRef.current) return
    previousArtifactRef.current = artifact
    setView('preview')
    setMaximized(isPresentationArtifact(artifact))
  }, [artifact])

  useEffect(() => {
    if (!resizing) return undefined
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    const onMove = (event) => {
      const drag = dragStateRef.current
      if (!drag || (event.pointerId != null && event.pointerId !== drag.pointerId)) return
      setPaneWidth(clampPreviewPaneWidth(drag.startWidth + drag.startX - event.clientX))
    }
    const stop = (event) => {
      const drag = dragStateRef.current
      if (drag && event?.pointerId != null && event.pointerId !== drag.pointerId) return
      drag?.target?.releasePointerCapture?.(drag.pointerId)
      dragStateRef.current = null
      setResizing(false)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [resizing])

  const startResize = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    dragStateRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: paneWidth, target: event.currentTarget }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setResizing(true)
  }

  const resizeWithKeyboard = (event) => {
    if (event.key === 'ArrowLeft') setPaneWidth((width) => clampPreviewPaneWidth(width + 24))
    else if (event.key === 'ArrowRight') setPaneWidth((width) => clampPreviewPaneWidth(width - 24))
    else if (event.key === 'Home') setPaneWidth(clampPreviewPaneWidth(DEFAULT_PREVIEW_PANE_WIDTH))
    else return
    event.preventDefault()
  }

  const handleTouchStart = (event) => {
    if (viewportWidth() >= 768) return
    const touch = event.touches?.[0]
    if (touch) touchStateRef.current = { startX: touch.clientX, startY: touch.clientY, currentX: touch.clientX, currentY: touch.clientY }
  }
  const handleTouchMove = (event) => {
    const touch = event.touches?.[0]
    if (!touchStateRef.current || !touch) return
    touchStateRef.current.currentX = touch.clientX
    touchStateRef.current.currentY = touch.clientY
  }
  const handleTouchEnd = () => {
    const touch = touchStateRef.current
    touchStateRef.current = null
    if (!touch || !onClose) return
    const deltaX = touch.startX - touch.currentX
    if (deltaX > 50 && deltaX > Math.abs(touch.startY - touch.currentY)) onClose()
  }

  return {
    view, setView, maximized, setMaximized, paneWidth, setPaneWidth,
    resizing, startResize, resizeWithKeyboard,
    handleTouchStart, handleTouchMove, handleTouchEnd,
  }
}

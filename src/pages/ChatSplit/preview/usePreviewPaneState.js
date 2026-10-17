import { useCallback, useEffect, useRef, useState } from 'react'
import { isCompositionEvent } from '../../../lib/compositionEvent.js'
import { isHtmlDeckLike } from '../../../lib/artifactPreview.js'
import { previewArtifactTabId } from './previewTabs.js'
import usePreviewContainerWidth from './usePreviewContainerWidth.js'
import { DEFAULT_PREVIEW_PANE_WIDTH, clampPreviewPaneWidth, normalizePreviewPanePreference, previewPaneLayout } from './previewPaneLayout.js'

export { DEFAULT_PREVIEW_PANE_WIDTH, MIN_PREVIEW_PANE_WIDTH, previewPaneMaxWidth, clampPreviewPaneWidth } from './previewPaneLayout.js'

export function isPresentationArtifact(artifact) {
  const preview = artifact?.preview
  return preview?.type === 'pptx' || (preview?.type === 'html' && isHtmlDeckLike(preview.html || ''))
}

function readStoredWidth() {
  try { return normalizePreviewPanePreference(localStorage.getItem('preview-pane-width')) }
  catch { return DEFAULT_PREVIEW_PANE_WIDTH }
}

export default function usePreviewPaneState({ artifact, embedded = false, onClose, paneRef }) {
  const [view, setView] = useState('preview')
  const [maximized, updateMaximized] = useState(() => isPresentationArtifact(artifact))
  const [preferredWidth, setPreferredWidth] = useState(readStoredWidth)
  const [resizing, setResizing] = useState(false)
  const dragStateRef = useRef(null)
  const touchStateRef = useRef(null)
  const previousArtifactRef = useRef(null)
  const stopResize = useCallback((event) => {
    const drag = dragStateRef.current
    if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return
    try { drag.target?.releasePointerCapture?.(drag.pointerId) } catch { /* pointer already ended */ }
    dragStateRef.current = null
    setResizing(false)
  }, [])
  const setMaximized = useCallback((value) => {
    stopResize()
    updateMaximized(value)
  }, [stopResize])
  const availableWidth = usePreviewContainerWidth(paneRef, stopResize)
  const layout = previewPaneLayout(preferredWidth, availableWidth, maximized, { embedded })
  const { paneWidth, overlay } = layout
  const setPaneWidth = useCallback((value) => {
    setPreferredWidth((current) => normalizePreviewPanePreference(typeof value === 'function'
      ? value(clampPreviewPaneWidth(current, availableWidth)) : value))
  }, [availableWidth])

  useEffect(() => {
    try { localStorage.setItem('preview-pane-width', String(preferredWidth)) } catch { /* ignore blocked storage */ }
  }, [preferredWidth])

  useEffect(() => {
    if (!onClose) return undefined
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isCompositionEvent(event)) return
      const pane = paneRef.current
      const activeElement = document.activeElement
      // A nested dialog/popover owns Escape first. The enclosing workbench
      // overlay is allowed through only because the preview itself lives inside
      // it; a settings modal outside the pane is not.
      const enclosingDialog = activeElement?.closest?.('[role="dialog"][aria-modal="true"]')
      if (enclosingDialog && !enclosingDialog.contains(pane)) return
      const outsideDialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (outsideDialog && !outsideDialog.contains(pane)) return
      const outsidePopover = document.querySelector('[data-host-popover]')
      if (outsidePopover && !outsidePopover.contains(pane)) return
      const focusInside = Boolean(pane?.contains(activeElement))
      // Embedded side previews do not steal Escape from the composer or a
      // picker. A focused/overlay preview, a key press while it owns focus, or
      // a document-level Escape with no focused control still closes; the
      // legacy global-Escape test and keyboard dismissal use the latter.
      if (!overlay && !maximized && !focusInside && activeElement !== document.body) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [maximized, onClose, overlay, paneRef])

  useEffect(() => {
    if (artifact === previousArtifactRef.current) return
    const previousArtifact = previousArtifactRef.current
    previousArtifactRef.current = artifact
    // A cache revision refreshes the bytes in this same tab. It must not reset
    // the user's maximized pane or source/preview selection.
    if (previousArtifact?.directFile && artifact?.directFile
      && previewArtifactTabId(previousArtifact) === previewArtifactTabId(artifact)) return
    setView('preview')
    setMaximized(isPresentationArtifact(artifact))
  }, [artifact, setMaximized])

  useEffect(() => {
    if (!resizing) return undefined
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    const onMove = (event) => {
      const drag = dragStateRef.current
      if (!drag || (event.pointerId != null && event.pointerId !== drag.pointerId)) return
      setPaneWidth(clampPreviewPaneWidth(drag.startWidth + drag.startX - event.clientX, availableWidth))
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      const drag = dragStateRef.current
      try { drag?.target?.releasePointerCapture?.(drag.pointerId) } catch { /* pointer already ended */ }
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [resizing, availableWidth, setPaneWidth, stopResize])

  const startResize = (event) => {
    if (event.button !== 0 || overlay) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    dragStateRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: paneWidth, target: event.currentTarget }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setResizing(true)
  }

  const resizeWithKeyboard = (event) => {
    if (overlay) return
    if (event.key === 'ArrowLeft') setPaneWidth((width) => clampPreviewPaneWidth(width + 24, availableWidth))
    else if (event.key === 'ArrowRight') setPaneWidth((width) => clampPreviewPaneWidth(width - 24, availableWidth))
    else if (event.key === 'Home') setPaneWidth(DEFAULT_PREVIEW_PANE_WIDTH)
    else if (event.key === 'End') setPaneWidth(layout.maxPaneWidth)
    else return
    event.preventDefault()
  }

  const handleTouchStart = (event) => {
    if (!overlay) return
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
    view, setView, maximized, setMaximized, ...layout, availableWidth, setPaneWidth,
    resizing, startResize, resizeWithKeyboard,
    handleTouchStart, handleTouchMove, handleTouchEnd,
  }
}

import { useEffect, useRef, useState } from 'react'
import { isHtmlDeckLike } from '../../../lib/artifactPreview.js'

export function isPresentationArtifact(artifact) {
  const preview = artifact?.preview
  return preview?.type === 'pptx' || (preview?.type === 'html' && isHtmlDeckLike(preview.html || ''))
}

export default function usePreviewPaneState({ artifact, onClose }) {
  const [view, setView] = useState('preview')
  const [maximized, setMaximized] = useState(() => isPresentationArtifact(artifact))
  const [paneWidth, setPaneWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('preview-pane-width'))
      if (Number.isFinite(saved) && saved >= 360 && saved <= 900) return saved
    } catch { /* ignore blocked storage */ }
    return 520
  })
  const dragStateRef = useRef(null)
  const touchStateRef = useRef(null)
  const previousArtifactKey = useRef('')

  useEffect(() => {
    try { localStorage.setItem('preview-pane-width', String(paneWidth)) } catch { /* ignore blocked storage */ }
  }, [paneWidth])
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
    const key = `${artifact?.messageId || ''}:${artifact?.preview?.type || ''}`
    if (key === previousArtifactKey.current) return
    previousArtifactKey.current = key
    setView('preview')
    setMaximized(isPresentationArtifact(artifact))
  }, [artifact])

  const startResize = (event) => {
    event.preventDefault()
    dragStateRef.current = { startX: event.clientX, startWidth: paneWidth }
    const onMove = (moveEvent) => {
      if (!dragStateRef.current) return
      const delta = dragStateRef.current.startX - moveEvent.clientX
      setPaneWidth(Math.min(900, Math.max(360, dragStateRef.current.startWidth + delta)))
    }
    const onUp = () => {
      dragStateRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  const handleTouchStart = (event) => {
    if (typeof window !== 'undefined' && window.innerWidth >= 768) return
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
  return { view, setView, maximized, setMaximized, paneWidth, setPaneWidth, startResize, handleTouchStart, handleTouchMove, handleTouchEnd }
}

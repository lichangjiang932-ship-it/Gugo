import { useEffect, useRef, useState } from 'react'
import { Cat, X } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import {
  clampDesktopPetPosition,
  deriveDesktopPetStatus,
  persistDesktopPetPosition,
  readDesktopPetPosition,
} from './desktopPetState.js'

const DRAG_THRESHOLD = 5

const STATUS_DOT_CLASS = {
  idle: 'bg-ink-fade',
  thinking: 'bg-cyan',
  tool: 'bg-amber-500',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
}

export default function DesktopPet({
  onClose,
  isGenerating = false,
  messages = [],
  tasks = [],
  toolApproval = null,
}) {
  const { t } = useT()
  const [hiddenStatus, setHiddenStatus] = useState(null)
  const [position, setPosition] = useState(readDesktopPetPosition)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(null)
  const suppressClickRef = useRef(false)
  const status = deriveDesktopPetStatus({ isGenerating, messages, tasks, toolApproval })
  const statusKey = `desktopPet.status.${status.kind}`
  const statusLabel = status.kind === 'tool'
    ? t(statusKey, { tool: status.tool || t('desktopPet.unknownTool') })
    : t(statusKey)
  const speaking = hiddenStatus !== status.kind

  useEffect(() => {
    const keepVisible = () => {
      setPosition((current) => {
        const next = clampDesktopPetPosition(current)
        if (next.x === current.x && next.y === current.y) return current
        persistDesktopPetPosition(next)
        return next
      })
    }
    window.addEventListener('resize', keepVisible)
    return () => window.removeEventListener('resize', keepVisible)
  }, [])

  const positionForPointer = (event, drag) => clampDesktopPetPosition({
    x: drag.origin.x + event.clientX - drag.pointer.x,
    y: drag.origin.y + event.clientY - drag.pointer.y,
  })

  const handlePointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      pointer: { x: event.clientX, y: event.clientY },
      origin: position,
      moved: false,
    }
    setDragging(true)
  }

  const handlePointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.clientX - drag.pointer.x, event.clientY - drag.pointer.y)
    if (!drag.moved && distance < DRAG_THRESHOLD) return
    drag.moved = true
    setPosition(positionForPointer(event, drag))
  }

  const finishDrag = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (drag.moved) {
      const next = positionForPointer(event, drag)
      suppressClickRef.current = true
      setPosition(next)
      persistDesktopPetPosition(next)
    }
    dragRef.current = null
    setDragging(false)
  }

  const handlePetClick = (event) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      event.preventDefault()
      return
    }
    setHiddenStatus((current) => (current === status.kind ? null : status.kind))
  }

  const bubbleBelow = position.y < 104
  const bubbleOnRight = position.x < 224

  return (
    <div
      data-testid="desktop-pet"
      data-status={status.kind}
      className="fixed z-40 h-14 w-14 select-none"
      style={{ left: position.x, top: position.y }}
    >
      {speaking && (
        <div
          role="status"
          aria-live="polite"
          data-testid="desktop-pet-status"
          className={`pointer-events-none absolute flex min-w-36 max-w-56 items-center gap-2 rounded-2xl border border-ink/10 bg-paper px-3 py-2 text-xs text-ink-soft shadow-lg ${bubbleBelow ? 'top-16' : 'bottom-16'} ${bubbleOnRight ? 'left-0' : 'right-0'}`}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[status.kind]} ${['thinking', 'tool'].includes(status.kind) ? 'motion-safe:animate-pulse' : ''}`} aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
      )}

      <button
        type="button"
        data-testid="desktop-pet-handle"
        onClick={handlePetClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        aria-label={t('desktopPet.handle', { status: statusLabel })}
        title={t('desktopPet.handle', { status: statusLabel })}
        className={`relative flex h-14 w-14 touch-none items-center justify-center rounded-full border border-ink/10 bg-paper text-ink-soft shadow-[0_10px_30px_rgb(var(--color-ink-rgb)/0.16)] transition-transform hover:scale-105 hover:text-ink active:scale-95 ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        <Cat className="h-7 w-7" strokeWidth={1.7} />
        <span className={`absolute bottom-1.5 right-1.5 h-2.5 w-2.5 rounded-full border-2 border-paper ${STATUS_DOT_CLASS[status.kind]}`} aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={onClose}
        aria-label={t('desktopPet.close')}
        title={t('desktopPet.close')}
        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink/75 text-paper shadow-sm transition-colors hover:bg-ink"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

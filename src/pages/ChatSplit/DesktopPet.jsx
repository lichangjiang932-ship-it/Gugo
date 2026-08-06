import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import {
  clampDesktopPetPosition,
  desktopPetViewport,
  deriveDesktopPetStatus,
  persistDesktopPetPosition,
  readDesktopPetPosition,
} from './desktopPetState.js'

const DRAG_THRESHOLD = 5

// Codex 标准 8×9 精灵表：8 列 × 9 行，每格 192×208
const SPRITESHEET_URL = '/pets/boba/spritesheet.webp'
const SPRITE_COLS = 8
const SPRITE_ROW_HEIGHT = 208
const SPRITE_FRAME_W = 192
const SPRITE_FRAME_H = 208
const SPRITE_SCALE = 0.38 // 显示高度 ≈ 79px

// 状态 kind → 精灵表行（0 idle / 3 wave / 4 jump / 5 failed / 6 waiting / 7 thinking）
const STATUS_ROW = {
  idle: 0,
  thinking: 7,
  tool: 6,
  completed: 4,
  failed: 5,
}

const STATUS_DOT_CLASS = {
  idle: 'bg-ink-fade',
  thinking: 'bg-cyan',
  tool: 'bg-amber-500',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
}

const STATUS_ACCENT_CLASS = {
  idle: 'text-ink-fade',
  thinking: 'text-cyan',
  tool: 'text-amber-500',
  completed: 'text-emerald-500',
  failed: 'text-red-500',
}

const FRAME_INTERVAL_MS = 110

/**
 * Codex 风格精灵表动画播放器。
 * 从 8×9 精灵表中按状态取一行，循环播放该行的 8 帧。
 * prefers-reduced-motion 时停在第 0 帧（静态展示）。
 */
function PetSprite({ status }) {
  const row = STATUS_ROW[status] ?? 0
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined
    }
    const timer = window.setInterval(() => {
      setFrame((current) => (current + 1) % SPRITE_COLS)
    }, FRAME_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [row])

  return (
    <span
      className="desktop-pet-sprite block overflow-hidden"
      style={{
        width: SPRITE_FRAME_W * SPRITE_SCALE,
        height: SPRITE_FRAME_H * SPRITE_SCALE,
        backgroundImage: `url(${SPRITESHEET_URL})`,
        backgroundSize: `${SPRITE_FRAME_W * SPRITE_COLS * SPRITE_SCALE}px ${SPRITE_ROW_HEIGHT * 9 * SPRITE_SCALE}px`,
        backgroundPosition: `-${frame * SPRITE_FRAME_W * SPRITE_SCALE}px -${row * SPRITE_ROW_HEIGHT * SPRITE_SCALE}px`,
        imageRendering: 'pixelated',
      }}
      aria-hidden="true"
    />
  )
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
  const activityLabel = t(`desktopPet.activity.${status.kind}`)
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

  const handleKeyDown = (event) => {
    const distance = event.shiftKey ? 24 : 8
    const delta = {
      ArrowDown: { x: 0, y: distance },
      ArrowLeft: { x: -distance, y: 0 },
      ArrowRight: { x: distance, y: 0 },
      ArrowUp: { x: 0, y: -distance },
    }[event.key]
    if (!delta) return
    event.preventDefault()
    setPosition((current) => {
      const next = clampDesktopPetPosition({ x: current.x + delta.x, y: current.y + delta.y })
      if (next.x === current.x && next.y === current.y) return current
      persistDesktopPetPosition(next)
      return next
    })
  }

  const bubbleBelow = position.y < 120
  const bubbleOnRight = position.x + 36 < desktopPetViewport().width / 2

  return (
    <div
      data-testid="desktop-pet"
      data-status={status.kind}
      data-dragging={dragging ? 'true' : 'false'}
      className={`desktop-pet fixed z-40 select-none ${STATUS_ACCENT_CLASS[status.kind]}`}
      style={{ left: position.x, top: position.y }}
    >
      {speaking && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="desktop-pet-status"
          className={`desktop-pet-bubble pointer-events-none absolute flex items-start gap-2.5 rounded-2xl border border-ink/10 bg-paper px-3 py-2.5 text-left shadow-lg ${bubbleBelow ? 'desktop-pet-bubble-below top-[84px]' : 'desktop-pet-bubble-above bottom-[84px]'} ${bubbleOnRight ? 'desktop-pet-bubble-right left-0' : 'desktop-pet-bubble-left right-0'}`}
        >
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[status.kind]} ${['thinking', 'tool'].includes(status.kind) ? 'motion-safe:animate-pulse' : ''}`} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-ink">{statusLabel}</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-ink-fade">{activityLabel}</span>
          </span>
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
        onKeyDown={handleKeyDown}
        aria-label={t('desktopPet.handle', { status: statusLabel })}
        title={t('desktopPet.handle', { status: statusLabel })}
        className={`desktop-pet-handle relative flex touch-none items-center justify-center rounded-[1.4rem] border border-ink/10 bg-paper/95 text-current shadow-[0_12px_34px_rgb(var(--color-ink-rgb)/0.18)] transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_16px_38px_rgb(var(--color-ink-rgb)/0.22)] active:translate-y-0 ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        <PetSprite status={status.kind} />
        <span className={`absolute bottom-1.5 right-1.5 h-3 w-3 rounded-full border-2 border-paper ${STATUS_DOT_CLASS[status.kind]}`} aria-hidden="true" />
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

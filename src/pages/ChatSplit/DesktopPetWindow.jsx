import { useEffect, useRef, useState } from 'react'
import { readDesktopPetPreferences } from '../../lib/desktopPetPreferences.js'
import { useT } from '../../i18n/I18nProvider.jsx'
import { resolveDesktopPetLayout } from '../../../shared/desktopPetLayout.js'

const DEFAULT_SPRITE = '/pets/boba/spritesheet.webp'
const STATUS_ROW = { idle: 0, thinking: 7, tool: 6, completed: 4, failed: 5 }
const SPRITE_FRAMES = 8
const SPRITE_ROWS = 9
const FRAME_INTERVAL_MS = 110
const DRAG_THRESHOLD = 5
const INTERACTION_ROWS = [3, 8, 2]
const INTERACTION_DURATION_MS = 1_100

export default function DesktopPetWindow() {
  const { t } = useT()
  const [state, setState] = useState({ visible: true, status: { kind: 'idle', tool: '' } })
  const [preferences, setPreferences] = useState(readDesktopPetPreferences)
  const [reactionRow, setReactionRow] = useState(null)
  const spriteRef = useRef(null)
  const dragRef = useRef(null)
  const suppressClickRef = useRef(false)
  const reactionIndexRef = useRef(0)
  const reactionTimerRef = useRef(null)
  const kind = state.status?.kind || 'idle'
  const activeRow = reactionRow ?? (STATUS_ROW[kind] || 0)
  const layout = resolveDesktopPetLayout({
    customImage: Boolean(preferences.customImage),
    scale: preferences.scale,
  })

  useEffect(() => {
    const receiveState = (next) => setState((current) => {
      const visible = next?.visible !== false
      const nextKind = next?.status?.kind || 'idle'
      const tool = nextKind === 'tool' ? String(next?.status?.tool || '') : ''
      if (current.visible === visible && current.status.kind === nextKind && current.status.tool === tool) return current
      return { visible, status: { kind: nextKind, tool } }
    })
    const initial = window.gugoDesktop?.getPetState?.()
    initial?.then(receiveState).catch(() => {})
    return window.gugoDesktop?.onPetState?.(receiveState)
  }, [])

  useEffect(() => {
    const refresh = () => setPreferences((current) => {
      const next = readDesktopPetPreferences()
      return current.customImage === next.customImage && current.scale === next.scale ? current : next
    })
    window.addEventListener('storage', refresh)
    window.addEventListener('gugo:desktop-pet-preferences', refresh)
    return () => {
      window.removeEventListener('storage', refresh)
      window.removeEventListener('gugo:desktop-pet-preferences', refresh)
    }
  }, [])

  useEffect(() => {
    const resize = window.gugoDesktop?.resizePetWindow?.({
      customImage: Boolean(preferences.customImage),
      scale: preferences.scale,
    })
    resize?.catch(() => {})
  }, [preferences.customImage, preferences.scale])

  useEffect(() => () => window.clearTimeout(reactionTimerRef.current), [])

  useEffect(() => {
    const sprite = spriteRef.current
    if (!sprite || preferences.customImage) return undefined
    let frame = 0
    const drawFrame = () => {
      sprite.style.backgroundPositionX = `-${frame * layout.contentWidth}px`
    }
    drawFrame()
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    const timer = window.setInterval(() => {
      frame = (frame + 1) % SPRITE_FRAMES
      drawFrame()
    }, FRAME_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [activeRow, layout.contentWidth, preferences.customImage])

  const playInteraction = () => {
    window.clearTimeout(reactionTimerRef.current)
    const row = INTERACTION_ROWS[reactionIndexRef.current % INTERACTION_ROWS.length]
    reactionIndexRef.current += 1
    setReactionRow(row)
    reactionTimerRef.current = window.setTimeout(() => setReactionRow(null), INTERACTION_DURATION_MS)
  }

  const sendDrag = (phase, event) => window.gugoDesktop?.dragPetWindow?.({
    phase,
    screenX: event.screenX,
    screenY: event.screenY,
  })

  const handlePointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      moved: false,
    }
    sendDrag('start', event)
  }

  const handlePointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY)
    if (!drag.moved && distance < DRAG_THRESHOLD) return
    drag.moved = true
    sendDrag('move', event)
  }

  const finishPointer = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    suppressClickRef.current = drag.moved
    sendDrag('end', event)
    dragRef.current = null
  }

  const handleClick = (event) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      event.preventDefault()
      return
    }
    playInteraction()
  }

  const handleKeyDown = (event) => {
    if (!['Enter', ' '].includes(event.key)) return
    event.preventDefault()
    playInteraction()
  }

  const statusLabel = kind === 'tool'
    ? t('desktopPet.status.tool', { tool: state.status.tool || t('desktopPet.unknownTool') })
    : t(`desktopPet.status.${kind}`)

  return (
    <main
      className="pet-window-root"
      data-status={kind}
      data-reacting={reactionRow == null ? 'false' : 'true'}
      role="button"
      tabIndex={0}
      aria-label={statusLabel}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
    >
      {preferences.customImage ? (
        <img
          className="pet-window-custom"
          src={preferences.customImage}
          alt=""
          draggable="false"
          aria-hidden="true"
          style={{ width: layout.contentWidth, height: layout.contentHeight }}
        />
      ) : (
        <span
          ref={spriteRef}
          className="pet-window-sprite"
          style={{
            width: layout.contentWidth,
            height: layout.contentHeight,
            backgroundImage: `url(${DEFAULT_SPRITE})`,
            backgroundPositionX: 0,
            backgroundPositionY: `-${activeRow * layout.contentHeight}px`,
            backgroundSize: `${layout.contentWidth * SPRITE_FRAMES}px ${layout.contentHeight * SPRITE_ROWS}px`,
          }}
          aria-hidden="true"
        />
      )}
    </main>
  )
}

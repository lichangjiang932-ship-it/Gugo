import { useCallback, useEffect, useRef, useState } from 'react'
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

function sendDrag(phase, event = {}) {
  window.gugoDesktop?.dragPetWindow?.({
    phase,
    screenX: Number(event?.screenX) || 0,
    screenY: Number(event?.screenY) || 0,
  })
}

function captureActivePointer(drag) {
  if (!drag || typeof drag.target?.setPointerCapture !== 'function') return false
  try {
    drag.target.setPointerCapture(drag.pointerId)
    drag.captured = typeof drag.target.hasPointerCapture !== 'function'
      || drag.target.hasPointerCapture(drag.pointerId)
  } catch {
    drag.captured = false
  }
  return drag.captured
}

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

  const finishActiveDrag = useCallback((event, { cancelled = false, releaseCapture = true } = {}) => {
    const drag = dragRef.current
    if (!drag) return false
    const pointerId = Number(event?.pointerId)
    if (Number.isFinite(pointerId) && pointerId !== drag.pointerId) return false

    // Clear first: releasePointerCapture may synchronously emit lostpointercapture.
    dragRef.current = null
    if (releaseCapture && drag.captured) {
      try {
        const stillCaptured = typeof drag.target?.hasPointerCapture !== 'function'
          || drag.target.hasPointerCapture(drag.pointerId)
        if (stillCaptured) drag.target?.releasePointerCapture?.(drag.pointerId)
      } catch { /* the capture was already released by Chromium */ }
    }
    suppressClickRef.current = !cancelled && drag.moved
    sendDrag('end', event)
    return true
  }, [])

  useEffect(() => {
    const finishPointer = (event) => finishActiveDrag(event, { cancelled: event.type !== 'pointerup' })
    const finishMouse = (event) => finishActiveDrag(event, { cancelled: false })
    const cancel = () => finishActiveDrag(null, { cancelled: true })
    const cancelWhenHidden = () => {
      if (document.visibilityState !== 'visible') cancel()
    }
    window.addEventListener('pointerup', finishPointer, true)
    window.addEventListener('pointercancel', finishPointer, true)
    window.addEventListener('mouseup', finishMouse, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('pagehide', cancel)
    document.addEventListener('visibilitychange', cancelWhenHidden)
    const unsubscribeMain = window.gugoDesktop?.onPetDragCancel?.(cancel)
    return () => {
      window.removeEventListener('pointerup', finishPointer, true)
      window.removeEventListener('pointercancel', finishPointer, true)
      window.removeEventListener('mouseup', finishMouse, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pagehide', cancel)
      document.removeEventListener('visibilitychange', cancelWhenHidden)
      unsubscribeMain?.()
      cancel()
    }
  }, [finishActiveDrag])

  const handlePointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    finishActiveDrag(null, { cancelled: true })
    const drag = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      moved: false,
      captured: false,
      target: event.currentTarget,
    }
    dragRef.current = drag
    // Capture before the pointer can outrun this tiny transparent window. Waiting
    // for the drag threshold loses fast drags at the window edge on Windows.
    captureActivePointer(drag)
    sendDrag('start', event)
  }

  const handlePointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.pointerType === 'mouse' && Number.isFinite(event.buttons) && (event.buttons & 1) === 0) {
      finishActiveDrag(event, { cancelled: false })
      return
    }
    // Moving a frameless BrowserWindow can make Chromium drop capture. Re-acquire
    // it on the next event instead of mistaking that transition for mouse-up.
    if (!drag.captured) captureActivePointer(drag)
    const distance = Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY)
    if (!drag.moved && distance < DRAG_THRESHOLD) return
    drag.moved = true
    sendDrag('move', event)
  }

  const finishPointer = (event) => {
    finishActiveDrag(event, { cancelled: event.type !== 'pointerup' })
  }

  const handleLostPointerCapture = (event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.captured = false
    if (event.pointerType === 'mouse' && Number.isFinite(event.buttons) && (event.buttons & 1) === 0) {
      finishActiveDrag(event, { cancelled: false, releaseCapture: false })
    }
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

  const handleContextMenu = (event) => {
    event.preventDefault()
    finishActiveDrag(null, { cancelled: true })
    window.gugoDesktop?.showPetMenu?.().catch?.(() => {})
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
      onLostPointerCapture={handleLostPointerCapture}
      onContextMenu={handleContextMenu}
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

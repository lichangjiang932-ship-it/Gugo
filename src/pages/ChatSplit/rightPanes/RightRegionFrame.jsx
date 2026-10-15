import { useCallback, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import useModalFocusTrap from '../../../lib/useModalFocusTrap.js'

function OverlayFocusBoundary({ dialogRef, onClose }) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  const close = useCallback(() => closeRef.current?.(), [])
  useModalFocusTrap({ dialogRef, onClose: close, restoreFocusSelector: '[data-testid="workbench-toggle"]' })
  return null
}

/** Keep one mounted pane tree: resizing must not restart terminal/browser connections. */
export default function RightRegionFrame({ children, onClose, overlay, t, width }) {
  const dialogRef = useRef(null)
  return <div
    data-testid={overlay ? 'right-region-overlay' : undefined}
    className={overlay ? 'modal-overlay !p-3' : 'contents'}
    onMouseDown={(event) => {
      if (overlay && event.target === event.currentTarget) onClose?.()
    }}
  >
    <div
      ref={dialogRef}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? true : undefined}
      aria-label={overlay ? t('workbench.title') : undefined}
      tabIndex={overlay ? -1 : undefined}
      className={overlay ? 'modal-base flex h-[calc(100dvh-1.5rem)] max-w-none flex-col overflow-hidden !p-0' : 'contents'}
      style={overlay ? { width: `${width}px` } : undefined}
    >
      {overlay && <div className="flex shrink-0 justify-end border-b border-ink/10 p-2">
        <button type="button" data-testid="right-region-overlay-close" onClick={onClose}
          className="flex h-8 items-center gap-1.5 rounded-control px-2 text-xs text-ink-soft hover:bg-paper-2">
          <X className="h-4 w-4" aria-hidden="true" />{t('workbench.backToConversation')}
        </button>
      </div>}
      {children}
      {overlay && <OverlayFocusBoundary dialogRef={dialogRef} onClose={onClose} />}
    </div>
  </div>
}

import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import useModalFocusTrap from '../lib/useModalFocusTrap.js'

function joinClasses(...values) {
  return values.filter(Boolean).join(' ')
}

function ModalPortal({
  ariaDescribedby,
  ariaLabel,
  ariaLabelledby,
  children,
  className,
  closeOnBackdrop,
  dataModalLayer,
  dialogProps,
  initialFocusRef,
  onClose,
  overlayClassName,
  overlayProps,
  portalTarget,
  restoreFocusSelector,
  testId,
}) {
  const dialogRef = useRef(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  const requestClose = useCallback(() => {
    onCloseRef.current?.()
  }, [])

  useModalFocusTrap({
    dialogRef,
    initialFocusRef,
    onClose: requestClose,
    restoreFocusSelector,
  })

  const handleBackdropMouseDown = (event) => {
    overlayProps?.onMouseDown?.(event)
    if (
      !event.defaultPrevented
      && closeOnBackdrop
      && event.target === event.currentTarget
    ) requestClose()
  }

  const target = portalTarget || document.body
  return createPortal(
    <div
      {...overlayProps}
      className={joinClasses('modal-overlay', overlayClassName, overlayProps?.className)}
      data-testid={testId || overlayProps?.['data-testid']}
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        {...dialogProps}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        data-modal-layer={dataModalLayer}
        tabIndex={dialogProps?.tabIndex ?? -1}
        className={joinClasses('modal-base', className, dialogProps?.className)}
      >
        {children}
      </div>
    </div>,
    target,
  )
}

export default function Modal({
  open = true,
  closeOnBackdrop = true,
  ...props
}) {
  if (!open || typeof document === 'undefined') return null
  return <ModalPortal {...props} closeOnBackdrop={closeOnBackdrop} />
}

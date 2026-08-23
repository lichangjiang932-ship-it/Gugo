import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusWithoutScrolling(element) {
  if (typeof element?.focus !== 'function') return false
  try {
    element.focus({ preventScroll: true })
  } catch {
    element.focus()
  }
  return true
}

export function getModalFocusableElements(dialog) {
  if (!dialog?.querySelectorAll) return []
  return [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => (
    element.tabIndex >= 0
    && !element.closest('[hidden], [aria-hidden="true"], [inert]')
  ))
}

function cancelScheduledRestore(scheduled) {
  if (!scheduled) return
  if (scheduled.kind === 'animation-frame') window.cancelAnimationFrame(scheduled.id)
  else window.clearTimeout(scheduled.id)
}

function scheduleRestore(callback) {
  if (typeof window.requestAnimationFrame === 'function') {
    return { kind: 'animation-frame', id: window.requestAnimationFrame(callback) }
  }
  return { kind: 'timeout', id: window.setTimeout(callback, 0) }
}

function isolateModalBackground(dialog) {
  const records = []
  let activeBranch = dialog
  let parent = dialog.parentElement
  while (parent) {
    for (const sibling of parent.children) {
      if (sibling === activeBranch) continue
      records.push({
        element: sibling,
        inert: sibling.getAttribute('inert'),
        ariaHidden: sibling.getAttribute('aria-hidden'),
      })
      sibling.setAttribute('inert', '')
      sibling.setAttribute('aria-hidden', 'true')
    }
    if (parent === document.body) break
    activeBranch = parent
    parent = parent.parentElement
  }
  return () => {
    for (const record of records) {
      if (record.inert == null) record.element.removeAttribute('inert')
      else record.element.setAttribute('inert', record.inert)
      if (record.ariaHidden == null) record.element.removeAttribute('aria-hidden')
      else record.element.setAttribute('aria-hidden', record.ariaHidden)
    }
  }
}

export default function useModalFocusTrap({
  dialogRef,
  initialFocusRef,
  onClose,
  restoreFocusSelector,
}) {
  const scheduledRestoreRef = useRef(null)

  useEffect(() => {
    cancelScheduledRestore(scheduledRestoreRef.current)
    scheduledRestoreRef.current = null

    const dialog = dialogRef.current
    if (!dialog) return undefined
    const previouslyFocused = document.activeElement
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const restoreBackground = isolateModalBackground(dialog)

    const initialFocus = initialFocusRef?.current || getModalFocusableElements(dialog)[0] || dialog
    focusWithoutScrolling(initialFocus)

    const keepFocusInside = (event) => {
      if (dialog.contains(event.target)) return
      const next = initialFocusRef?.current || getModalFocusableElements(dialog)[0] || dialog
      focusWithoutScrolling(next)
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        const nestedDialog = event.target?.closest?.('[data-modal-layer="nested"][role="dialog"]')
        if (nestedDialog && dialog.contains(nestedDialog)) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = getModalFocusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        focusWithoutScrolling(dialog)
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (!dialog.contains(active)) {
        event.preventDefault()
        focusWithoutScrolling(event.shiftKey ? last : first)
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        focusWithoutScrolling(last)
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        focusWithoutScrolling(first)
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', keepFocusInside, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', keepFocusInside, true)
      restoreBackground()
      document.body.style.overflow = previousBodyOverflow
      scheduledRestoreRef.current = scheduleRestore(() => {
        const canRestorePrevious = previouslyFocused
          && previouslyFocused !== document.body
          && previouslyFocused !== document.documentElement
          && previouslyFocused.isConnected
          && !dialog.contains(previouslyFocused)
        const fallback = restoreFocusSelector
          ? document.querySelector(restoreFocusSelector)
          : null
        focusWithoutScrolling(canRestorePrevious ? previouslyFocused : fallback)
        scheduledRestoreRef.current = null
      })
    }
  }, [dialogRef, initialFocusRef, onClose, restoreFocusSelector])
}

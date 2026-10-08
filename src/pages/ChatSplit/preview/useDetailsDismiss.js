import { useEffect } from 'react'

/**
 * A <details> menu closes when the reader presses outside it, like any other
 * menu; the element alone only closes when its own summary is clicked. Nested
 * disclosures inside it close with it, so it reopens at the top level. Escape
 * stays with each menu's own key handler.
 */
export default function useDetailsDismiss(detailsRef) {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const dismiss = (event) => {
      const details = detailsRef.current
      if (!details?.open || details.contains(event.target)) return
      for (const nested of details.querySelectorAll('details[open]')) nested.open = false
      details.open = false
    }
    // Capture: a control that stops propagation must not keep a menu open.
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [detailsRef])
}

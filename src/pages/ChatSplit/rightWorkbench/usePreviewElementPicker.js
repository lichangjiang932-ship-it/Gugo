import { useCallback, useEffect, useRef, useState } from 'react'

import { copyTextToClipboard } from '../../../lib/clipboard.js'
import { isDesktopPageFactsAvailable } from '../../../lib/desktopBrowserClient.js'
import { cancelPreviewElementPick, describePickedElement, pickPreviewElement } from '../../../lib/previewElementPicker.js'

/**
 * The reader's side of element picking: press, point, and the page answers.
 *
 * A picked element is handed over three ways because each answers a different
 * next move — into the composer, so the agent is told about it in the message
 * that follows; into the clipboard, so it can be pasted anywhere; and into a
 * toast, so the reader sees what they picked without opening anything.
 *
 * The panel is the only thing that can see the page, so the control is offered
 * only where that panel is a real browser view.
 */
export default function usePreviewElementPicker({ insertText, t, toast } = {}) {
  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)

  useEffect(() => () => {
    // Unmounting mid-pick would leave the overlay on a page nobody is editing.
    if (pickingRef.current) void cancelPreviewElementPick()
  }, [])

  const toggle = useCallback(async () => {
    if (!isDesktopPageFactsAvailable()) return
    if (pickingRef.current) {
      pickingRef.current = false
      setPicking(false)
      await cancelPreviewElementPick()
      return
    }
    pickingRef.current = true
    setPicking(true)
    const outcome = await pickPreviewElement()
    pickingRef.current = false
    setPicking(false)
    if (!outcome?.ok) {
      if (outcome?.reason === 'cancelled') return
      toast?.error?.(t(outcome?.reason === 'timeout' ? 'workbench.previewPickTimeout' : 'workbench.previewPickFailed'))
      return
    }
    const described = describePickedElement(outcome.picked)
    if (!described) {
      toast?.error?.(t('workbench.previewPickFailed'))
      return
    }
    insertText?.(described)
    void copyTextToClipboard(described)
    toast?.success?.(t('workbench.previewPicked', { element: described }))
  }, [insertText, t, toast])

  return { picking, toggle }
}

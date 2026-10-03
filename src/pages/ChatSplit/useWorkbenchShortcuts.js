import { useEffect } from 'react'
import { matchWorkbenchShortcut } from '../../lib/workbenchShortcuts.js'
import { matchPreviewShortcut } from '../../lib/previewShortcuts.js'

/**
 * The tool keys and the preview key, bound on the chat surface.
 *
 * They live here rather than in the app's global shortcut host for two reasons:
 * the host is deliberately not mounted (see the gate in tests/codingWorkbenchUi),
 * and these keys act on the workbench's own state, which belongs to this page.
 * Binding them where the state is also means a key can only ever do what the
 * button beside it does — it calls the same two setters.
 */
export default function useWorkbenchShortcuts({ enabled = true, onOpenPreview, onSelectTool }) {
  useEffect(() => {
    if (!enabled) return undefined
    const onKeyDown = (event) => {
      if (matchPreviewShortcut(event)) {
        event.preventDefault()
        onOpenPreview?.()
        return
      }
      const tool = matchWorkbenchShortcut(event)
      if (!tool) return
      // A real browser owns Ctrl+T for "new tab" and will not deliver it here,
      // so that one only works in the desktop shell. The handler still claims it
      // when it does arrive, so the tooltip is not a promise the app ignores.
      event.preventDefault()
      onSelectTool?.(tool)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, onOpenPreview, onSelectTool])
}

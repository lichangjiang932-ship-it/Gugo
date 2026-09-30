import { shortcutLabelFor } from './workbenchShortcuts.js'

/**
 * The key that opens the preview panel.
 *
 * Ctrl+Shift+P rather than the workbench tools' Ctrl+Alt chords because this is
 * the one preview key the reference product binds, and because it has to be the
 * same key in the desktop shell and in a browser tab: the sidebar's own tools are
 * one press away on the entry page, while opening the preview is a deliberate
 * change of what the reader is looking at.
 */
export const PREVIEW_SHORTCUT = Object.freeze({
  ctrl: true,
  shift: true,
  key: 'p',
  labelKey: 'workbench.preview',
})

export function previewShortcutLabel(options = {}) {
  return shortcutLabelFor(PREVIEW_SHORTCUT, options)
}

/**
 * Whether this key event is the preview key. Kept as strict as the workbench
 * matcher: anything else held at the same time is a different combination, not
 * this one.
 */
export function matchPreviewShortcut(event) {
  if (!event || typeof event.key !== 'string') return false
  if (!event.ctrlKey || !event.shiftKey) return false
  if (event.altKey || event.metaKey) return false
  return event.key.toLowerCase() === 'p'
}

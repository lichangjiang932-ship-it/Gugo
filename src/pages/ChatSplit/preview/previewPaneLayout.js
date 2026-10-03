export const DEFAULT_PREVIEW_PANE_WIDTH = 520
export const MIN_PREVIEW_PANE_WIDTH = 360
export const MAX_PREVIEW_PANE_WIDTH = 900
export const MIN_PREVIEW_CHAT_WIDTH = 480
export const MIN_SPLIT_PREVIEW_WIDTH = MIN_PREVIEW_PANE_WIDTH + MIN_PREVIEW_CHAT_WIDTH

export function previewViewportWidth() {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

export function normalizePreviewPanePreference(value) {
  const numeric = Number(value)
  return Math.min(MAX_PREVIEW_PANE_WIDTH, Math.max(MIN_PREVIEW_PANE_WIDTH,
    Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_PREVIEW_PANE_WIDTH))
}

export function previewPaneMaxWidth(availableWidth = previewViewportWidth()) {
  return Math.max(MIN_PREVIEW_PANE_WIDTH, Math.min(MAX_PREVIEW_PANE_WIDTH,
    Number(availableWidth) - MIN_PREVIEW_CHAT_WIDTH))
}

export function clampPreviewPaneWidth(value, availableWidth = previewViewportWidth()) {
  return Math.min(previewPaneMaxWidth(availableWidth), normalizePreviewPanePreference(value))
}

export function previewPaneLayout(preferredWidth, availableWidth, maximized = false) {
  const focused = !maximized && availableWidth < MIN_SPLIT_PREVIEW_WIDTH
  return {
    focused,
    overlay: maximized || focused,
    maxPaneWidth: previewPaneMaxWidth(availableWidth),
    paneWidth: clampPreviewPaneWidth(preferredWidth, availableWidth),
  }
}

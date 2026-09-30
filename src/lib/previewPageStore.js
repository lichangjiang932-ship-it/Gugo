import { useSyncExternalStore } from 'react'

/**
 * What the preview panel's page is doing, for the controls outside it.
 *
 * The top bar is a sibling of the panel, not its parent, so the two cannot pass
 * each other props without threading state through the whole workbench. This is
 * the smallest thing that lets the bar ask "is there a page, and can it go back"
 * — one docked page exists at a time, so one snapshot describes it.
 */

const EMPTY = Object.freeze({ url: '', title: '', canGoBack: false, canGoForward: false, loading: false, backend: 'frame' })

const listeners = new Set()
let snapshot = EMPTY

export function previewPageSnapshot() {
  return snapshot
}

export function publishPreviewPageStatus(next = {}) {
  const merged = { ...EMPTY, ...next }
  const changed = Object.keys(EMPTY).some((key) => snapshot[key] !== merged[key])
  snapshot = Object.freeze(merged)
  if (changed) for (const listener of [...listeners]) listener()
  return snapshot
}

export function subscribePreviewPageStatus(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePreviewPageStatus() {
  return useSyncExternalStore(subscribePreviewPageStatus, previewPageSnapshot, previewPageSnapshot)
}

export const _testing = { EMPTY, reset: () => publishPreviewPageStatus(EMPTY) }

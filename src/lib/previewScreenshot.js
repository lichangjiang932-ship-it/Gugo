import { captureDesktopPreview } from './desktopBrowserClient.js'

/** A filename that says what it is and when it was taken. */
export function previewScreenshotName(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `preview-${stamp}.png`
}

/**
 * Hand a data URL to the reader as a download.
 *
 * Not `downloadBlob`: that one builds a Blob from text, and a capture is already
 * an encoded image. Going through the anchor with the data URL keeps the PNG
 * bytes exactly as the page produced them.
 */
function downloadDataUrl(dataUrl, filename) {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * Save what the preview is showing.
 *
 * The capture comes from the docked view — the same pixels the reader is looking
 * at — so a browser build without that host reports why it cannot rather than
 * saving something else.
 */
export async function savePreviewScreenshot({ filename, capture = captureDesktopPreview, now = Date.now() } = {}) {
  const result = await capture()
  if (!result?.ok || typeof result.dataUrl !== 'string') {
    return { ok: false, reason: result?.reason || 'capture-failed' }
  }
  downloadDataUrl(result.dataUrl, filename || previewScreenshotName(now))
  return { ok: true, width: result.width || 0, height: result.height || 0 }
}

import { isHtmlDeckLike } from '../../../lib/artifactPreview.js'

const DOWNLOAD_LABELS = Object.freeze({
  pptx: 'chatPreview.downloadHd',
  docx: 'chatPreview.downloadDocx',
  xlsx: 'chatPreview.downloadXlsx',
  html: 'chatPreview.downloadHtml',
  html_multi: 'chatPreview.downloadHtml',
  mermaid: 'chatPreview.downloadMermaid',
  chart: 'chatPreview.downloadJson',
  svg: 'chatPreview.downloadSvg',
  react: 'chatPreview.downloadJsx',
  text: 'chatPreview.downloadText',
})

export function getArtifactToolbarActions(preview = {}) {
  const type = String(preview?.type || '').trim().toLowerCase()
  // A recorded diff is not a document: it has no source text to copy, no export
  // format, and a "source view" of it would be the same lines without the signs.
  if (type === 'diff') {
    return {
      canCopy: false,
      canDownload: false,
      canExportEditablePptx: false,
      canConvertToPptx: false,
      canToggleView: false,
      downloadLabelKey: 'chatPreview.downloadFile',
    }
  }
  return {
    canCopy: true,
    canDownload: Object.hasOwn(DOWNLOAD_LABELS, type),
    canExportEditablePptx: type === 'pptx',
    canConvertToPptx: type === 'html' && isHtmlDeckLike(preview?.html || ''),
    canToggleView: true,
    downloadLabelKey: DOWNLOAD_LABELS[type] || 'chatPreview.downloadFile',
  }
}

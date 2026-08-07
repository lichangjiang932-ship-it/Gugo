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
  return {
    canCopy: true,
    canDownload: Object.hasOwn(DOWNLOAD_LABELS, type),
    canExportEditablePptx: type === 'pptx',
    canConvertToPptx: type === 'html' && isHtmlDeckLike(preview?.html || ''),
    downloadLabelKey: DOWNLOAD_LABELS[type] || 'chatPreview.downloadFile',
  }
}

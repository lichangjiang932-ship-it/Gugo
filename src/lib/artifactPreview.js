import { buildOfficeFilename, parseMarkdownDocument, parseSpreadsheetRows, shouldOfferOfficeExport } from './officeExport.js'
import { buildPresentationFilename, parseMarkdownSlides, shouldOfferPptxExport } from './presentationExport.js'

const MAX_PREVIEW_SLIDES = 12
const MAX_PREVIEW_BLOCKS = 20
const MAX_PREVIEW_ROWS = 18
const MAX_PREVIEW_COLUMNS = 8

function inferSpreadsheetTitle(rows, fallback = 'spreadsheet') {
  return rows[0]?.find((cell) => String(cell || '').trim()) || fallback
}

export function buildArtifactPreview({ content = '', meta = {} } = {}) {
  if (shouldOfferPptxExport(meta)) {
    const slides = parseMarkdownSlides(content)
    if (!slides.length) return null
    const title = slides[0]?.title || meta.artifactTitle || 'presentation'
    return {
      type: 'pptx',
      title,
      label: 'PowerPoint',
      filename: buildPresentationFilename(title),
      summary: `${slides.length} 页幻灯片`,
      slides: slides.slice(0, MAX_PREVIEW_SLIDES),
      totalCount: slides.length,
    }
  }

  const officeType = shouldOfferOfficeExport(meta)
  if (officeType === 'docx') {
    const doc = parseMarkdownDocument(content)
    if (!doc.blocks.length) return null
    return {
      type: 'docx',
      title: doc.title,
      label: 'Word',
      filename: buildOfficeFilename(doc.title, 'docx'),
      summary: `${doc.blocks.length} 个内容块`,
      blocks: doc.blocks.slice(0, MAX_PREVIEW_BLOCKS),
      totalCount: doc.blocks.length,
    }
  }

  if (officeType === 'xlsx') {
    const rows = parseSpreadsheetRows(content)
    if (!rows.length) return null
    const title = inferSpreadsheetTitle(rows, meta.artifactTitle || 'spreadsheet')
    return {
      type: 'xlsx',
      title,
      label: 'Excel',
      filename: buildOfficeFilename(title, 'xlsx'),
      summary: `${rows.length} 行数据`,
      rows: rows.slice(0, MAX_PREVIEW_ROWS).map((row) => row.slice(0, MAX_PREVIEW_COLUMNS)),
      totalCount: rows.length,
      totalColumns: Math.max(...rows.map((row) => row.length)),
    }
  }

  return null
}

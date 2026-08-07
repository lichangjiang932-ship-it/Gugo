export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const MAX_DOC_BLOCKS = 240
export const MAX_SHEET_ROWS = 800
export const MAX_CELL_LENGTH = 400

export function normalizeText(input = '') {
  return String(input)
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:markdown|md|text)?[ \t]*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .trim()
}

export function xmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function cleanInlineMarkdown(value = '') {
  return String(value)
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.\u3001]\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    .trim()
}

export function buildOfficeFilename(title = 'export', extension = 'docx') {
  const ext = extension.replace(/^\./, '').toLowerCase()
  const base = String(title || 'export')
    .replace(new RegExp(`\\.${ext}$`, 'i'), '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${base || 'export'}.${ext}`
}

export function shouldOfferOfficeExport({ skillId, artifactType } = {}) {
  if (artifactType === 'docx' || skillId === 'doc') return 'docx'
  if (artifactType === 'xlsx' || skillId === 'excel') return 'xlsx'
  return ''
}

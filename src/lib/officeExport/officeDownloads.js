import { buildOfficeFilename } from './officeCommon.js'
import { createDocxBlobFromMarkdown, parseMarkdownDocument } from './documentExport.js'
import { createXlsxBlobFromMarkdown, parseSpreadsheetRows } from './spreadsheetExport.js'

function saveBlob(blob, filename) {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.dataset.interception = 'off'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 100)
}

export async function downloadDocxFromMarkdown(markdown, { title, filename } = {}) {
  const doc = parseMarkdownDocument(markdown)
  const blob = await createDocxBlobFromMarkdown(markdown)
  saveBlob(blob, filename || buildOfficeFilename(title || doc.title, 'docx'))
  return blob
}

export async function downloadXlsxFromMarkdown(markdown, { title, filename } = {}) {
  const rows = parseSpreadsheetRows(markdown)
  const blob = await createXlsxBlobFromMarkdown(markdown)
  saveBlob(blob, filename || buildOfficeFilename(title || rows[0]?.[0] || 'export', 'xlsx'))
  return blob
}

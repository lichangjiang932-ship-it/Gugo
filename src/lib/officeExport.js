const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_DOC_BLOCKS = 240
const MAX_SHEET_ROWS = 800
const MAX_CELL_LENGTH = 400

function normalizeText(input = '') {
  return String(input)
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:markdown|md|text)?[ \t]*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .trim()
}

function xmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function cleanInlineMarkdown(value = '') {
  return String(value)
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.、]\s+/, '')
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

export function parseMarkdownDocument(markdown) {
  const text = normalizeText(markdown)
  const lines = text.split('\n')
  const blocks = []
  let title = ''
  let paragraph = []

  const flushParagraph = () => {
    const content = cleanInlineMarkdown(paragraph.join(' '))
    paragraph = []
    if (content) blocks.push({ type: 'paragraph', text: content })
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      flushParagraph()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      const textValue = cleanInlineMarkdown(heading[2])
      if (!title && heading[1].length === 1) {
        title = textValue
        continue
      }
      blocks.push({ type: heading[1].length === 1 ? 'title' : 'heading', text: textValue })
      continue
    }

    if (/^[-*+]\s+/.test(line) || /^\d+[.、]\s+/.test(line)) {
      flushParagraph()
      blocks.push({ type: 'bullet', text: cleanInlineMarkdown(line) })
      continue
    }

    if (/^\|.+\|$/.test(line)) {
      flushParagraph()
      blocks.push({ type: 'paragraph', text: cleanInlineMarkdown(line.replace(/\|/g, ' | ')) })
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()

  if (!title) {
    title = blocks.find((block) => block.text)?.text || '文档'
    if (!blocks.some((block) => block.type === 'title')) {
      blocks.unshift({ type: 'title', text: title })
    }
  }

  return { title, blocks: blocks.slice(0, MAX_DOC_BLOCKS) }
}

function docParagraphXml(block) {
  const text = xmlEscape(block.text)
  const isTitle = block.type === 'title'
  const isHeading = block.type === 'heading'
  const prefix = block.type === 'bullet' ? '• ' : ''
  const size = isTitle ? 36 : isHeading ? 28 : 22
  const spacingAfter = isTitle ? 360 : isHeading ? 220 : 120
  const bold = isTitle || isHeading
  return `
    <w:p>
      <w:pPr><w:spacing w:after="${spacingAfter}"/></w:pPr>
      <w:r>
        <w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/></w:rPr>
        <w:t xml:space="preserve">${xmlEscape(prefix)}${text}</w:t>
      </w:r>
    </w:p>`
}

function documentXml(blocks) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${blocks.map(docParagraphXml).join('\n')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1200" w:bottom="1440" w:left="1200" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`
}

function docxContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
}

function packageRels(officeDocumentPath) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${officeDocumentPath}"/>
</Relationships>`
}

async function zipToBlob(files, mimeType) {
  const module = await import('jszip')
  const JSZip = module.default || module
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content)
  }
  return zip.generateAsync({ type: 'blob', mimeType, compression: 'DEFLATE' })
}

export async function createDocxBlobFromMarkdown(markdown) {
  const doc = parseMarkdownDocument(markdown)
  return zipToBlob(
    {
      '[Content_Types].xml': docxContentTypes(),
      '_rels/.rels': packageRels('word/document.xml'),
      'word/document.xml': documentXml(doc.blocks),
    },
    DOCX_MIME
  )
}

function splitCsvLine(line) {
  const cells = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const next = line[i + 1]
    if (char === '"' && next === '"') {
      current += '"'
      i += 1
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function parseCsvBlock(markdown) {
  const fence = String(markdown)
    .replace(/\r\n/g, '\n')
    .match(/```(csv|tsv)?[ \t]*\n([\s\S]*?)```/i)
  if (!fence) return []
  const delimiter = fence[1]?.toLowerCase() === 'tsv' ? '\t' : ','
  return fence[2]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (delimiter === ',' ? splitCsvLine(line) : line.split('\t').map((cell) => cell.trim())))
}

function splitMarkdownTableRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cleanInlineMarkdown(cell))
}

function parseMarkdownTable(markdown) {
  const rows = normalizeText(markdown)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\|.+\|$/.test(line))
    .filter((line) => !/^\|\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line))
    .map(splitMarkdownTableRow)
    .filter((row) => row.some(Boolean))
  return rows.length >= 2 ? rows : []
}

export function parseSpreadsheetRows(markdown) {
  const csvRows = parseCsvBlock(markdown)
  if (csvRows.length) return csvRows.slice(0, MAX_SHEET_ROWS)

  const tableRows = parseMarkdownTable(markdown)
  if (tableRows.length) return tableRows.slice(0, MAX_SHEET_ROWS)

  const outlineRows = normalizeText(markdown)
    .split('\n')
    .map(cleanInlineMarkdown)
    .filter(Boolean)
    .slice(0, MAX_SHEET_ROWS - 1)
    .map((line, index) => [index === 0 ? line : String(index), line])

  return [['项目', '内容'], ...outlineRows]
}

function columnName(index) {
  let name = ''
  let n = index + 1
  while (n > 0) {
    const mod = (n - 1) % 26
    name = String.fromCharCode(65 + mod) + name
    n = Math.floor((n - mod) / 26)
  }
  return name
}

function sheetXml(rows) {
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell, cellIndex) => {
      const ref = `${columnName(cellIndex)}${rowIndex + 1}`
      const value = xmlEscape(String(cell ?? '').slice(0, MAX_CELL_LENGTH))
      return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`
    })
    return `<row r="${rowIndex + 1}">${cells.join('')}</row>`
  })

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows.join('')}</sheetData>
</worksheet>`
}

function workbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
}

function workbookRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
}

function xlsxContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
}

export async function createXlsxBlobFromMarkdown(markdown) {
  const rows = parseSpreadsheetRows(markdown)
  return zipToBlob(
    {
      '[Content_Types].xml': xlsxContentTypes(),
      '_rels/.rels': packageRels('xl/workbook.xml'),
      'xl/workbook.xml': workbookXml(),
      'xl/_rels/workbook.xml.rels': workbookRels(),
      'xl/worksheets/sheet1.xml': sheetXml(rows),
    },
    XLSX_MIME
  )
}

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

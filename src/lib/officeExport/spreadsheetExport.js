import { cleanInlineMarkdown, MAX_CELL_LENGTH, MAX_SHEET_ROWS, normalizeText, XLSX_MIME, xmlEscape } from './officeCommon.js'
import { packageRels, zipToBlob } from './documentExport.js'

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

  return [['\u9879\u76ee', '\u5185\u5bb9'], ...outlineRows]
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

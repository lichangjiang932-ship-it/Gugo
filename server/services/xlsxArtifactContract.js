export const XLSX_LIMITS = Object.freeze({
  maxSheets: 256,
  maxRowsPerSheet: 1_048_576,
  maxColumnsPerRow: 16_384,
  maxCellTextCharacters: 32_767,
  maxTotalRows: 1_000_000,
  maxTotalCells: 1_000_000,
  maxSheetXmlBytes: 32 * 1024 * 1024,
  maxTotalXmlBytes: 64 * 1024 * 1024,
})

const INVALID_SHEET_NAME_CHARACTERS = new Set([':', '\\', '/', '?', '*', '[', ']'])

function hasInvalidSheetNameCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (INVALID_SHEET_NAME_CHARACTERS.has(character) || codePoint < 0x20 || codePoint === 0x7f) return true
  }
  return false
}

function xml10Character(codePoint) {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff)
}

function escapedXmlByteLength(value) {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (!xml10Character(codePoint)) bytes += 3
    else if (character === '&') bytes += 5
    else if (character === '<' || character === '>') bytes += 4
    else if (character === '"' || character === "'") bytes += 6
    else bytes += Buffer.byteLength(character, 'utf8')
  }
  return bytes
}

function validateSheetName(value, index, identities) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`sheets[${index}].name must be a non-empty string`)
  }
  if ([...value].length > 31) throw new Error(`sheets[${index}].name cannot exceed 31 characters`)
  if (hasInvalidSheetNameCharacter(value) || value.startsWith("'") || value.endsWith("'")) {
    throw new Error(`sheets[${index}].name contains characters Excel does not allow`)
  }
  const identity = value.normalize('NFKC').toLocaleLowerCase('en-US')
  if (identities.has(identity)) throw new Error(`sheets[${index}].name duplicates another worksheet name`)
  identities.add(identity)
  return value
}

function validateCell(value, path) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`)
    return value
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${path} must be a string, finite number, boolean, or null`)
  }
  if ([...value].length > XLSX_LIMITS.maxCellTextCharacters) {
    throw new Error(`${path} cannot exceed ${XLSX_LIMITS.maxCellTextCharacters} characters`)
  }
  return value
}

export function snapshotXlsxSheets(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new TypeError('sheets must contain at least one worksheet')
  }
  if (sheets.length > XLSX_LIMITS.maxSheets) {
    throw new Error(`sheets cannot exceed ${XLSX_LIMITS.maxSheets} worksheets`)
  }

  const identities = new Set()
  let totalRows = 0
  let totalCells = 0
  let totalXmlBytes = 2_048
  const normalized = sheets.map((sheet, sheetIndex) => {
    if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) {
      throw new TypeError(`sheets[${sheetIndex}] must be an object`)
    }
    const name = validateSheetName(sheet.name, sheetIndex, identities)
    if (!Array.isArray(sheet.rows) || sheet.rows.length === 0) {
      throw new TypeError(`sheets[${sheetIndex}].rows must contain at least one row`)
    }
    if (sheet.rows.length > XLSX_LIMITS.maxRowsPerSheet) {
      throw new Error(`sheets[${sheetIndex}].rows cannot exceed ${XLSX_LIMITS.maxRowsPerSheet} rows`)
    }
    totalRows += sheet.rows.length
    if (totalRows > XLSX_LIMITS.maxTotalRows) {
      throw new Error(`XLSX input cannot exceed ${XLSX_LIMITS.maxTotalRows} total rows`)
    }

    let sheetXmlBytes = 2_048 + escapedXmlByteLength(name)
    const rows = sheet.rows.map((row, rowIndex) => {
      if (!Array.isArray(row)) throw new TypeError(`sheets[${sheetIndex}].rows[${rowIndex}] must be an array`)
      if (row.length > XLSX_LIMITS.maxColumnsPerRow) {
        throw new Error(
          `sheets[${sheetIndex}].rows[${rowIndex}] cannot exceed ${XLSX_LIMITS.maxColumnsPerRow} columns`,
        )
      }
      totalCells += row.length
      if (totalCells > XLSX_LIMITS.maxTotalCells) {
        throw new Error(`XLSX input cannot exceed ${XLSX_LIMITS.maxTotalCells} total cells`)
      }
      sheetXmlBytes += 64
      const cells = Array.from(row, (value, columnIndex) => {
        const cell = validateCell(value, `sheets[${sheetIndex}].rows[${rowIndex}][${columnIndex}]`)
        // 128 bytes safely covers the longest cell reference plus the full
        // inline-string/number/boolean element wrapper. Text bytes are added
        // separately after XML escaping.
        sheetXmlBytes += 128 + (typeof cell === 'string' ? escapedXmlByteLength(cell) : 24)
        if (sheetXmlBytes > XLSX_LIMITS.maxSheetXmlBytes) {
          throw new Error(`sheets[${sheetIndex}] exceeds the ${XLSX_LIMITS.maxSheetXmlBytes}-byte XML budget`)
        }
        return cell
      })
      return Object.freeze(cells)
    })
    totalXmlBytes += sheetXmlBytes
    if (totalXmlBytes > XLSX_LIMITS.maxTotalXmlBytes) {
      throw new Error(`XLSX input exceeds the ${XLSX_LIMITS.maxTotalXmlBytes}-byte total XML budget`)
    }
    return Object.freeze({ name, rows: Object.freeze(rows) })
  })
  return Object.freeze(normalized)
}

export function resolveXlsxAnchorCell(value, fallbackRow, imageIndex = 0) {
  if (value == null || value === '') {
    return Object.freeze({ column: 0, row: Math.max(0, fallbackRow - 1) })
  }
  const match = typeof value === 'string'
    ? value.toUpperCase().match(/^([A-Z]{1,3})([1-9][0-9]{0,6})$/u)
    : null
  if (!match) throw new Error(`preparedImages[${imageIndex}].anchor must be a valid Excel cell reference`)
  let column = 0
  for (const character of match[1]) column = (column * 26) + character.charCodeAt(0) - 64
  const row = Number(match[2])
  if (column > XLSX_LIMITS.maxColumnsPerRow || row > XLSX_LIMITS.maxRowsPerSheet) {
    throw new Error(`preparedImages[${imageIndex}].anchor exceeds Excel worksheet bounds`)
  }
  return Object.freeze({ column: column - 1, row: row - 1 })
}

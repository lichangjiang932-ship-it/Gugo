import JSZip from 'jszip'

import { escapeXml } from '../../src/lib/pptCore.js'
import { officeImageSize } from './officeImageLayout.js'
import { validatePreparedOfficeImages } from './officePreparedImageValidation.js'
import { resolveXlsxAnchorCell, snapshotXlsxSheets } from './xlsxArtifactContract.js'

function colLetter(index) {
  let number = index
  let letters = ''
  do {
    letters = String.fromCharCode(65 + (number % 26)) + letters
    number = Math.floor(number / 26) - 1
  } while (number >= 0)
  return letters
}

function buildSheetXml(rows) {
  const lines = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || []
    const cells = []
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const reference = `${colLetter(columnIndex)}${rowIndex + 1}`
      const raw = row[columnIndex]
      if (raw == null || raw === '') continue
      if (typeof raw === 'number') {
        cells.push(`<c r="${reference}"><v>${raw}</v></c>`)
      } else if (typeof raw === 'boolean') {
        cells.push(`<c r="${reference}" t="b"><v>${raw ? 1 : 0}</v></c>`)
      } else {
        cells.push(`<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(raw)}</t></is></c>`)
      }
    }
    lines.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`)
  }
  return lines.join('')
}

function buildXlsxDrawingXml(entries) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${entries.map(({ image, imageIndex }, index) => {
    const anchor = resolveXlsxAnchorCell(image.anchor, 1 + (index * 18), imageIndex)
    for (const property of ['width', 'height']) {
      if (image[property] != null
        && (typeof image[property] !== 'number' || !Number.isFinite(image[property]) || image[property] <= 0)) {
        throw new Error(`preparedImages[${imageIndex}].${property} must be a positive finite number`)
      }
    }
    const size = officeImageSize(image, { defaultWidth: 3.5, maxWidth: 8, maxHeight: 6 })
    const cx = Math.round(size.width * 914400)
    const cy = Math.round(size.height * 914400)
    if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy) || cx <= 0 || cy <= 0) {
      throw new Error(`preparedImages[${imageIndex}] has invalid XLSX drawing dimensions`)
    }
    const description = escapeXml(image.alt || image.sourceName || `Image ${index + 1}`)
    return `  <xdr:oneCellAnchor>
    <xdr:from><xdr:col>${anchor.column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="${cx}" cy="${cy}"/>
    <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="Image ${index + 1}" descr="${description}"/><xdr:cNvPicPr/></xdr:nvPicPr>
      <xdr:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
      <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
    </xdr:pic><xdr:clientData/>
  </xdr:oneCellAnchor>`
  }).join('\n')}
</xdr:wsDr>`
}

export async function buildXlsxArtifactBuffer({ sheets, preparedImages = [] } = {}) {
  const normalizedSheets = snapshotXlsxSheets(sheets)
  const images = validatePreparedOfficeImages(preparedImages, {
    targetCount: normalizedSheets.length,
    targetKind: 'sheet workbook',
  })
  const sheetImages = normalizedSheets.map((_, sheetIndex) => images
    .map((image, imageIndex) => ({ image, imageIndex }))
    .filter(({ image, imageIndex }) => (
      image.targetIndex || ((imageIndex % normalizedSheets.length) + 1)
    ) === sheetIndex + 1))

  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${images.some((image) => image.extension === 'png') ? '  <Default Extension="png" ContentType="image/png"/>' : ''}
${images.some((image) => image.extension === 'jpg') ? '  <Default Extension="jpg" ContentType="image/jpeg"/>' : ''}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${normalizedSheets.map((_, index) => `  <Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
${sheetImages.map((entries, index) => entries.length ? `  <Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : '').filter(Boolean).join('\n')}
</Types>`,
  )
  zip.folder('_rels').file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  )
  const xl = zip.folder('xl')
  xl.folder('_rels').file(
    'workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${normalizedSheets.map((_, index) => `  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('\n')}
</Relationships>`,
  )
  xl.file(
    'workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${normalizedSheets.map((sheet, index) => `    <sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('\n')}
  </sheets>
</workbook>`,
  )
  const worksheets = xl.folder('worksheets')
  const worksheetRelationships = worksheets.folder('_rels')
  const drawings = xl.folder('drawings')
  const drawingRelationships = drawings.folder('_rels')
  const media = xl.folder('media')
  images.forEach((image, imageIndex) => media.file(`image${imageIndex + 1}.${image.extension}`, image.buffer))
  normalizedSheets.forEach((sheet, sheetIndex) => {
    const entries = sheetImages[sheetIndex]
    worksheets.file(
      `sheet${sheetIndex + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetData>${buildSheetXml(sheet.rows)}</sheetData>
${entries.length ? '  <drawing r:id="rId1"/>' : ''}
</worksheet>`,
    )
    if (!entries.length) return
    worksheetRelationships.file(
      `sheet${sheetIndex + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${sheetIndex + 1}.xml"/>
</Relationships>`,
    )
    drawings.file(`drawing${sheetIndex + 1}.xml`, buildXlsxDrawingXml(entries))
    drawingRelationships.file(
      `drawing${sheetIndex + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${entries.map(({ image, imageIndex }, relationshipIndex) => `  <Relationship Id="rId${relationshipIndex + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${imageIndex + 1}.${image.extension}"/>`).join('\n')}
</Relationships>`,
    )
  })

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

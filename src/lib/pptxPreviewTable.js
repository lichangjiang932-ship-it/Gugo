import { PPTX_XML_NS, emu, pptxSolidFill, relatedPptxPart, xmlChild, xmlChildren, xmlNumber } from './pptxPreviewXml.js'
import { lineStyle, transformBox } from './pptxPreviewDrawing.js'
import { parsePptxText } from './pptxPreviewText.js'

const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table'
const MEDIUM_2_ACCENT_1 = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'
const MAX_TABLE_CELLS = 200
const enabled = (node, name) => ['1', 'true'].includes(node?.getAttribute(name))

// This is the specific built-in style referenced by the source, not a fallback
// theme. Reviewed OpenXML SDK-generated definition (including inherited borders):
// https://api.github.com/repos/dotnet-campus/DocumentFormat.OpenXml.Extensions/git/blobs/394482491e2313b8c700268e73049283c9250134
async function tableStyle(properties, context) {
  const styles = await relatedPptxPart(context.readXml, 'ppt/presentation.xml', 'tableStyles')
  const root = styles.xml?.documentElement
  if (root && (root.localName !== 'tblStyleLst' || root.namespaceURI !== PPTX_XML_NS.drawing)) {
    throw new Error('Invalid PPTX table styles')
  }
  const id = (xmlChild(properties, 'tableStyleId')?.textContent?.trim() || root?.getAttribute('def') || '').toUpperCase()
  if (id !== MEDIUM_2_ACCENT_1 || xmlChildren(root, 'tblStyle').some((style) => style.getAttribute('styleId')?.toUpperCase() === id)) {
    throw new Error('Unsupported PPTX custom or unresolved table style')
  }
  if (xmlChildren(properties).some((node) => node.localName !== 'tableStyleId')
    || ['rtl', 'lastRow', 'firstCol', 'lastCol', 'bandCol'].some((name) => enabled(properties, name))) {
    throw new Error('Unsupported PPTX table style options')
  }
  return { firstRow: enabled(properties, 'firstRow'), bandRow: enabled(properties, 'bandRow') }
}

function themeColor(theme, name, tintRetention = null) {
  const hex = theme.colors[theme.mapping[name] || name]
  if (!/^[a-f\d]{6}$/i.test(hex || '')) throw new Error('Missing PPTX table theme color')
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16)
    return tintRetention === null ? channel : Math.round(channel * tintRetention + 255 * (1 - tintRetention))
  })
  return `rgba(${channels.join(',')},1)`
}

function cellStyle(row, style, theme) {
  const header = style.firstRow && row === 0
  const band = style.bandRow && (row - (style.firstRow ? 1 : 0)) % 2 === 0
  return {
    fill: themeColor(theme, 'accent1', header ? null : band ? 0.4 : 0.2),
    fontStyle: { fontFamily: theme.minorFont || 'sans-serif', color: themeColor(theme, header ? 'lt1' : 'dk1'), fontWeight: header ? 700 : 400 },
  }
}

function validateCell(cell) {
  if (xmlNumber(cell, 'gridSpan', 1) !== 1 || xmlNumber(cell, 'rowSpan', 1) !== 1
    || enabled(cell, 'hMerge') || enabled(cell, 'vMerge')) throw new Error('Unsupported PPTX merged table cell')
  if (xmlChildren(cell).some((node) => !['txBody', 'tcPr'].includes(node.localName))) throw new Error('Unsupported PPTX table cell')
  const properties = xmlChild(cell, 'tcPr')
  if (properties?.hasAttribute('vert') && properties.getAttribute('vert') !== 'horz') throw new Error('Unsupported PPTX table text direction')
  if (xmlChildren(properties).some((node) => !['solidFill', 'noFill', 'lnL', 'lnR', 'lnT', 'lnB'].includes(node.localName))) {
    throw new Error('Unsupported PPTX table cell paint')
  }
}

function cellBorder(properties, side, base, theme) {
  const line = xmlChild(properties, side)
  if (!line) return { ...base, priority: 0 }
  const explicit = lineStyle(line, theme, null, null, true)
  const fill = xmlChildren(line).some((node) => ['solidFill', 'noFill'].includes(node.localName))
  return { ...explicit, stroke: fill ? explicit.stroke : base.stroke,
    strokeWidth: line.hasAttribute('w') ? explicit.strokeWidth : base.strokeWidth, priority: 2 }
}

function addBorder(borders, key, box, paint) {
  const previous = borders.get(key)
  if (previous) {
    if (previous.priority > paint.priority) return
    if (previous.priority === paint.priority) {
      if (previous.stroke !== paint.stroke) throw new Error('Unsupported PPTX conflicting cell borders')
      if (previous.strokeWidth >= paint.strokeWidth) return
    }
  }
  borders.set(key, { kind: 'shape', shape: 'line', fill: 'none', text: null,
    rotation: 0, flipH: false, flipV: false, ...box, ...paint, tableBorder: true })
}

/** Bounded native table expansion. Unknown styling and merges stay unsupported. */
export async function parsePptxTable(node, context, remainingElements) {
  const data = xmlChild(xmlChild(node, 'graphic'), 'graphicData')
  if (data?.getAttribute('uri') !== TABLE_URI || xmlChildren(data).length !== 1) throw new Error('Unsupported PPTX graphic frame')
  const table = xmlChild(data, 'tbl')
  if (!table || table.namespaceURI !== PPTX_XML_NS.drawing) throw new Error('Invalid PPTX table')
  const box = transformBox(xmlChild(node, 'xfrm'))
  if (box.rotation || box.flipH || box.flipV) throw new Error('Unsupported PPTX table transform')
  const grid = xmlChildren(xmlChild(table, 'tblGrid'), 'gridCol')
  const rows = xmlChildren(table, 'tr')
  const cells = rows.length * grid.length
  const maximumPrimitives = cells + rows.length * (grid.length + 1) + grid.length * (rows.length + 1)
  if (!rows.length || !grid.length || cells > MAX_TABLE_CELLS || !Number.isInteger(remainingElements)
    || maximumPrimitives > remainingElements) throw new Error('PPTX table exceeds the preview limit')
  if (xmlChildren(table).some((part) => !['tblPr', 'tblGrid', 'tr'].includes(part.localName))) throw new Error('Unsupported PPTX table content')
  const widths = grid.map((column) => xmlNumber(column, 'w'))
  const heights = rows.map((row) => xmlNumber(row, 'h'))
  if ([...widths, ...heights].some((value) => value <= 0)
    || Math.abs(emu(widths.reduce((sum, value) => sum + value, 0)) - box.w) > 1 / 9525
    || Math.abs(emu(heights.reduce((sum, value) => sum + value, 0)) - box.h) > 1 / 9525) {
    throw new Error('Invalid PPTX table grid bounds')
  }
  for (const row of rows) {
    const rowCells = xmlChildren(row, 'tc')
    if (rowCells.length !== grid.length || xmlChildren(row).length !== rowCells.length) throw new Error('Invalid PPTX table cell count')
    for (const cell of rowCells) validateCell(cell)
  }
  const style = await tableStyle(xmlChild(table, 'tblPr'), context)
  const borderColor = themeColor(context.theme, 'lt1')
  const elements = []
  const borders = new Map()
  let y = box.y
  for (const [rowIndex, row] of rows.entries()) {
    const h = emu(heights[rowIndex])
    let x = box.x
    const inherited = cellStyle(rowIndex, style, context.theme)
    for (const [columnIndex, cell] of xmlChildren(row, 'tc').entries()) {
      const w = emu(widths[columnIndex])
      const properties = xmlChild(cell, 'tcPr')
      const text = parsePptxText(xmlChild(cell, 'txBody'), { ...context, fontStyle: inherited.fontStyle }, properties)
      elements.push({ kind: 'shape', shape: 'rect', x, y, w, h, rotation: 0, flipH: false, flipV: false,
        fill: pptxSolidFill(properties, context.theme, inherited.fill), stroke: 'none', strokeWidth: 0, text,
        tableCell: { row: rowIndex, column: columnIndex } })
      const base = { stroke: borderColor, strokeWidth: emu(12700), strokeLinecap: 'butt' }
      for (const [side, key, frame] of [
        ['lnL', `v:${rowIndex}:${columnIndex}`, { x, y, w: 0, h }],
        ['lnR', `v:${rowIndex}:${columnIndex + 1}`, { x: x + w, y, w: 0, h }],
        ['lnT', `h:${rowIndex}:${columnIndex}`, { x, y, w, h: 0 }],
        ['lnB', `h:${rowIndex + 1}:${columnIndex}`, { x, y: y + h, w, h: 0 }],
      ]) {
        const inheritedBorder = side === 'lnB' && style.firstRow && rowIndex === 0 ? { ...base, strokeWidth: emu(38100) } : base
        addBorder(borders, key, frame, cellBorder(properties, side, inheritedBorder, context.theme))
      }
      x += w
    }
    y += h
  }
  return [...elements, ...[...borders.values()].filter((border) => border.stroke !== 'none')]
}

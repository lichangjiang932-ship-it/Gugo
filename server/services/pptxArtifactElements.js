import { shape } from '../../src/lib/pptCore.js'
import { PPTX_ELEMENT_SCHEMA, PPTX_LIMITS } from './pptxArtifactContract.js'
import { addPptxText, fittingPptxFont } from './pptxArtifactDesign.js'
import { assertPptxSchema, invalidPptx, normalizePptxChart, normalizePptxTable, pptxColor } from './pptxArtifactValidation.js'

function elementBox(element, design, path) {
  if (element.x + element.w > 1 + 1e-9 || element.y + element.h > 1 + 1e-9) {
    invalidPptx(path, 'must stay inside the slide (x+w <= 1 and y+h <= 1)')
  }
  if (element.w === 0 && element.h === 0) invalidPptx(path, 'must have a non-zero line length')
  return {
    x: element.x * design.width, y: element.y * design.height,
    w: element.w * design.width, h: element.h * design.height,
  }
}

function textStyle(element, design) {
  const heading = element.role === 'heading'
  const caption = element.role === 'caption'
  return {
    fontFace: element.font_face || (heading ? design.headingFont : design.bodyFont),
    fontSize: element.font_size || (heading ? design.headingSize : caption ? 12 : design.bodySize),
    strictFontSize: element.font_size !== undefined
      || (heading ? design.headingSizeExplicit : !caption && design.bodySizeExplicit),
    color: pptxColor(element.color) || design.theme.text,
    bold: element.bold === true,
    italic: element.italic === true,
    align: element.align || 'left',
    valign: element.valign || 'top',
    ...(element.fill ? { fill: { color: pptxColor(element.fill) } } : {}),
  }
}

export function addNativePptxChart(slide, pptx, rawChart, box, design, style = {}, path = 'chart') {
  const chart = normalizePptxChart(rawChart, path)
  const circular = ['pie', 'doughnut'].includes(chart.type)
  const name = chart.type.startsWith('bar') ? 'bar' : chart.type
  const fontFace = style.font_face || design.bodyFont
  const fontSize = style.font_size || (design.bodySizeExplicit ? design.bodySize : Math.max(10, Math.min(14, design.bodySize - 4)))
  const palette = [design.theme.accent, design.theme.accentSoft, design.theme.text, design.theme.soft]
  const colorCount = circular ? chart.categories.length : chart.series.length
  slide.addChart(pptx.ChartType?.[name] || name, chart.series.map((series) => ({
    name: series.name,
    labels: chart.categories,
    values: series.values,
  })), {
    ...box,
    chartColors: chart.colors || Array.from({ length: colorCount }, (_, index) => palette[index % palette.length]),
    showLegend: chart.show_legend ?? (chart.series.length > 1 || circular),
    legendPos: chart.legend_position || 'b',
    legendFontFace: fontFace,
    legendFontSize: fontSize,
    legendColor: design.theme.text,
    catAxisLabelFontFace: fontFace,
    catAxisLabelFontSize: fontSize,
    catAxisLabelColor: design.theme.text,
    valAxisLabelFontFace: fontFace,
    valAxisLabelFontSize: fontSize,
    valAxisLabelColor: design.theme.soft,
    catAxisTitle: chart.x_axis_title,
    catAxisTitleFontFace: fontFace,
    catAxisTitleFontSize: fontSize,
    catAxisTitleColor: design.theme.text,
    valAxisTitle: chart.y_axis_title,
    valAxisTitleFontFace: fontFace,
    valAxisTitleFontSize: fontSize,
    valAxisTitleColor: design.theme.text,
    valAxisLabelFormatCode: chart.number_format,
    dataLabelFormatCode: chart.number_format,
    dataLabelColor: design.theme.text,
    dataLabelFontFace: fontFace,
    dataLabelFontSize: fontSize,
    // Stacked values belong to their individual segments, not the column top.
    // PptxGenJS propagates this option into every series' native data labels.
    dataLabelPosition: chart.type === 'bar-stacked' ? 'ctr' : undefined,
    showValue: chart.show_values ?? circular,
    barDir: chart.type === 'bar-horizontal' ? 'bar' : 'col',
    barGrouping: chart.type === 'bar-stacked' ? 'stacked' : 'clustered',
    barOverlapPct: chart.type === 'bar-stacked' ? 100 : 0,
    catGridLine: { style: 'none' },
    valGridLine: { color: design.theme.line, style: 'solid', size: 0.5 },
    chartArea: { fill: { color: design.theme.bg }, roundedCorners: false },
    plotArea: { fill: { color: design.theme.bg } },
  })
}

export function addNativePptxTable(slide, rawTable, box, design, style = {}, path = 'table') {
  const table = normalizePptxTable(rawTable, path)
  const widths = table.columnWidths.map((width) => width * box.w)
  const rowHeight = box.h / table.rows.length
  let fontSize = style.font_size || design.bodySize
  const strictSize = style.font_size !== undefined || design.bodySizeExplicit
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    for (let column = 0; column < widths.length; column += 1) {
      fontSize = Math.min(fontSize, fittingPptxFont(table.rows[rowIndex][column], {
        w: widths[column] - 0.12, h: rowHeight - 0.10,
      }, fontSize, `${path}.rows[${rowIndex}][${column}]`, { allowShrink: !strictSize }))
    }
  }
  const options = textStyle(style, design)
  delete options.strictFontSize
  const rows = table.rows.map((row, rowIndex) => row.map((text) => ({
    text,
    options: {
      bold: rowIndex === 0 && table.header ? true : options.bold,
      color: rowIndex === 0 && table.header
        ? pptxColor(style.header_color) || options.color : options.color,
      fill: { color: rowIndex === 0 && table.header
        ? pptxColor(style.header_fill) || design.theme.bg
        : pptxColor(style.fill) || design.theme.bg },
    },
  })))
  slide.addTable(rows, {
    ...box,
    ...options,
    fontSize,
    colW: widths,
    rowH: rowHeight,
    margin: 0.05,
    border: { type: 'solid', color: pptxColor(style.line_color) || design.theme.line, pt: 0.5 },
    autoPage: false,
    autoPageRepeatHeader: false,
  })
}

export function addPreparedPptxImage(slide, image, box, { fit = 'contain', alt } = {}) {
  let frame = box
  if (fit === 'contain') {
    const ratio = Math.min(box.w / image.pixelWidth, box.h / image.pixelHeight)
    const w = image.pixelWidth * ratio
    const h = image.pixelHeight * ratio
    frame = { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
  }
  slide.addImage({
    data: image.dataUri,
    ...frame,
    ...(fit === 'cover' ? { sizing: { type: 'cover', w: box.w, h: box.h } } : {}),
    altText: alt || image.alt || image.sourceName || 'Image',
  })
}

function addCanvasShape(slide, pptx, element, box, design) {
  slide.addShape(shape(pptx, element.type === 'line' ? 'line' : element.shape), {
    ...box,
    flipV: element.flip_vertical === true,
    fill: { color: pptxColor(element.fill) || design.theme.bg, transparency: element.fill ? element.transparency ?? 0 : 100 },
    line: {
      color: pptxColor(element.line_color) || design.theme.accent,
      width: element.line_width ?? 1,
      ...(element.begin_arrow ? { beginArrowType: element.begin_arrow } : {}),
      ...(element.end_arrow ? { endArrowType: element.end_arrow } : {}),
    },
  })
}

function canvasImage(element, images, slideIndex, path) {
  const image = images[element.image_index - 1]
  if (!image) invalidPptx(`${path}.image_index`, 'must reference an authorized top-level images entry', 'PPTX_IMAGE_REFERENCE_INVALID')
  if (image.targetIndex && image.targetIndex !== slideIndex + 1) {
    invalidPptx(`${path}.image_index`, 'conflicts with the image target_index', 'PPTX_IMAGE_REFERENCE_INVALID')
  }
  return image
}

export function renderPptxElements(slide, pptx, source, design, images, slideIndex) {
  const path = `slides[${slideIndex}].elements`
  if (!Array.isArray(source.elements) || source.elements.length === 0
    || source.elements.length > PPTX_LIMITS.elements) {
    invalidPptx(path, `must contain 1..${PPTX_LIMITS.elements} elements`)
  }
  for (const key of ['body', 'subtitle', 'eyebrow', 'bullets', 'kpi', 'kpis', 'chart', 'table', 'quote']) {
    if (source[key] && (!Array.isArray(source[key]) || source[key].length > 0)) {
      invalidPptx(`slides[${slideIndex}].${key}`, 'cannot accompany elements; put all visible content in the canvas')
    }
  }
  source.elements.forEach((element, index) => {
    const elementPath = `${path}[${index}]`
    assertPptxSchema(element, PPTX_ELEMENT_SCHEMA, elementPath)
    const box = elementBox(element, design, elementPath)
    switch (element.type) {
      case 'text':
        addPptxText(slide, element.text, box, design, textStyle(element, design), elementPath)
        break
      case 'shape':
      case 'line':
        addCanvasShape(slide, pptx, element, box, design)
        break
      case 'chart':
        addNativePptxChart(slide, pptx, element.chart, box, design, element, `${elementPath}.chart`)
        break
      case 'table':
        addNativePptxTable(slide, element.table, box, design, element, `${elementPath}.table`)
        break
      case 'image':
        addPreparedPptxImage(slide, canvasImage(element, images, slideIndex, elementPath), box, element)
        break
      default: invalidPptx(`${elementPath}.type`, 'is not supported')
    }
  })
}

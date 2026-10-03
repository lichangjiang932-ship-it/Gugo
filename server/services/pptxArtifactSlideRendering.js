import { addPptxText } from './pptxArtifactDesign.js'
import { addNativePptxChart, addNativePptxTable } from './pptxArtifactElements.js'

function frame(design, x, y, w, h) {
  return { x: x * design.width, y: y * design.height, w: w * design.width, h: h * design.height }
}

function addPageTitle(slide, design, titleText, eyebrow, path) {
  if (eyebrow) {
    addPptxText(slide, eyebrow, frame(design, 0.06, 0.06, 0.88, 0.045), design, {
      fontSize: design.bodySizeExplicit ? design.bodySize : 14, color: design.theme.accent,
    }, `${path}.eyebrow`)
  }
  addPptxText(slide, titleText, frame(design, 0.06, 0.12, 0.88, 0.15), design, {
    fontSize: design.headingSize, fontFace: design.headingFont, bold: true, strictFontSize: design.headingSizeExplicit,
  }, `${path}.title`)
}

function bodyCopy(slide, design, bullets, box, path, options = {}) {
  addPptxText(slide, bullets.join('\n\n'), box, design, options, `${path}.body`)
}

export function addFooter(slide, _pptx, design, index, total, brand, generatedAt) {
  const labels = []
  if (design.showBrand && brand) labels.push(brand)
  if (design.showDate) labels.push(generatedAt.toISOString().slice(0, 10))
  if (labels.length) {
    addPptxText(slide, labels.join('  '), frame(design, 0.06, 0.95, 0.65, 0.035), design, {
      fontSize: 9, color: design.theme.soft,
    }, `slides[${index}].footer`)
  }
  if (design.showPageNumbers) {
    addPptxText(slide, `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`,
      frame(design, 0.78, 0.95, 0.16, 0.035), design,
      { fontSize: 9, color: design.theme.soft, align: 'right' }, `slides[${index}].pageNumber`)
  }
}

export function renderCover(slide, _pptx, design, { titleText, subtitle, bullets, eyebrow, path }) {
  if (eyebrow) {
    addPptxText(slide, eyebrow, frame(design, 0.06, 0.08, 0.88, 0.06), design,
      { fontSize: design.bodySizeExplicit ? design.bodySize : 14, color: design.theme.accent }, `${path}.eyebrow`)
  }
  addPptxText(slide, titleText, frame(design, 0.06, 0.18, 0.88, 0.32), design, {
    fontSize: design.headingSizeExplicit ? design.headingSize : 42,
    fontFace: design.headingFont, bold: true, strictFontSize: design.headingSizeExplicit,
  }, `${path}.title`)
  bodyCopy(slide, design, [subtitle, ...bullets].filter(Boolean), frame(design, 0.06, 0.56, 0.88, 0.34), path)
}

export function renderSection(slide, _pptx, design, { titleText, eyebrow, bullets, path }) {
  if (eyebrow) {
    addPptxText(slide, eyebrow, frame(design, 0.06, 0.22, 0.88, 0.06), design,
      { fontSize: design.bodySize, color: design.theme.accent }, `${path}.eyebrow`)
  }
  addPptxText(slide, titleText, frame(design, 0.06, 0.34, 0.88, 0.25), design, {
    fontSize: design.headingSizeExplicit ? design.headingSize : 36,
    fontFace: design.headingFont, bold: true, strictFontSize: design.headingSizeExplicit,
  }, `${path}.title`)
  bodyCopy(slide, design, bullets, frame(design, 0.06, 0.64, 0.88, 0.26), path)
}

export function renderStatement(slide, _pptx, design, { titleText, bullets, eyebrow, path }) {
  addPageTitle(slide, design, titleText, eyebrow, path)
  bodyCopy(slide, design, bullets, frame(design, 0.06, 0.35, 0.88, 0.55), path)
}

export function renderBullets(slide, _pptx, design, { titleText, bullets, eyebrow, path }) {
  addPageTitle(slide, design, titleText, eyebrow, path)
  bodyCopy(slide, design, bullets, frame(design, 0.06, 0.32, 0.88, 0.58), path)
}

export function renderSplit(slide, _pptx, design, { titleText, bullets, eyebrow, path }) {
  addPageTitle(slide, design, titleText, eyebrow, path)
  const middle = Math.ceil(bullets.length / 2)
  // Keep every paragraph in order, including legacy calls with more than two items.
  for (const [index, content] of [bullets.slice(0, middle), bullets.slice(middle)].entries()) {
    bodyCopy(slide, design, content, frame(design, index === 0 ? 0.06 : 0.53, 0.34, 0.41, 0.56), `${path}.columns[${index}]`)
  }
}

export function renderProcess(slide, _pptx, design, { titleText, bullets, eyebrow, path }) {
  addPageTitle(slide, design, titleText, eyebrow, path)
  const horizontal = bullets.length <= 4 && bullets.join('').length <= 240 && design.width > design.height
  if (!horizontal) {
    bodyCopy(slide, design, bullets, frame(design, 0.06, 0.32, 0.88, 0.58), path)
    return
  }
  const width = 0.88 / bullets.length
  bullets.forEach((text, index) => {
    addPptxText(slide, String(index + 1), frame(design, 0.06 + index * width, 0.33, width - 0.025, 0.07), design, {
      fontSize: design.bodySize, color: design.theme.accent, bold: true,
    }, `${path}.steps[${index}].number`)
    addPptxText(slide, text, frame(design, 0.06 + index * width, 0.46, width - 0.025, 0.44), design, {
      fontSize: design.bodySize,
    }, `${path}.steps[${index}]`)
  })
}

export function renderKpi(slide, _pptx, design, { titleText, kpis, bullets, eyebrow, path }) {
  addPageTitle(slide, design, titleText, eyebrow, path)
  const width = 0.88 / kpis.length
  const hasCaption = bullets.length > 0
  kpis.forEach((item, index) => {
    const x = 0.06 + index * width
    addPptxText(slide, item.value, frame(design, x, 0.35, width - 0.025, 0.22), design, {
      fontSize: design.headingSizeExplicit ? design.headingSize : 36,
      fontFace: design.headingFont, bold: true, strictFontSize: design.headingSizeExplicit,
    }, `${path}.kpi[${index}].value`)
    addPptxText(slide, [item.unit, item.label, item.delta].filter(Boolean).join('\n'),
      frame(design, x, 0.60, width - 0.025, hasCaption ? 0.16 : 0.30), design,
      { fontSize: design.bodySize, color: design.theme.soft }, `${path}.kpi[${index}].details`)
  })
  if (hasCaption) bodyCopy(slide, design, bullets, frame(design, 0.06, 0.80, 0.88, 0.10), path)
}

function evidenceBox(slide, design, bullets, path) {
  if (bullets.length) bodyCopy(slide, design, bullets, frame(design, 0.06, 0.80, 0.88, 0.10), path)
  return frame(design, 0.06, 0.31, 0.88, bullets.length ? 0.44 : 0.59)
}

export function renderChart(slide, pptx, design, { titleText, chart, bullets, eyebrow, path }) {
  addPageTitle(slide, design, titleText, eyebrow, path)
  addNativePptxChart(slide, pptx, chart, evidenceBox(slide, design, bullets, path), design, {}, `${path}.chart`)
}

export function renderTable(slide, _pptx, design, { titleText, table, bullets, eyebrow, path }) {
  addPageTitle(slide, design, titleText, eyebrow, path)
  addNativePptxTable(slide, table, evidenceBox(slide, design, bullets, path), design, {}, `${path}.table`)
}

export function renderQuote(slide, _pptx, design, { titleText, quote, bullets, eyebrow, path }) {
  const text = typeof quote === 'string' ? quote : quote?.text || titleText
  const source = typeof quote === 'object' ? quote?.source || '' : ''
  if (text !== titleText) addPageTitle(slide, design, titleText, eyebrow, path)
  else if (eyebrow) addPageTitle(slide, design, '', eyebrow, path)
  addPptxText(slide, text, frame(design, 0.06, 0.32, 0.88, 0.40), design, {
    fontFace: design.headingFont, fontSize: design.bodySizeExplicit ? design.bodySize : 26, italic: true,
  }, `${path}.quote`)
  bodyCopy(slide, design, [source, ...bullets].filter(Boolean), frame(design, 0.06, 0.77, 0.88, 0.13), path,
    { fontSize: design.bodySizeExplicit ? design.bodySize : 14, color: design.theme.soft })
}

export function renderEnd(slide, pptx, design, content) {
  renderStatement(slide, pptx, design, content)
}

import { officeImageSize } from './officeImageLayout.js'
import { validatePreparedOfficeImages } from './officePreparedImageValidation.js'
import {
  addFooter, renderBullets, renderChart, renderCover, renderEnd, renderKpi,
  renderProcess, renderQuote, renderSection, renderSplit, renderStatement, renderTable,
} from './pptxArtifactSlideRendering.js'
import { injectEaFontWithReceipt } from '../../src/lib/pptCore.js'
import { PPTX_LIMITS } from './pptxArtifactContract.js'
import { applyPptxRunFonts, resolvePptxDesign, slidePptxDesign } from './pptxArtifactDesign.js'
import { addPreparedPptxImage, renderPptxElements } from './pptxArtifactElements.js'
import {
  fullPptxBullets, fullPptxKpis, invalidPptx, normalizePptxChart, pptxText,
} from './pptxArtifactValidation.js'

const RENDERERS = Object.freeze({
  cover: renderCover, section: renderSection, kpi: renderKpi, chart: renderChart,
  table: renderTable, statement: renderStatement, split: renderSplit,
  process: renderProcess, quote: renderQuote, bullets: renderBullets, end: renderEnd,
})

function resolveGeneratedAt(value) {
  const date = value == null ? new Date() : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('generatedAt must be a valid date')
  return date
}

async function normalizePptxPackage(buffer, generatedAt, design) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buffer)
  const coreFile = zip.file('docProps/core.xml')
  if (coreFile) {
    const iso = generatedAt.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const core = await coreFile.async('string')
    zip.file('docProps/core.xml', core
      .replace(/(<dcterms:created\b[^>]*>)[^<]*(<\/dcterms:created>)/, '$1' + iso + '$2')
      .replace(/(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/, '$1' + iso + '$2'))
  }
  for (const entry of Object.values(zip.files)) {
    if (/^ppt\/(?:slides|charts|notesSlides)\/[^/]+\.xml$/u.test(entry.name)) {
      const xml = await entry.async('string')
      const rewritten = applyPptxRunFonts(xml, design)
      if (rewritten !== xml) zip.file(entry.name, rewritten)
    }
  }
  for (const entry of Object.values(zip.files)) entry.date = new Date(generatedAt.getTime())
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function requireExplicitChart(slide, path) {
  const chart = slide.chart
  if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
    throw new TypeError(path + '.chart must be an object when layout is "chart"')
  }
  if (!Array.isArray(chart.series) || chart.series.length === 0) {
    throw new TypeError(path + '.chart.series must contain at least one series')
  }
  chart.series.forEach((series, index) => {
    if (!series || typeof series !== 'object' || Array.isArray(series)) {
      throw new TypeError(path + '.chart.series[' + index + '] must be an object')
    }
    if (!Array.isArray(series.values) || series.values.length === 0) {
      throw new TypeError(path + '.chart.series[' + index + '].values must contain at least one finite number')
    }
  })
  return normalizePptxChart({ type: 'bar', ...chart }, path + '.chart')
}

function legacyContent(source, index, subtitle) {
  const path = 'slides[' + index + ']'
  const layout = String(source.layout || '').toLowerCase()
  const bullets = fullPptxBullets(source, path)
  const kpis = fullPptxKpis(source, path)
  if (layout === 'kpi' && kpis.length === 0) {
    throw new TypeError(path + '.kpi must contain at least one item with a value when layout is "kpi"')
  }
  if (['process', 'bullets', 'split'].includes(layout) && bullets.length === 0) {
    throw new TypeError(path + '.bullets or body must contain at least one non-empty item when layout is "' + layout + '"')
  }
  const chart = layout === 'chart' ? requireExplicitChart(source, path)
    : source.chart ? normalizePptxChart({ type: 'bar', ...source.chart }, path + '.chart') : null
  const subtitleText = pptxText(source.subtitle ?? (index === 0 ? subtitle : ''), path + '.subtitle')
  const quote = source.quote
  if (quote !== undefined) {
    if (typeof quote === 'string') pptxText(quote, path + '.quote')
    else if (quote && typeof quote === 'object') {
      pptxText(quote.text, path + '.quote.text')
      if (quote.source !== undefined) pptxText(quote.source, path + '.quote.source', 500)
    } else invalidPptx(path + '.quote', 'must contain text')
  }
  return {
    path, bullets, kpis, chart, quote, table: source.table,
    subtitle: subtitleText,
    titleText: pptxText(source.title ?? 'Slide ' + (index + 1), path + '.title'),
    eyebrow: pptxText(source.eyebrow ?? '', path + '.eyebrow', 500),
  }
}

function pickLayout(source, content) {
  const explicit = String(source.layout || '').toLowerCase()
  if (explicit) {
    if (!Object.hasOwn(RENDERERS, explicit)) invalidPptx(content.path + '.layout', 'is not supported')
    return explicit
  }
  if (content.chart) return 'chart'
  if (content.table) return 'table'
  if (content.kpis.length) return 'kpi'
  if (content.quote) return 'quote'
  return content.bullets.length > 1 ? 'bullets' : 'statement'
}

function validateLayoutEvidence(layout, content) {
  for (const [present, expected, field] of [
    [Boolean(content.chart), 'chart', 'chart'],
    [Boolean(content.table), 'table', 'table'],
    [content.kpis.length > 0, 'kpi', 'kpi'],
    [Boolean(content.quote), 'quote', 'quote'],
  ]) {
    if (present && layout !== expected) {
      invalidPptx(content.path + '.' + field, 'requires layout="' + expected + '" or a canvas element, so evidence is not discarded')
    }
  }
}

function imageAltText(image, index) {
  const text = String(image.alt || image.sourceName || 'Image ' + (index + 1))
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? ' ' : character
  }).join('').trim().slice(0, 500)
}

function prepareImages(images, total) {
  return validatePreparedOfficeImages(images, { targetCount: total, targetKind: 'slide deck' })
    .map((image, index) => Object.freeze({
      ...image,
      alt: imageAltText(image, index),
      dataUri: 'data:' + (image.extension === 'jpg' ? 'image/jpeg' : 'image/png')
        + ';base64,' + image.buffer.toString('base64'),
    }))
}

function legacyImagesForSlide(images, index, total) {
  return images.filter((image, imageIndex) => (
    (image.targetIndex || ((imageIndex % total) + 1)) === index + 1
  ))
}

function renderLegacyImages(slide, images, design, path) {
  const automatic = images.filter((image) => image.x === undefined || image.y === undefined)
  for (const image of images) {
    let box
    if (image.x !== undefined && image.y !== undefined) {
      const size = officeImageSize(image, { defaultWidth: design.width * 0.3, maxWidth: design.width, maxHeight: design.height })
      box = { x: image.x, y: image.y, w: size.width, h: size.height }
    } else {
      const slot = automatic.indexOf(image)
      box = {
        x: image.x ?? design.width * 0.60,
        y: image.y ?? design.height * (0.10 + slot * 0.80 / automatic.length),
        w: design.width * 0.34,
        h: design.height * 0.74 / automatic.length,
      }
    }
    if (box.x + box.w > design.width + 1e-9 || box.y + box.h > design.height + 1e-9) {
      invalidPptx(path + '.images', 'must fit inside the chosen slide size')
    }
    addPreparedPptxImage(slide, image, box, {
      fit: image.x !== undefined && image.y !== undefined ? 'stretch' : 'contain',
    })
  }
}

function renderSlide(pptx, source, index, inputs) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) invalidPptx('slides[' + index + ']', 'must be an object')
  const path = 'slides[' + index + ']'
  const design = slidePptxDesign(inputs.design, source, path)
  const slide = pptx.addSlide()
  slide.background = { color: design.theme.bg }
  if (Object.hasOwn(source, 'elements') || source.layout === 'canvas') {
    renderPptxElements(slide, pptx, source, design, inputs.images, index)
  } else {
    const content = legacyContent(source, index, inputs.subtitle)
    const layout = pickLayout(source, content)
    validateLayoutEvidence(layout, content)
    if (layout !== 'cover' && content.subtitle) content.bullets.unshift(content.subtitle)
    const images = legacyImagesForSlide(inputs.images, index, inputs.total)
    const automaticImages = images.some((image) => image.x === undefined || image.y === undefined)
    const textDesign = automaticImages ? { ...design, width: design.width * 0.56 } : design
    RENDERERS[layout](slide, pptx, textDesign, content)
    renderLegacyImages(slide, images, design, path)
  }
  if (source.notes !== undefined) slide.addNotes(pptxText(source.notes, path + '.notes'))
  addFooter(slide, pptx, design, index, inputs.total, inputs.brand, inputs.generatedAt)
}

export async function buildPptxArtifactBuffer({
  title = 'Presentation', subtitle = '', theme, design, brand = '',
  slides = [], preparedImages = [], generatedAt = null,
} = {}) {
  if (!Array.isArray(slides) || slides.length === 0) throw new Error('slides 不能为空')
  if (slides.length > PPTX_LIMITS.slides) invalidPptx('slides', 'must contain at most ' + PPTX_LIMITS.slides + ' slides')
  pptxText(title, 'title')
  pptxText(subtitle, 'subtitle')
  pptxText(brand, 'brand', 500)
  const resolvedGeneratedAt = resolveGeneratedAt(generatedAt)
  const resolvedDesign = resolvePptxDesign({ title, subtitle, slides, theme, design })
  const images = prepareImages(preparedImages, slides.length)
  const PptxGen = (await import('pptxgenjs')).default
  const pptx = new PptxGen()
  pptx.defineLayout({ name: 'GUGO_DESIGN', width: resolvedDesign.width, height: resolvedDesign.height })
  pptx.layout = 'GUGO_DESIGN'
  pptx.title = title
  pptx.author = brand
  pptx.company = brand
  pptx.subject = title
  pptx.lang = 'zh-CN'
  pptx.theme = { headFontFace: resolvedDesign.headingFont, bodyFontFace: resolvedDesign.bodyFont, lang: 'zh-CN' }
  const inputs = { design: resolvedDesign, images, total: slides.length, subtitle, brand, generatedAt: resolvedGeneratedAt }
  slides.forEach((slide, index) => renderSlide(pptx, slide, index, inputs))
  const buffer = await pptx.write({ outputType: 'nodebuffer' })
  const injection = await injectEaFontWithReceipt(buffer, resolvedDesign.eastAsianFont)
  return {
    buffer: await normalizePptxPackage(Buffer.from(injection.bytes), resolvedGeneratedAt, resolvedDesign),
    themeName: resolvedDesign.themeName,
    generatedAt: resolvedGeneratedAt.toISOString(),
    fontInjection: Object.freeze({
      status: injection.status, font: resolvedDesign.eastAsianFont,
      ...(injection.warning ? { warning: injection.warning } : {}),
    }),
  }
}

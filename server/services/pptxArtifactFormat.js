import { officeImageSize } from './officeImageLayout.js'
import { validatePreparedOfficeImages } from './officePreparedImageValidation.js'
import {
  addFooter,
  renderBullets,
  renderChart,
  renderCover,
  renderEnd,
  renderKpi,
  renderProcess,
  renderQuote,
  renderSection,
  renderSplit,
  renderStatement,
} from './pptxArtifactSlideRendering.js'
import {
  HEAD_FONT, BODY_FONT, CJK_FONT,
  PREMIUM_THEMES, resolvePremiumTheme,
  normalizeBullets, injectEaFontWithReceipt,
} from '../../src/lib/pptCore.js'

/* ════════════════════════ PPTX (premium) ════════════════════════ */
// fonts / themes / shape helper / normalizeBullets 均来自 src/lib/pptCore.js
const THEMES = PREMIUM_THEMES
const resolvePptxTheme = resolvePremiumTheme

function resolveGeneratedAt(value) {
  const date = value == null ? new Date() : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('generatedAt must be a valid date')
  return date
}

async function normalizePptxPackage(buffer, generatedAt) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buffer)
  const coreFile = zip.file('docProps/core.xml')
  if (coreFile) {
    const iso = generatedAt.toISOString().replace(/\.\d{3}Z$/, 'Z')
    const core = await coreFile.async('string')
    zip.file('docProps/core.xml', core
      .replace(/(<dcterms:created\b[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${iso}$2`)
      .replace(/(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${iso}$2`))
  }
  for (const entry of Object.values(zip.files)) entry.date = new Date(generatedAt.getTime())
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function normalizeKpis(slide = {}) {
  const raw = Array.isArray(slide.kpi) ? slide.kpi : Array.isArray(slide.kpis) ? slide.kpis : []
  return raw
    .filter((k) => k && (k.value != null))
    .slice(0, 4)
    .map((k) => ({
      value: String(k.value),
      label: String(k.label || ''),
      delta: k.delta ? String(k.delta) : '',
      unit: k.unit ? String(k.unit) : '',
    }))
}

function normalizeChart(slide = {}) {
  const c = slide.chart
  if (!c || typeof c !== 'object') return null
  const type = ['bar', 'bar-stacked', 'line', 'pie'].includes(c.type) ? c.type : 'bar'
  const categories = Array.isArray(c.categories) ? c.categories.map((x) => String(x)) : []
  const seriesRaw = Array.isArray(c.series) ? c.series : []
  const series = seriesRaw
    .map((s) => ({
      name: String(s?.name || ''),
      values: Array.isArray(s?.values) ? s.values.map(Number).filter((n) => Number.isFinite(n)) : [],
    }))
    .filter((s) => s.values.length > 0)
  if (!series.length) return null
  return { type, categories, series }
}

function requireExplicitChart(slide, slideIndex) {
  const chart = slide?.chart
  const path = `slides[${slideIndex}].chart`
  if (!chart || typeof chart !== 'object' || Array.isArray(chart)) {
    throw new TypeError(`${path} must be an object when layout is "chart"`)
  }
  if (!Array.isArray(chart.series) || chart.series.length === 0) {
    throw new TypeError(`${path}.series must contain at least one series`)
  }
  chart.series.forEach((series, seriesIndex) => {
    if (!series || typeof series !== 'object' || Array.isArray(series)) {
      throw new TypeError(`${path}.series[${seriesIndex}] must be an object`)
    }
    if (!Array.isArray(series.values) || series.values.length === 0) {
      throw new TypeError(`${path}.series[${seriesIndex}].values must contain at least one finite number`)
    }
    if (!series.values.some((value) => Number.isFinite(Number(value)))) {
      throw new TypeError(`${path}.series[${seriesIndex}].values must contain at least one finite number`)
    }
  })
  return normalizeChart(slide)
}

function requireExplicitLayoutContent({ layout, slideIndex, bullets, kpis }) {
  if (layout === 'kpi' && kpis.length === 0) {
    throw new TypeError(
      `slides[${slideIndex}].kpi must contain at least one item with a value when layout is "kpi"`,
    )
  }
  if (['process', 'bullets', 'split'].includes(layout) && bullets.length === 0) {
    throw new TypeError(
      `slides[${slideIndex}].bullets or body must contain at least one non-empty item when layout is "${layout}"`,
    )
  }
}

function imageAltText(image, imageIndex) {
  const preferred = String(image?.alt || '').trim()
  const fallback = String(image?.sourceName || '').trim() || `Image ${imageIndex + 1}`
  return Array.from(preferred || fallback, (character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? ' ' : character
  }).join('').trim().slice(0, 500)
}

/* ── Layout picker（内容感知）── */

function pickLayout(slide, i, total) {
  const explicit = String(slide?.layout || '').toLowerCase()
  if (explicit && ['cover', 'section', 'kpi', 'statement', 'split', 'process', 'chart', 'quote', 'bullets', 'end'].includes(explicit)) {
    return explicit
  }
  if (i === 0) return 'cover'
  if (i === total - 1 && /thank|感谢|结束|结语|致谢|q\s*&\s*a/i.test(slide?.title || '')) return 'end'
  if (normalizeChart(slide)) return 'chart'
  if (normalizeKpis(slide).length) return 'kpi'
  if (slide?.quote) return 'quote'
  const bullets = normalizeBullets(slide)
  if (bullets.length === 0) return 'statement'
  if (bullets.length === 1) return 'statement'
  if (bullets.length === 2 && bullets.every((b) => b.length < 30)) return 'split'
  if (bullets.some((b) => /^\d+[.、]|→|⇒|步骤|阶段/.test(b)) && bullets.length <= 5) return 'process'
  return 'bullets'
}

/* ── 主入口 ── */

export async function buildPptxArtifactBuffer({ title = 'Presentation', subtitle = '', theme: themeName, brand = 'Gugo', slides = [], preparedImages = [], generatedAt = null } = {}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('slides 不能为空')
  }
  const total = slides.length
  const resolvedGeneratedAt = resolveGeneratedAt(generatedAt)
  const officeImages = validatePreparedOfficeImages(preparedImages, {
    targetCount: total,
    targetKind: 'slide deck',
  }).map((image) => Object.freeze({
    ...image,
    mimeType: image.extension === 'jpg' ? 'image/jpeg' : 'image/png',
    dataUri: `data:${image.extension === 'jpg' ? 'image/jpeg' : 'image/png'};base64,${image.buffer.toString('base64')}`,
  }))
  const PptxGen = (await import('pptxgenjs')).default
  const pptx = new PptxGen()
  pptx.layout = 'LAYOUT_WIDE'   // 13.333 x 7.5 in
  pptx.title = title
  pptx.author = brand
  pptx.lang = 'zh-CN'
  pptx.subject = title
  pptx.company = brand
  pptx.theme = {
    headFontFace: HEAD_FONT,
    bodyFontFace: BODY_FONT,
    lang: 'zh-CN',
  }

  const explicit = Object.hasOwn(THEMES, themeName) ? THEMES[themeName] : null
  const theme = explicit || resolvePptxTheme(`${title} ${subtitle} ${slides.map((s) => s?.title || '').join(' ')}`)

  let sectionCounter = 0

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i] || {}
    const slide = pptx.addSlide()
    const explicitLayout = String(s.layout || '').toLowerCase()
    const layout = pickLayout(s, i, total)
    const titleText = String(s.title || `Slide ${i + 1}`)
    const eyebrow = s.eyebrow
    const bullets = normalizeBullets(s)
    const kpis = normalizeKpis(s)
    requireExplicitLayoutContent({ layout: explicitLayout, slideIndex: i, bullets, kpis })
    const chart = explicitLayout === 'chart'
      ? requireExplicitChart(s, i)
      : normalizeChart(s)

    switch (layout) {
      case 'cover':
        renderCover(slide, pptx, theme, {
          deckTitle: title,
          subtitle: subtitle || s.subtitle || bullets[0] || '',
          brand,
          generatedAt: resolvedGeneratedAt,
        })
        break
      case 'section':
        sectionCounter += 1
        renderSection(slide, pptx, theme, { titleText, eyebrow, index: sectionCounter, brand })
        break
      case 'statement':
        renderStatement(slide, pptx, theme, { titleText, bullets, brand })
        break
      case 'split':
        renderSplit(slide, pptx, theme, { titleText, bullets, eyebrow })
        break
      case 'process':
        renderProcess(slide, pptx, theme, { titleText, bullets, eyebrow })
        break
      case 'kpi':
        renderKpi(slide, pptx, theme, { titleText, kpis, eyebrow })
        break
      case 'chart':
        renderChart(slide, pptx, theme, { titleText, chart, eyebrow })
        break
      case 'quote':
        renderQuote(slide, pptx, theme, { titleText, quote: s.quote, eyebrow })
        break
      case 'end':
        renderEnd(slide, pptx, theme, { titleText, bullets, brand })
        break
      case 'bullets':
      default:
        renderBullets(slide, pptx, theme, { titleText, bullets, eyebrow, brand })
        break
    }

    // cover / end / section 不画 footer，节奏更稳
    if (!['cover', 'end', 'section'].includes(layout)) {
      addFooter(slide, pptx, theme, i, total, brand)
    }

    const slideImages = officeImages.filter((image, imageIndex) => (
      (image.targetIndex || ((imageIndex % total) + 1)) === i + 1
    ))
    slideImages.forEach((image, imageIndex) => {
      const size = officeImageSize(image, { defaultWidth: 4.1, maxWidth: 11.8, maxHeight: 5.8 })
      const x = image.x ?? Math.max(0.75, 12.55 - size.width - (imageIndex * 0.18))
      const y = image.y ?? Math.max(0.9, 6.55 - size.height - (imageIndex * 0.18))
      slide.addImage({
        data: image.dataUri,
        x,
        y,
        w: size.width,
        h: size.height,
        altText: imageAltText(image, imageIndex),
      })
    })
  }

  let buffer = await pptx.write({ outputType: 'nodebuffer' })

  // 后处理 theme.xml 注入 east-asia 字体，保证 Win/Mac Office 中文字形一致
  const injection = await injectEaFontWithReceipt(buffer, CJK_FONT)
  buffer = await normalizePptxPackage(Buffer.from(injection.bytes), resolvedGeneratedAt)

  return {
    buffer,
    themeName: explicit ? themeName : undefined,
    generatedAt: resolvedGeneratedAt.toISOString(),
    fontInjection: Object.freeze({ status: injection.status, font: CJK_FONT, ...(injection.warning ? { warning: injection.warning } : {}) }),
  }
}

/* ── 注入 east-asia 字体（让 CJK 渲染稳定） ──
 * 实现已下沉到 src/lib/pptCore.js#injectEaFont
 */

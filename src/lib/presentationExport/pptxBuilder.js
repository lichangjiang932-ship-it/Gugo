import { CJK_FONT, injectEaFont } from '../pptCore.js'
import { resolvePresentationTheme } from '../presentationThemes.js'
import { buildPresentationFilename, parseMarkdownSlides } from './presentationParser.js'
import { addContentSlide, addCoverSlide, addEndSlide, addImageSlide, addTocSlide } from './pptxBasicSlides.js'
import { addDataSlide, addProcessSlide, addQuoteSlide, addSplitSlide, addTableSlide } from './pptxAdvancedSlides.js'
import { addChartSlide, addSectionSlide } from './pptxChartSlides.js'
import { PPTX_MIME } from './pptxConstants.js'
import { setPresentationTheme } from './pptxThemeState.js'

export { PPTX_MIME, SLIDE_H, SLIDE_W } from './pptxConstants.js'

async function buildPresentationFromMarkdown(markdown, { title } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('\u6ca1\u6709\u53ef\u5bfc\u51fa\u7684 PPT \u5185\u5bb9')
  setPresentationTheme(resolvePresentationTheme(`${title || ''} ${slides.map((slide) => slide.title).join(' ')}`))

  const module = await import('pptxgenjs')
  const PptxGenJS = module.default || module
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Gugo'
  pptx.company = 'Gugo'
  pptx.subject = title || slides[0].title
  pptx.title = title || slides[0].title
  pptx.lang = 'zh-CN'
  pptx.theme = {
    headFontFace: 'Calibri',
    bodyFontFace: 'Calibri',
    lang: 'zh-CN',
  }

  const total = slides.length

  slides.forEach((slideData, index) => {
    const type = slideData.type
    switch (type) {
      case 'cover': addCoverSlide(pptx, slideData, index, total); break
      case 'toc': addTocSlide(pptx, slideData, index, total); break
      case 'image': addImageSlide(pptx, slideData, index, total); break
      case 'end': addEndSlide(pptx, slideData, index, total); break
      case 'data': addDataSlide(pptx, slideData, index, total); break
      case 'quote': addQuoteSlide(pptx, slideData, index, total); break
      case 'split': addSplitSlide(pptx, slideData, index, total); break
      case 'table': addTableSlide(pptx, slideData, index, total); break
      case 'process': addProcessSlide(pptx, slideData, index, total); break
      case 'chart': addChartSlide(pptx, slideData, index, total); break
      case 'section': addSectionSlide(pptx, slideData, index, total); break
      default: addContentSlide(pptx, slideData, index, total)
    }
  })

  return { pptx, slides }
}

export function saveBlob(blob, filename) {
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

export async function createPptxBlobFromMarkdown(markdown, { title } = {}) {
  const { pptx } = await buildPresentationFromMarkdown(markdown, { title })
  const raw = await pptx.write({ outputType: 'blob' })
  const buf = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : raw
  const injected = await injectEaFont(buf, CJK_FONT)
  return new Blob([injected], { type: PPTX_MIME })
}

export async function downloadPptxFromMarkdown(markdown, { title, filename } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('\u6ca1\u6709\u53ef\u5bfc\u51fa\u7684 PPT \u5185\u5bb9')

  const blob = await createPptxBlobFromMarkdown(markdown, { title: title || slides[0].title })
  saveBlob(blob, filename || buildPresentationFilename(title || slides[0].title))
  return blob
}

/* \u2500\u2500 HTML Preview (iframe-rendered slides) \u2500\u2500 */

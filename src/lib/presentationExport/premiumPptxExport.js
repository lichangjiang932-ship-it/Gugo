import { CJK_FONT, injectEaFont } from '../pptCore.js'
import { buildPresentationFilename, parseMarkdownSlides } from './presentationParser.js'
import { saveBlob } from './pptxBuilder.js'
import { PPTX_MIME, SLIDE_H, SLIDE_W } from './pptxConstants.js'
import { buildPremiumHtmlPreview } from './premiumPreview.js'

export async function createPremiumPptxBlob(markdown, { title, onProgress } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('\u6ca1\u6709\u53ef\u5bfc\u51fa\u7684 PPT \u5185\u5bb9')

  // 1. Create off-screen container
  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed;left:-99999px;top:0;width:1920px;'
  document.body.appendChild(container)

  // 2. Render premium HTML
  const html = buildPremiumHtmlPreview(markdown)
  container.innerHTML = html

  // 3. Wait for fonts
  await document.fonts.ready

  // Small extra delay for layout stabilization
  await new Promise((r) => setTimeout(r, 200))

  // 4. Screenshot each slide
  const slideElements = container.querySelectorAll('.slide')
  const images = []
  for (let i = 0; i < slideElements.length; i++) {
    const el = slideElements[i]
    onProgress?.(i + 1, slideElements.length)
    const { toPng } = await import('html-to-image')
    const dataUrl = await toPng(el, {
      width: 1920,
      height: 1080,
      pixelRatio: 1,
      cacheBust: true,
      backgroundColor: null,
    })
    images.push(dataUrl)
  }

  // 5. Clean up
  document.body.removeChild(container)

  // 6. Build PPTX
  const module = await import('pptxgenjs')
  const PptxGenJS = module.default || module
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Gugo'
  pptx.subject = title || slides[0].title
  pptx.title = title || slides[0].title

  for (const dataUrl of images) {
    const slide = pptx.addSlide()
    slide.background = { color: 'F4EFE5' }
    slide.addImage({ data: dataUrl, x: 0, y: 0, w: SLIDE_W, h: SLIDE_H })
  }

  const raw = await pptx.write({ outputType: 'blob' })
  const buf = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : raw
  const injected = await injectEaFont(buf, CJK_FONT)
  return new Blob([injected], { type: PPTX_MIME })
}

export async function downloadPremiumPptx(markdown, { title, filename, onProgress } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('\u6ca1\u6709\u53ef\u5bfc\u51fa\u7684 PPT \u5185\u5bb9')

  const blob = await createPremiumPptxBlob(markdown, {
    title: title || slides[0].title,
    onProgress,
  })
  saveBlob(blob, filename || buildPresentationFilename(title || slides[0].title))
  return blob
}

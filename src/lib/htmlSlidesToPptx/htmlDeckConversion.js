import {
  RENDER_H,
  RENDER_W,
  SLIDE_H_IN,
  SLIDE_W_IN,
  activateSlide,
  extractEditableText,
  getSlides,
  installTextWipeStylesheet,
  mountDeckIframe,
} from './htmlDeckDom.js'

export async function convertHtmlDeckToPptx(html, { title = 'presentation', onProgress } = {}) {
  if (typeof document === 'undefined') {
    throw new Error('convertHtmlDeckToPptx \u53ea\u80fd\u5728\u6d4f\u89c8\u5668\u73af\u5883\u8c03\u7528')
  }

  const { iframe, doc } = await mountDeckIframe(html)
  try {
    const slides = getSlides(doc)
    if (!slides.length) throw new Error('\u672a\u5728 HTML \u4e2d\u627e\u5230\u4efb\u4f55 .slide \u8282\u70b9')

    // \u52a8\u6001\u52a0\u8f7d\u5927\u5305,\u8ba9 vite \u628a\u5b83\u4eec\u5207\u5230\u72ec\u7acb chunk,\u9996\u5c4f\u4e0d\u5e26\u8fd9\u4e24\u4e2a\u4f9d\u8d56
    const [{ toPng }, PptxGenJSMod] = await Promise.all([
      import('html-to-image'),
      import('pptxgenjs'),
    ])
    const PptxGenJS = PptxGenJSMod.default || PptxGenJSMod

    const pptx = new PptxGenJS()
    pptx.layout = 'LAYOUT_WIDE' // 13.333 x 7.5
    pptx.title = title
    pptx.author = 'Gugo'

    for (let i = 0; i < slides.length; i++) {
      onProgress?.(i + 1, slides.length)
      const node = slides[i]
      const restore = activateSlide(slides, node)
      // restore() \u5fc5\u987b\u65e0\u8bba toPng / extractEditableText \u662f\u5426\u629b\u9519\u90fd\u6267\u884c,
      // \u5426\u5219\u4e0b\u5f20 slide \u7684 activateSlide \u4f1a\u57fa\u4e8e"\u88ab\u5f3a\u5236 display:none"\u7684\u72b6\u6001\u518d\u53bb\u627e\u8282\u70b9.
      let dataUrl
      let editable
      let wipeDispose
      try {
        // \u8ba9\u6d4f\u89c8\u5668\u8d70\u4e00\u6b21\u5e03\u5c40 + \u52a8\u753b\u9996\u5e27
        await new Promise((r) => setTimeout(r, 80))
        // \u5173\u952e\u987a\u5e8f:\u5148\u6293 editable(\u6b64\u65f6 color \u8fd8\u662f deck \u539f\u8272),\u518d wipe,\u518d\u622a\u56fe.
        editable = extractEditableText(node)
        wipeDispose = installTextWipeStylesheet(doc)
        // \u7b49\u6d4f\u89c8\u5668\u628a wipe \u6837\u5f0f\u5e94\u7528\u5230\u5e03\u5c40
        await new Promise((r) => setTimeout(r, 30))
        try {
          dataUrl = await toPng(node, {
            width: RENDER_W,
            height: RENDER_H,
            pixelRatio: 1,
            cacheBust: true,
            backgroundColor: '#0b0d12',
            skipFonts: false,
            style: { transform: 'none' },
          })
        } catch (err) {
          throw new Error(`\u7b2c ${i + 1} \u9875\u622a\u56fe\u5931\u8d25\uff1a${err.message || err}`, { cause: err })
        }
      } finally {
        wipeDispose?.()
        restore()
      }

      const slide = pptx.addSlide()
      // \u6574\u9875\u80cc\u666f\u56fe(\u53ea\u5269\u80cc\u666f/\u88c5\u9970/\u5149\u6655/\u5361\u7247,\u6587\u5b57\u5df2\u88ab wipe)
      slide.addImage({
        data: dataUrl,
        x: 0, y: 0, w: SLIDE_W_IN, h: SLIDE_H_IN,
      })
      // \u6587\u5b57\u5c42:pptxgenjs \u771f\u5b9e\u6587\u672c\u6846,\u7ee7\u627f deck \u539f\u8272,\u53ef\u5728 Office \u76f4\u63a5\u53cc\u51fb\u7f16\u8f91.
      for (const t of editable) {
        slide.addText(t.text, {
          x: t.x, y: t.y, w: Math.max(0.3, t.w), h: Math.max(0.2, t.h),
          fontSize: t.fontPt,
          bold: t.bold,
          align: t.align,
          color: t.color || 'E6E8EE',
          fill: { type: 'solid', color: '000000', transparency: 100 },
          line: { color: 'FFFFFF', width: 0, transparency: 100 },
          margin: 0,
          valign: 'top',
          isTextBox: true,
        })
      }
    }

    const blob = await pptx.write({ outputType: 'blob' })
    return blob
  } finally {
    iframe.remove()
  }
}

export async function downloadHtmlDeckAsPptx(html, { title, filename, onProgress } = {}) {
  const blob = await convertHtmlDeckToPptx(html, { title, onProgress })
  const safe = (filename || `${title || 'presentation'}.pptx`).replace(/[\\/:*?"<>|\s]+/g, '-')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = safe.endsWith('.pptx') ? safe : `${safe}.pptx`
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 100)
}


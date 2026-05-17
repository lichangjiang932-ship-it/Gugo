// 把 htmlppt 技能产出的「单文件 HTML 幻灯片」转成可编辑的 .pptx
//
// 思路：在隐藏 iframe 里渲染 HTML deck，对每个 .slide 节点强制 active 后用
// html-to-image 截成 PNG，再用 pptxgenjs 把 PNG 当 slide 背景，同时把页内
// 主要文本（h1/h2/p/li）以透明文本框形式叠加在原位置，这样在 Office /
// Keynote / WPS 里既保留视觉效果，也能直接双击修改文字。
//
// 仅在浏览器环境使用（依赖 document / html-to-image / pptxgenjs）。
// 注意:html-to-image 和 pptxgenjs 都走动态 import,与 presentationExport.js 对齐 —
// 否则 vite 会报 INEFFECTIVE_DYNAMIC_IMPORT,这两个大包会被打进主 chunk.

const SLIDE_W_IN = 13.333
const SLIDE_H_IN = 7.5
const RENDER_W = 1920
const RENDER_H = 1080

// 在 body 里挂一个隐藏 iframe，写入 html 并等到 .slide 全部渲染好。
//
// 安全:sandbox="allow-same-origin" 禁止脚本执行,但保留同源 DOM 访问,
// 这样模型生成的 deck 即便注入 <script> 也跑不起来,无法读取父页 token /
// localStorage.代价:deck 里 Chart.js 等 JS 渲染图表不会出现在 PPTX,
// 纯 HTML/CSS deck 不受影响.若日后需要 JS 图表,要改用 postMessage 协议.
async function mountDeckIframe(html) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('sandbox', 'allow-same-origin')
  iframe.style.cssText = [
    'position:fixed',
    'left:-99999px',
    'top:0',
    `width:${RENDER_W}px`,
    `height:${RENDER_H}px`,
    'border:0',
    'pointer-events:none',
    'opacity:0',
  ].join(';')
  document.body.appendChild(iframe)

  await new Promise((resolve) => {
    iframe.addEventListener('load', () => resolve(), { once: true })
    iframe.srcdoc = html
  })

  const doc = iframe.contentDocument
  if (!doc) {
    iframe.remove()
    throw new Error('无法访问 iframe 文档（可能被沙箱拦截）')
  }
  // 强制 iframe 视口大小，避免被 deck 自身的 100vw/vh 算成 0
  try {
    iframe.contentWindow?.dispatchEvent?.(new Event('resize'))
  } catch { /* noop */ }

  // 等字体 + 一帧动画
  if (doc.fonts?.ready) {
    try { await doc.fonts.ready } catch { /* noop */ }
  }
  await new Promise((r) => setTimeout(r, 150))

  return { iframe, doc }
}

function getSlides(doc) {
  const list = Array.from(doc.querySelectorAll('.slide, section.slide, [data-slide]'))
  if (list.length) return list
  // 兜底：把 <section> 全当 slide
  return Array.from(doc.querySelectorAll('section'))
}

// 让单个 slide 进入"被截图"状态：清掉其它 slide 的 active，本张加 active 并
// 临时把定位改成 static 占满 iframe，避免 absolute+opacity:0 截出空白。
function activateSlide(allSlides, target) {
  const restore = []
  for (const s of allSlides) {
    const wasActive = s.classList.contains('active')
    const prevStyle = s.getAttribute('style') || ''
    restore.push(() => {
      s.classList.toggle('active', wasActive)
      if (prevStyle) s.setAttribute('style', prevStyle)
      else s.removeAttribute('style')
    })
    if (s === target) {
      s.classList.add('active')
      s.style.cssText = `${prevStyle};position:relative !important;inset:auto !important;opacity:1 !important;pointer-events:auto !important;display:flex !important;width:${RENDER_W}px !important;height:${RENDER_H}px !important;`
    } else {
      s.classList.remove('active')
      s.style.cssText = `${prevStyle};display:none !important;`
    }
  }
  return () => restore.forEach((fn) => fn())
}

// 从 slide DOM 抓出"主要可编辑文本"层，按 iframe 像素返回 EMU-friendly 比例。
function extractEditableText(slide) {
  const rectSlide = slide.getBoundingClientRect()
  const out = []
  const selectors = ['h1', 'h2', 'h3', 'p', 'li', '.kpi-num', '.kpi-label']
  for (const sel of selectors) {
    const nodes = Array.from(slide.querySelectorAll(sel))
    for (const node of nodes) {
      const text = (node.textContent || '').trim()
      if (!text) continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) continue
      const style = slide.ownerDocument.defaultView.getComputedStyle(node)
      const fontSizePx = parseFloat(style.fontSize) || 18
      const isBold = parseInt(style.fontWeight, 10) >= 600
      const align = style.textAlign === 'center' ? 'center'
        : style.textAlign === 'right' ? 'right'
        : 'left'
      out.push({
        text,
        // 把 iframe 像素映射到 PPT 英寸（PPT 是 13.333 x 7.5 in，对应 RENDER_W x RENDER_H）
        x: ((rect.left - rectSlide.left) / RENDER_W) * SLIDE_W_IN,
        y: ((rect.top - rectSlide.top) / RENDER_H) * SLIDE_H_IN,
        w: (rect.width / RENDER_W) * SLIDE_W_IN,
        h: (rect.height / RENDER_H) * SLIDE_H_IN,
        fontPt: Math.max(8, Math.round((fontSizePx / RENDER_H) * SLIDE_H_IN * 72)),
        bold: isBold,
        align,
        tag: node.tagName.toLowerCase(),
      })
    }
  }
  // 去重：同文本同位置只保留一次（深层节点 + 父节点都会命中）
  const seen = new Set()
  return out.filter((item) => {
    const key = `${item.text}|${item.x.toFixed(2)}|${item.y.toFixed(2)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function convertHtmlDeckToPptx(html, { title = 'presentation', onProgress } = {}) {
  if (typeof document === 'undefined') {
    throw new Error('convertHtmlDeckToPptx 只能在浏览器环境调用')
  }

  const { iframe, doc } = await mountDeckIframe(html)
  try {
    const slides = getSlides(doc)
    if (!slides.length) throw new Error('未在 HTML 中找到任何 .slide 节点')

    // 动态加载大包,让 vite 把它们切到独立 chunk,首屏不带这两个依赖
    const [{ toPng }, PptxGenJSMod] = await Promise.all([
      import('html-to-image'),
      import('pptxgenjs'),
    ])
    const PptxGenJS = PptxGenJSMod.default || PptxGenJSMod

    const pptx = new PptxGenJS()
    pptx.layout = 'LAYOUT_WIDE' // 13.333 x 7.5
    pptx.title = title
    pptx.author = 'your-model-atelier'

    for (let i = 0; i < slides.length; i++) {
      onProgress?.(i + 1, slides.length)
      const node = slides[i]
      const restore = activateSlide(slides, node)
      // restore() 必须无论 toPng / extractEditableText 是否抛错都执行,
      // 否则下张 slide 的 activateSlide 会基于"被强制 display:none"的状态再去找节点.
      let dataUrl
      let editable
      try {
        // 让浏览器走一次布局 + 动画首帧
        await new Promise((r) => setTimeout(r, 80))
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
          throw new Error(`第 ${i + 1} 页截图失败：${err.message || err}`, { cause: err })
        }
        editable = extractEditableText(node)
      } finally {
        restore()
      }

      const slide = pptx.addSlide()
      // 整页背景图（视觉真相）
      slide.addImage({
        data: dataUrl,
        x: 0, y: 0, w: SLIDE_W_IN, h: SLIDE_H_IN,
      })
      // 透明文本框覆盖，使文字可编辑（位置/字号尽量贴原版）
      for (const t of editable) {
        slide.addText(t.text, {
          x: t.x, y: t.y, w: Math.max(0.3, t.w), h: Math.max(0.2, t.h),
          fontSize: t.fontPt,
          bold: t.bold,
          align: t.align,
          color: 'FFFFFF',
          fill: { type: 'solid', color: '000000', transparency: 100 }, // 完全透明
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

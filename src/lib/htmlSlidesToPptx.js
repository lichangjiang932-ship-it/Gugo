// 把 htmlppt 技能产出的「单文件 HTML 幻灯片」转成可编辑的 .pptx
//
// 流程:在隐藏 iframe 里渲染 HTML deck → 对每个 .slide 强制 active → 临时把
// 所有文字"挖空"(color/text-fill 透明、background-image 清除) → html-to-image
// 截 PNG(只剩背景/装饰) → 还原文字 → pptxgenjs 把 PNG 当背景图 + 把每个文本
// 节点叠加成真实文本框(继承 deck 原色),这样最终 .pptx 里:
//   - 背景层:截图(无文字干扰,保留渐变光晕/卡片/装饰)
//   - 文字层:pptxgenjs 文本框(可编辑、位置精准、不与背景图重影)
//
// 早期版本直接 overlay 透明 textbox 但保留截图里的文字,导致双层文字字号/wrap
// 行为差异肉眼可见重影,看起来"文本错乱".现在的方案根除该问题.
//
// 损失:CSS 渐变文字效果(background-clip:text)在 PPT 文本框里无法重现,
// 最终 PPT 里文字是 deck 设置的 fallback color(deck 已经在用 color 兜底,
// 见 prompt 里"文字色用真实纯色而非依赖渐变 fallback").
//
// 仅在浏览器环境使用(依赖 document / html-to-image / pptxgenjs).
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

export function collectHtmlDeckSlides(doc) {
  if (!doc?.querySelectorAll) return []
  const selectors = [
    '.slide',
    '[data-slide]',
    'section',
    '.page',
    '.deck-page',
    '.deck-slide',
    '.presentation-slide',
    'article',
  ]
  const candidates = []
  const seen = new Set()
  for (const selector of selectors) {
    for (const node of Array.from(doc.querySelectorAll(selector))) {
      if (!node || seen.has(node) || node === doc.body || node === doc.documentElement) continue
      seen.add(node)
      candidates.push(node)
    }
  }

  // 如果一个候选 slide 包含另一个候选 slide，优先保留外层，避免把 slide 内部的 section/card 当成独立页。
  const slides = candidates.filter((node) => !candidates.some((other) => other !== node && other.contains(node)))
  slides.forEach((slide, index) => {
    slide.classList.add('slide')
    if (!slide.dataset.slide) slide.dataset.slide = String(index + 1)
  })
  return slides
}

function getSlides(doc) {
  return collectHtmlDeckSlides(doc)
}

// 截图前调用:在 iframe 里注入一个 style,把所有文字渲染"挖空"(color/text-fill
// 透明,清掉 -webkit-background-clip:text 的渐变文字,清掉 text-shadow).
// 截图就只剩背景/装饰元素,不含文字 — 再 overlay textbox 不会重影.
// 返回一个 dispose 函数还原.
function installTextWipeStylesheet(doc) {
  const style = doc.createElement('style')
  style.setAttribute('data-pptx-wipe', '1')
  style.textContent = `
    .slide.active, .slide.active *:not(svg):not(svg *) {
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
      text-shadow: none !important;
      caret-color: transparent !important;
    }
    /* 渐变文字依赖 background-clip:text 显示色彩,把 background-image 干掉. */
    .slide.active *:not(svg):not(svg *) {
      background-image: none !important;
      background-clip: initial !important;
      -webkit-background-clip: initial !important;
    }
    /* 装饰圆点 li::before 等是 ::before/::after 生成,保留. */
  `
  doc.head.appendChild(style)
  return () => { style.remove() }
}

// 把 rgb(a) / hex 颜色统一转 hex 6 位字符串,失败返回 fallback.
function colorToHex(input, fallback = 'E6E8EE') {
  if (!input) return fallback
  const s = String(input).trim()
  if (/^#?[0-9a-f]{6}$/i.test(s)) return s.replace(/^#/, '').toUpperCase()
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (!m) return fallback
  const r = Math.max(0, Math.min(255, parseInt(m[1], 10)))
  const g = Math.max(0, Math.min(255, parseInt(m[2], 10)))
  const b = Math.max(0, Math.min(255, parseInt(m[3], 10)))
  return ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()
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

export function collectEditableTextNodes(slide) {
  if (!slide?.querySelectorAll) return []
  const blockSelector = 'h1,h2,h3,h4,p,li,blockquote'
  const detailSelector = '.kpi-num,.kpi-label,.kpi-unit,.kpi-delta,.section-num,.toc-num,.pager,.tag,.badge,.subtitle,.caption,.eyebrow'
  const blockNodes = Array.from(slide.querySelectorAll(blockSelector))
    .filter((node) => (node.textContent || '').trim())
  const leafBlocks = blockNodes.filter((node) => !blockNodes.some((other) => (
    other !== node
    && node.contains(other)
    && (other.textContent || '').replace(/\s+/g, ' ').trim() === (node.textContent || '').replace(/\s+/g, ' ').trim()
  )))
  const detailNodes = Array.from(slide.querySelectorAll(detailSelector))
    .filter((node) => (node.textContent || '').trim())
    .filter((node) => !leafBlocks.some((block) => block === node || block.contains(node)))
  return [...leafBlocks, ...detailNodes].filter((node, index, all) => all.indexOf(node) === index)
}

// 从 slide DOM 抓出"主要可编辑文本"层,按 iframe 像素返回 EMU-friendly 比例.
// 必须在 installTextWipeStylesheet 之前调用,否则 computedStyle.color 拿到的是
// 透明色而非 deck 原配色.
function extractEditableText(slide) {
  const rectSlide = slide.getBoundingClientRect()
  const win = slide.ownerDocument.defaultView
  const out = []
  // 每段文字只映射到一个文本框。strong/em 等行内节点由父级段落承载，
  // 避免父子文本框同时覆盖同一串文字造成肉眼可见的重影。
  for (const node of collectEditableTextNodes(slide)) {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) continue

      // 同时检查节点是否在可视区域(避免 .overview hidden 节点也被抓)
      const style = win.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      // opacity 太低的视为不可见
      const opacity = parseFloat(style.opacity)
      if (Number.isFinite(opacity) && opacity < 0.05) continue

      const fontSizePx = parseFloat(style.fontSize) || 18
      const isBold = parseInt(style.fontWeight, 10) >= 600
      const align = style.textAlign === 'center' ? 'center'
        : style.textAlign === 'right' ? 'right'
        : 'left'
      // 读真实颜色;渐变文字 color 通常是 transparent,此时回退到 fallback(浅色 deck)
      const rawColor = style.color
      let hex = colorToHex(rawColor, '')
      if (!hex || /rgba?\([^)]*,\s*0\s*\)/i.test(rawColor)) {
        // 透明色 -> 用 body 默认色作 fallback
        const bodyColor = win.getComputedStyle(slide.ownerDocument.body).color
        hex = colorToHex(bodyColor, 'E6E8EE')
      }
      out.push({
        text,
        // 把 iframe 像素映射到 PPT 英寸(PPT 是 13.333 x 7.5 in,对应 RENDER_W x RENDER_H)
        x: ((rect.left - rectSlide.left) / RENDER_W) * SLIDE_W_IN,
        y: ((rect.top - rectSlide.top) / RENDER_H) * SLIDE_H_IN,
        w: (rect.width / RENDER_W) * SLIDE_W_IN,
        h: (rect.height / RENDER_H) * SLIDE_H_IN,
        fontPt: Math.max(8, Math.round((fontSizePx / RENDER_H) * SLIDE_H_IN * 72)),
        bold: isBold,
        align,
        color: hex,
        tag: node.tagName.toLowerCase(),
      })
  }
  // 去重:同文本同位置只保留一次(深层节点 + 父节点都会命中)
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
    pptx.author = 'Gugo'

    for (let i = 0; i < slides.length; i++) {
      onProgress?.(i + 1, slides.length)
      const node = slides[i]
      const restore = activateSlide(slides, node)
      // restore() 必须无论 toPng / extractEditableText 是否抛错都执行,
      // 否则下张 slide 的 activateSlide 会基于"被强制 display:none"的状态再去找节点.
      let dataUrl
      let editable
      let wipeDispose
      try {
        // 让浏览器走一次布局 + 动画首帧
        await new Promise((r) => setTimeout(r, 80))
        // 关键顺序:先抓 editable(此时 color 还是 deck 原色),再 wipe,再截图.
        editable = extractEditableText(node)
        wipeDispose = installTextWipeStylesheet(doc)
        // 等浏览器把 wipe 样式应用到布局
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
          throw new Error(`第 ${i + 1} 页截图失败：${err.message || err}`, { cause: err })
        }
      } finally {
        wipeDispose?.()
        restore()
      }

      const slide = pptx.addSlide()
      // 整页背景图(只剩背景/装饰/光晕/卡片,文字已被 wipe)
      slide.addImage({
        data: dataUrl,
        x: 0, y: 0, w: SLIDE_W_IN, h: SLIDE_H_IN,
      })
      // 文字层:pptxgenjs 真实文本框,继承 deck 原色,可在 Office 直接双击编辑.
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

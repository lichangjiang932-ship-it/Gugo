export const SLIDE_W_IN = 13.333
export const SLIDE_H_IN = 7.5
export const RENDER_W = 1920
export const RENDER_H = 1080

// \u5728 body \u91cc\u6302\u4e00\u4e2a\u9690\u85cf iframe\uff0c\u5199\u5165 html \u5e76\u7b49\u5230 .slide \u5168\u90e8\u6e32\u67d3\u597d\u3002
//
// \u5b89\u5168:sandbox="allow-same-origin" \u7981\u6b62\u811a\u672c\u6267\u884c,\u4f46\u4fdd\u7559\u540c\u6e90 DOM \u8bbf\u95ee,
// \u8fd9\u6837\u6a21\u578b\u751f\u6210\u7684 deck \u5373\u4fbf\u6ce8\u5165 <script> \u4e5f\u8dd1\u4e0d\u8d77\u6765,\u65e0\u6cd5\u8bfb\u53d6\u7236\u9875 token /
// localStorage.\u4ee3\u4ef7:deck \u91cc Chart.js \u7b49 JS \u6e32\u67d3\u56fe\u8868\u4e0d\u4f1a\u51fa\u73b0\u5728 PPTX,
// \u7eaf HTML/CSS deck \u4e0d\u53d7\u5f71\u54cd.\u82e5\u65e5\u540e\u9700\u8981 JS \u56fe\u8868,\u8981\u6539\u7528 postMessage \u534f\u8bae.
export async function mountDeckIframe(html) {
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
    throw new Error('\u65e0\u6cd5\u8bbf\u95ee iframe \u6587\u6863\uff08\u53ef\u80fd\u88ab\u6c99\u7bb1\u62e6\u622a\uff09')
  }
  // \u5f3a\u5236 iframe \u89c6\u53e3\u5927\u5c0f\uff0c\u907f\u514d\u88ab deck \u81ea\u8eab\u7684 100vw/vh \u7b97\u6210 0
  try {
    iframe.contentWindow?.dispatchEvent?.(new Event('resize'))
  } catch { /* noop */ }

  // \u7b49\u5b57\u4f53 + \u4e00\u5e27\u52a8\u753b
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

  // \u5982\u679c\u4e00\u4e2a\u5019\u9009 slide \u5305\u542b\u53e6\u4e00\u4e2a\u5019\u9009 slide\uff0c\u4f18\u5148\u4fdd\u7559\u5916\u5c42\uff0c\u907f\u514d\u628a slide \u5185\u90e8\u7684 section/card \u5f53\u6210\u72ec\u7acb\u9875\u3002
  const slides = candidates.filter((node) => !candidates.some((other) => other !== node && other.contains(node)))
  slides.forEach((slide, index) => {
    slide.classList.add('slide')
    if (!slide.dataset.slide) slide.dataset.slide = String(index + 1)
  })
  return slides
}

export function getSlides(doc) {
  return collectHtmlDeckSlides(doc)
}

// \u622a\u56fe\u524d\u8c03\u7528:\u5728 iframe \u91cc\u6ce8\u5165\u4e00\u4e2a style,\u628a\u6240\u6709\u6587\u5b57\u6e32\u67d3"\u6316\u7a7a"(color/text-fill
// \u900f\u660e,\u6e05\u6389 -webkit-background-clip:text \u7684\u6e10\u53d8\u6587\u5b57,\u6e05\u6389 text-shadow).
// \u622a\u56fe\u5c31\u53ea\u5269\u80cc\u666f/\u88c5\u9970\u5143\u7d20,\u4e0d\u542b\u6587\u5b57 \u2014 \u518d overlay textbox \u4e0d\u4f1a\u91cd\u5f71.
// \u8fd4\u56de\u4e00\u4e2a dispose \u51fd\u6570\u8fd8\u539f.
export function installTextWipeStylesheet(doc) {
  const style = doc.createElement('style')
  style.setAttribute('data-pptx-wipe', '1')
  style.textContent = `
    .slide.active, .slide.active *:not(svg):not(svg *) {
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
      text-shadow: none !important;
      caret-color: transparent !important;
    }
    /* \u6e10\u53d8\u6587\u5b57\u4f9d\u8d56 background-clip:text \u663e\u793a\u8272\u5f69,\u628a background-image \u5e72\u6389. */
    .slide.active *:not(svg):not(svg *) {
      background-image: none !important;
      background-clip: initial !important;
      -webkit-background-clip: initial !important;
    }
    /* \u88c5\u9970\u5706\u70b9 li::before \u7b49\u662f ::before/::after \u751f\u6210,\u4fdd\u7559. */
  `
  doc.head.appendChild(style)
  return () => { style.remove() }
}

// \u628a rgb(a) / hex \u989c\u8272\u7edf\u4e00\u8f6c hex 6 \u4f4d\u5b57\u7b26\u4e32,\u5931\u8d25\u8fd4\u56de fallback.
export function colorToHex(input, fallback = 'E6E8EE') {
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

// \u8ba9\u5355\u4e2a slide \u8fdb\u5165"\u88ab\u622a\u56fe"\u72b6\u6001\uff1a\u6e05\u6389\u5176\u5b83 slide \u7684 active\uff0c\u672c\u5f20\u52a0 active \u5e76
// \u4e34\u65f6\u628a\u5b9a\u4f4d\u6539\u6210 static \u5360\u6ee1 iframe\uff0c\u907f\u514d absolute+opacity:0 \u622a\u51fa\u7a7a\u767d\u3002
export function activateSlide(allSlides, target) {
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

// \u4ece slide DOM \u6293\u51fa"\u4e3b\u8981\u53ef\u7f16\u8f91\u6587\u672c"\u5c42,\u6309 iframe \u50cf\u7d20\u8fd4\u56de EMU-friendly \u6bd4\u4f8b.
// \u5fc5\u987b\u5728 installTextWipeStylesheet \u4e4b\u524d\u8c03\u7528,\u5426\u5219 computedStyle.color \u62ff\u5230\u7684\u662f
// \u900f\u660e\u8272\u800c\u975e deck \u539f\u914d\u8272.
export function extractEditableText(slide) {
  const rectSlide = slide.getBoundingClientRect()
  const win = slide.ownerDocument.defaultView
  const out = []
  // \u6bcf\u6bb5\u6587\u5b57\u53ea\u6620\u5c04\u5230\u4e00\u4e2a\u6587\u672c\u6846\u3002strong/em \u7b49\u884c\u5185\u8282\u70b9\u7531\u7236\u7ea7\u6bb5\u843d\u627f\u8f7d\uff0c
  // \u907f\u514d\u7236\u5b50\u6587\u672c\u6846\u540c\u65f6\u8986\u76d6\u540c\u4e00\u4e32\u6587\u5b57\u9020\u6210\u8089\u773c\u53ef\u89c1\u7684\u91cd\u5f71\u3002
  for (const node of collectEditableTextNodes(slide)) {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) continue

      // \u540c\u65f6\u68c0\u67e5\u8282\u70b9\u662f\u5426\u5728\u53ef\u89c6\u533a\u57df(\u907f\u514d .overview hidden \u8282\u70b9\u4e5f\u88ab\u6293)
      const style = win.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      // opacity \u592a\u4f4e\u7684\u89c6\u4e3a\u4e0d\u53ef\u89c1
      const opacity = parseFloat(style.opacity)
      if (Number.isFinite(opacity) && opacity < 0.05) continue

      const fontSizePx = parseFloat(style.fontSize) || 18
      const isBold = parseInt(style.fontWeight, 10) >= 600
      const align = style.textAlign === 'center' ? 'center'
        : style.textAlign === 'right' ? 'right'
        : 'left'
      // \u8bfb\u771f\u5b9e\u989c\u8272;\u6e10\u53d8\u6587\u5b57 color \u901a\u5e38\u662f transparent,\u6b64\u65f6\u56de\u9000\u5230 fallback(\u6d45\u8272 deck)
      const rawColor = style.color
      let hex = colorToHex(rawColor, '')
      if (!hex || /rgba?\([^)]*,\s*0\s*\)/i.test(rawColor)) {
        // \u900f\u660e\u8272 -> \u7528 body \u9ed8\u8ba4\u8272\u4f5c fallback
        const bodyColor = win.getComputedStyle(slide.ownerDocument.body).color
        hex = colorToHex(bodyColor, 'E6E8EE')
      }
      out.push({
        text,
        // \u628a iframe \u50cf\u7d20\u6620\u5c04\u5230 PPT \u82f1\u5bf8(PPT \u662f 13.333 x 7.5 in,\u5bf9\u5e94 RENDER_W x RENDER_H)
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
  // \u53bb\u91cd:\u540c\u6587\u672c\u540c\u4f4d\u7f6e\u53ea\u4fdd\u7559\u4e00\u6b21(\u6df1\u5c42\u8282\u70b9 + \u7236\u8282\u70b9\u90fd\u4f1a\u547d\u4e2d)
  const seen = new Set()
  return out.filter((item) => {
    const key = `${item.text}|${item.x.toFixed(2)}|${item.y.toFixed(2)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

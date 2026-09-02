import { BODY_FONT, HEAD_FONT, PREMIUM_THEMES, shape } from '../../src/lib/pptCore.js'

const THEMES = PREMIUM_THEMES

/* ── 装饰：克制，每张不超过 2 个装饰元素 ── */

function paintBackground(slide, pptx, theme) {
  slide.background = { color: theme.bg }
}

function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '').padStart(6, '0').slice(0, 6)
  return [
    Number.parseInt(s.slice(0, 2), 16),
    Number.parseInt(s.slice(2, 4), 16),
    Number.parseInt(s.slice(4, 6), 16),
  ].map((n) => (Number.isFinite(n) ? n : 0))
}

function rgbToHex([r, g, b]) {
  return [r, g, b]
    .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function mixHex(a, b, weight = 0.5) {
  const ar = hexToRgb(a)
  const br = hexToRgb(b)
  return rgbToHex(ar.map((v, i) => v * (1 - weight) + br[i] * weight))
}

function themeKey(theme) {
  const hit = Object.entries(THEMES).find(([, t]) =>
    t.bg === theme.bg && t.panel === theme.panel && t.accent === theme.accent)
  return hit?.[0] || 'noir'
}

function coverDecor(theme) {
  const key = themeKey(theme)
  const byTheme = {
    noir: { glow: mixHex(theme.panel, theme.accentSoft, 0.18), vignette: theme.panel, stripeT: 78, glowT: 54, vignetteT: 78 },
    paper: { glow: mixHex(theme.panel, theme.accentSoft, 0.16), vignette: 'FFFFFF', stripeT: 84, glowT: 42, vignetteT: 72 },
    ocean: { glow: mixHex(theme.panel, theme.accentSoft, 0.18), vignette: mixHex(theme.panel, theme.accent, 0.10), stripeT: 80, glowT: 52, vignetteT: 76 },
    forest: { glow: mixHex(theme.panel, theme.accentSoft, 0.16), vignette: mixHex(theme.panel, theme.accent, 0.10), stripeT: 80, glowT: 52, vignetteT: 76 },
  }
  return byTheme[key] || byTheme.noir
}

function addCoverBackdrop(slide, pptx, theme) {
  const decor = coverDecor(theme)
  // 3-element cap: two translucent ellipses approximate a radial vignette, one diagonal stripe adds motion.
  slide.addShape(shape(pptx, 'ellipse'), {
    x: 7.75, y: -1.45, w: 6.7, h: 6.7,
    fill: { color: decor.glow, transparency: decor.glowT },
    line: { color: decor.glow, transparency: 100 },
  })
  slide.addShape(shape(pptx, 'ellipse'), {
    x: -1.95, y: 4.45, w: 5.0, h: 3.8,
    fill: { color: decor.vignette, transparency: decor.vignetteT },
    line: { color: decor.vignette, transparency: 100 },
  })
  slide.addShape(shape(pptx, 'rect'), {
    x: 10.95, y: -0.65, w: 0.18, h: 4.1,
    rotate: 25,
    fill: { color: theme.accent, transparency: decor.stripeT },
    line: { color: theme.accent, transparency: 100 },
  })
}

function addSectionPanelGradient(slide, pptx, theme) {
  const bottom = mixHex(theme.panel, 'FFFFFF', themeKey(theme) === 'paper' ? 0.10 : 0.08)
  const mid = mixHex(theme.panel, bottom, 0.48)
  const bands = [
    { y: 0, h: 2.55, color: theme.panel },
    { y: 2.55, h: 2.45, color: mid },
    { y: 5.0, h: 2.5, color: bottom },
  ]
  bands.forEach((band) => {
    slide.addShape(shape(pptx, 'rect'), {
      x: 0, y: band.y, w: 5.6, h: band.h,
      fill: { color: band.color },
      line: { color: band.color, width: 0 },
    })
  })
}

function addCornerMark(slide, pptx, theme) {
  // 左上角的横线 brand 印记
  slide.addShape(shape(pptx, 'rect'), {
    x: 0.5, y: 0.42, w: 0.6, h: 0.04,
    fill: { color: theme.accent }, line: { color: theme.accent, width: 0 },
  })
}

export function addFooter(slide, pptx, theme, index, total, brand) {
  // 底部细线
  slide.addShape(shape(pptx, 'rect'), {
    x: 0.65, y: 6.97, w: 12.0, h: 0.012,
    fill: { color: theme.line, transparency: 35 },
    line: { color: theme.line, width: 0 },
  })
  // 左：品牌字
  slide.addText(brand, {
    x: 0.65, y: 7.03, w: 6.0, h: 0.28,
    fontFace: BODY_FONT, fontSize: 8, color: theme.muted, charSpace: 2, margin: 0,
  })
  // 右：页码 01 / 12
  slide.addText(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, {
    x: 11.0, y: 7.03, w: 1.65, h: 0.28,
    fontFace: BODY_FONT, fontSize: 9, color: theme.muted, align: 'right', margin: 0,
  })
}

function addPageTitle(slide, pptx, theme, titleText, { eyebrow } = {}) {
  if (eyebrow) {
    slide.addText(String(eyebrow).toUpperCase(), {
      x: 0.65, y: 0.85, w: 11.5, h: 0.28,
      fontFace: BODY_FONT, fontSize: 9, bold: true, color: theme.accent, charSpace: 3, margin: 0,
    })
  }
  slide.addText(titleText, {
    x: 0.65, y: 1.18, w: 11.5, h: 0.85,
    fontFace: HEAD_FONT, fontSize: 28, bold: true, color: theme.text, margin: 0, fit: 'shrink',
  })
  // 标题下方 hairline
  slide.addShape(shape(pptx, 'rect'), {
    x: 0.65, y: 2.10, w: 0.6, h: 0.04,
    fill: { color: theme.accent }, line: { color: theme.accent, width: 0 },
  })
}

/* ── 各 layout 渲染 ── */

export function renderCover(slide, pptx, theme, { deckTitle, subtitle, brand, generatedAt }) {
  paintBackground(slide, pptx, theme)
  addCoverBackdrop(slide, pptx, theme)
  // brand 与左侧 hairline 同行，形成定位锚
  slide.addShape(shape(pptx, 'rect'), {
    x: 0.85, y: 0.97, w: 0.30, h: 0.018,
    fill: { color: theme.accent }, line: { color: theme.accent, width: 0 },
  })
  slide.addText(String(brand || 'GUGO').toUpperCase(), {
    x: 1.30, y: 0.83, w: 8.0, h: 0.32,
    fontFace: BODY_FONT, fontSize: 9, bold: true, color: theme.accent, charSpace: 3.5, margin: 0,
  })
  // 主标题（占满，大）— 与 brand 距离 1.8in，给主角空间
  slide.addText(String(deckTitle), {
    x: 0.85, y: 2.75, w: 11.6, h: 2.2,
    fontFace: HEAD_FONT, fontSize: 56, bold: true, color: theme.text, margin: 0, fit: 'shrink',
  })
  // 副标题紧贴主标题底
  if (subtitle) {
    slide.addText(String(subtitle), {
      x: 0.85, y: 5.05, w: 11.0, h: 0.5,
      fontFace: BODY_FONT, fontSize: 18, color: theme.soft, margin: 0, fit: 'shrink',
    })
  }
  // 底部 日期 / accent — 形成成组
  slide.addShape(shape(pptx, 'rect'), {
    x: 0.85, y: 6.65, w: 0.6, h: 0.04,
    fill: { color: theme.accent }, line: { color: theme.accent, width: 0 },
  })
  const dateStr = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(generatedAt)
  slide.addText(dateStr, {
    x: 1.55, y: 6.55, w: 6.0, h: 0.3,
    fontFace: BODY_FONT, fontSize: 10, color: theme.muted, charSpace: 1.5, margin: 0,
  })
}

export function renderSection(slide, pptx, theme, { titleText, eyebrow, index, brand }) {
  paintBackground(slide, pptx, theme)
  // 左半 panel 用 3 段叠层模拟纵向 gradient，右半保持 bg。
  addSectionPanelGradient(slide, pptx, theme)
  // 章节号阴影：向右下偏移 1in，透明度 70，不压过正文。
  slide.addText(String(index).padStart(2, '0'), {
    x: 1.6, y: 3.4, w: 4.6, h: 3.2,
    fontFace: HEAD_FONT, fontSize: 220, bold: true, color: theme.text,
    transparency: 70, margin: 0, align: 'left', valign: 'top',
  })
  // 巨大的章节号（不再悬空，落在左 panel 中）
  slide.addText(String(index).padStart(2, '0'), {
    x: 0.6, y: 2.4, w: 4.6, h: 3.2,
    fontFace: HEAD_FONT, fontSize: 220, bold: true, color: theme.accent,
    margin: 0, align: 'left', valign: 'top',
  })
  // 左 panel 底部 brand
  slide.addText(String(brand || 'GUGO').toUpperCase(), {
    x: 0.6, y: 6.5, w: 4.6, h: 0.3,
    fontFace: BODY_FONT, fontSize: 8, bold: true, color: theme.muted, charSpace: 3, margin: 0,
  })
  // 右侧 eyebrow + 标题 紧密成组
  const eyebrowText = (eyebrow || `Chapter ${String(index).padStart(2, '0')}`).toUpperCase()
  slide.addText(eyebrowText, {
    x: 6.0, y: 3.30, w: 6.7, h: 0.32,
    fontFace: BODY_FONT, fontSize: 10, bold: true, color: theme.accent, charSpace: 3, margin: 0,
  })
  slide.addText(String(titleText), {
    x: 6.0, y: 3.65, w: 6.8, h: 1.4,
    fontFace: HEAD_FONT, fontSize: 36, bold: true, color: theme.text, margin: 0, fit: 'shrink',
  })
  // 装饰线紧贴标题底
  slide.addShape(shape(pptx, 'rect'), {
    x: 6.0, y: 5.15, w: 0.9, h: 0.045,
    fill: { color: theme.accent }, line: { color: theme.accent, width: 0 },
  })
  slide.addShape(shape(pptx, 'rect'), {
    x: 7.05, y: 5.17, w: 1.35, h: 0.014,
    fill: { color: theme.accentSoft, transparency: 42 },
    line: { color: theme.accentSoft, width: 0 },
  })
}

export function renderStatement(slide, pptx, theme, { titleText, bullets }) {
  paintBackground(slide, pptx, theme)
  // 装饰线放到大字正上方 0.6 in，与标题左对齐，形成视觉组
  slide.addShape(shape(pptx, 'rect'), {
    x: 1.0, y: 2.60, w: 1.2, h: 0.05,
    fill: { color: theme.accent }, line: { color: theme.accent, width: 0 },
  })
  // 大字结论
  slide.addText(String(titleText), {
    x: 1.0, y: 2.95, w: 11.3, h: 2.4,
    fontFace: HEAD_FONT, fontSize: 40, bold: true, color: theme.text,
    align: 'left', margin: 0, fit: 'shrink',
  })
  // sub 紧贴结论下方，同左边距
  const sub = bullets[0] || ''
  if (sub) {
    slide.addText(sub, {
      x: 1.0, y: 5.35, w: 11.3, h: 0.7,
      fontFace: BODY_FONT, fontSize: 18, color: theme.soft, margin: 0, fit: 'shrink',
    })
  }
}

export function renderBullets(slide, pptx, theme, { titleText, bullets, eyebrow }) {
  paintBackground(slide, pptx, theme)
  addCornerMark(slide, pptx, theme)
  addPageTitle(slide, pptx, theme, titleText, { eyebrow })
  if (!bullets.length) return
  // 每条 bullet 用横向 hairline 分隔 + 大号序号，远比 bullet 点高级
  const startY = 2.55
  const rowH = Math.min(0.95, (6.20 - startY) / bullets.length)
  bullets.forEach((b, idx) => {
    const y = startY + idx * rowH
    // 序号
    slide.addText(String(idx + 1).padStart(2, '0'), {
      x: 0.65, y, w: 0.7, h: rowH - 0.05,
      fontFace: HEAD_FONT, fontSize: 16, bold: true, color: theme.accent,
      margin: 0, valign: 'top',
    })
    // 正文
    slide.addText(b, {
      x: 1.40, y, w: 11.0, h: rowH - 0.05,
      fontFace: BODY_FONT, fontSize: 16, color: theme.soft,
      margin: 0, valign: 'top', fit: 'shrink',
    })
    // 分隔 hairline（最后一条不画）
    if (idx < bullets.length - 1) {
      slide.addShape(shape(pptx, 'rect'), {
        x: 0.65, y: y + rowH - 0.04, w: 12.0, h: 0.008,
        fill: { color: theme.line, transparency: 40 },
        line: { color: theme.line, width: 0 },
      })
    }
  })
}

export function renderSplit(slide, pptx, theme, { titleText, bullets, eyebrow }) {
  paintBackground(slide, pptx, theme)
  addCornerMark(slide, pptx, theme)
  addPageTitle(slide, pptx, theme, titleText, { eyebrow })
  const halves = [bullets[0] || '', bullets[1] || bullets[0] || '']
  const cols = [
    { x: 0.65, label: 'A', accent: theme.accent },
    { x: 6.85, label: 'B', accent: theme.accentSoft },
  ]
  // 中线 hairline 居页面中央（13.333 / 2 = 6.667）
  slide.addShape(shape(pptx, 'rect'), {
    x: 6.661, y: 2.65, w: 0.012, h: 3.75,
    fill: { color: theme.line, transparency: 35 },
    line: { color: theme.line, width: 0 },
  })
  cols.forEach((c, idx) => {
    // 大字母 marker — 与正文顶部对齐（同一 y）
    slide.addText(c.label, {
      x: c.x, y: 2.65, w: 0.9, h: 0.95,
      fontFace: HEAD_FONT, fontSize: 60, bold: true, color: c.accent,
      margin: 0, valign: 'top', align: 'left',
    })
    // 内容
    slide.addText(halves[idx], {
      x: c.x, y: 3.80, w: 5.85, h: 2.6,
      fontFace: BODY_FONT, fontSize: 18, color: theme.soft,
      margin: 0, valign: 'top', fit: 'shrink',
    })
  })
}

export function renderProcess(slide, pptx, theme, { titleText, bullets, eyebrow }) {
  paintBackground(slide, pptx, theme)
  addCornerMark(slide, pptx, theme)
  addPageTitle(slide, pptx, theme, titleText, { eyebrow })
  const n = bullets.length
  const totalW = 12.0
  const stepW = totalW / n
  const startX = 0.65
  bullets.forEach((b, idx) => {
    const x = startX + idx * stepW
    const stepText = (b || '').split(/[—\-:：]/, 2)
    const stepName = stepText[0]?.trim() || b
    const stepDesc = stepText[1]?.trim() || ''
    // 步骤号
    slide.addText(String(idx + 1).padStart(2, '0'), {
      x: x + 0.1, y: 2.65, w: 0.9, h: 0.45,
      fontFace: HEAD_FONT, fontSize: 22, bold: true, color: theme.accent, margin: 0,
    })
    // 步骤名
    slide.addText(stepName, {
      x: x + 0.1, y: 3.18, w: stepW - 0.3, h: 0.8,
      fontFace: HEAD_FONT, fontSize: 16, bold: true, color: theme.text, margin: 0, fit: 'shrink',
    })
    // 描述
    if (stepDesc) {
      slide.addText(stepDesc, {
        x: x + 0.1, y: 4.05, w: stepW - 0.3, h: 1.6,
        fontFace: BODY_FONT, fontSize: 12, color: theme.soft, margin: 0, valign: 'top', fit: 'shrink',
      })
    }
    // 步骤间箭头（最后一步不画）
    if (idx < n - 1) {
      slide.addShape(shape(pptx, 'rect'), {
        x: x + stepW - 0.18, y: 2.85, w: 0.14, h: 0.018,
        fill: { color: theme.accent, transparency: 25 },
        line: { color: theme.accent, width: 0 },
      })
    }
  })
}

export function renderKpi(slide, pptx, theme, { titleText, kpis, eyebrow }) {
  paintBackground(slide, pptx, theme)
  addCornerMark(slide, pptx, theme)
  addPageTitle(slide, pptx, theme, titleText, { eyebrow })
  const n = kpis.length
  const totalW = 12.0
  const cardW = totalW / n
  const startX = 0.65
  // 选最长 value 锁定字号 → 4 张卡 value 字号一致（不再 47% 大、¥4.7M 缩水）
  const valueLens = kpis.map((k) => k.value.length)
  const maxLen = Math.max(...valueLens, 1)
  const valueFont = maxLen <= 3 ? 56 : maxLen <= 5 ? 44 : maxLen <= 7 ? 34 : 28
  kpis.forEach((k, idx) => {
    const x = startX + idx * cardW
    // 卡片框（hairline）
    slide.addShape(shape(pptx, 'rect'), {
      x: x + 0.05, y: 2.85, w: cardW - 0.20, h: 3.6,
      fill: { color: theme.panel, transparency: 0 },
      line: { color: theme.line, width: 0.5, transparency: 30 },
    })
    // 顶部 accent bar（只在第 0 张完整，其余作为 muted 区分主次）
    slide.addShape(shape(pptx, 'rect'), {
      x: x + 0.05, y: 2.85, w: cardW - 0.20, h: 0.04,
      fill: { color: idx === 0 ? theme.accent : theme.accentSoft, transparency: idx === 0 ? 0 : 35 },
      line: { color: theme.bg, width: 0 },
    })
    // 大数字 — 锁定字号，所有卡一致
    slide.addText(k.value, {
      x: x + 0.25, y: 3.40, w: cardW - 0.45, h: 1.4,
      fontFace: HEAD_FONT, fontSize: valueFont, bold: true, color: theme.text,
      margin: 0, valign: 'top', align: 'left',
    })
    // 单位（紧跟在数字下，距离稳定）
    if (k.unit) {
      slide.addText(k.unit, {
        x: x + 0.25, y: 4.85, w: cardW - 0.45, h: 0.30,
        fontFace: BODY_FONT, fontSize: 10, color: theme.muted, charSpace: 1.5, margin: 0,
      })
    }
    // hairline 分隔 unit 与 label
    slide.addShape(shape(pptx, 'rect'), {
      x: x + 0.25, y: 5.25, w: 0.4, h: 0.012,
      fill: { color: theme.line, transparency: 30 },
      line: { color: theme.line, width: 0 },
    })
    // label
    slide.addText(k.label, {
      x: x + 0.25, y: 5.40, w: cardW - 0.45, h: 0.4,
      fontFace: BODY_FONT, fontSize: 12, color: theme.soft, margin: 0, fit: 'shrink',
    })
    // delta
    if (k.delta) {
      const positive = /^\+|增|涨|up/i.test(k.delta) || (!/^-/.test(k.delta) && /\d/.test(k.delta) && /增|up|positive/i.test(k.label))
      slide.addText(k.delta, {
        x: x + 0.25, y: 5.85, w: cardW - 0.45, h: 0.35,
        fontFace: BODY_FONT, fontSize: 11, bold: true,
        color: positive ? theme.accent : theme.accentSoft,
        margin: 0,
      })
    }
  })
}

export function renderChart(slide, pptx, theme, { titleText, chart, eyebrow }) {
  paintBackground(slide, pptx, theme)
  addCornerMark(slide, pptx, theme)
  addPageTitle(slide, pptx, theme, titleText, { eyebrow })

  const palette = [theme.accent, theme.accentSoft, theme.soft, theme.muted].map((c) => c)
  const ChartType = pptx.ChartType || {}
  const t =
    chart.type === 'line' ? (ChartType.line || 'line')
    : chart.type === 'pie' ? (ChartType.pie || 'pie')
    : (ChartType.bar || 'bar')

  let data
  if (chart.type === 'pie') {
    const first = chart.series[0]
    data = [{
      name: first.name || '占比',
      labels: chart.categories.length ? chart.categories : first.values.map((_, i) => `项${i + 1}`),
      values: first.values,
    }]
  } else {
    data = chart.series.map((s) => ({
      name: s.name || '系列',
      labels: chart.categories.length ? chart.categories : s.values.map((_, i) => String(i + 1)),
      values: s.values,
    }))
  }

  slide.addChart(t, data, {
    x: 0.65, y: 2.50, w: 12.0, h: 4.20,
    chartColors: palette.slice(0, Math.max(1, data.length)),
    showLegend: data.length > 1 || chart.type === 'pie',
    legendPos: 'b',
    legendFontFace: BODY_FONT,
    legendFontSize: 10,
    legendColor: theme.soft,
    catAxisLabelFontFace: BODY_FONT,
    catAxisLabelFontSize: 10,
    catAxisLabelColor: theme.soft,
    valAxisLabelFontFace: BODY_FONT,
    valAxisLabelFontSize: 10,
    valAxisLabelColor: theme.muted,
    dataLabelColor: theme.text,
    dataLabelFontFace: BODY_FONT,
    dataLabelFontSize: 10,
    showValue: chart.type === 'pie',
    barGapWidthPct: 60,
    barGrouping: chart.type === 'bar-stacked' ? 'stacked' : undefined,
    lineDataSymbol: chart.type === 'line' ? 'circle' : undefined,
    lineDataSymbolSize: chart.type === 'line' ? 6 : undefined,
    catGridLine: { style: 'none' },
    valGridLine: { color: theme.line, style: 'solid', size: 0.5 },
    plotArea: { fill: { color: theme.bg } },
  })
}

export function renderQuote(slide, pptx, theme, { titleText, quote }) {
  paintBackground(slide, pptx, theme)
  addCornerMark(slide, pptx, theme)
  // 引号符（巨大，淡）
  slide.addText('“', {
    x: 0.65, y: 0.7, w: 1.5, h: 2.0,
    fontFace: HEAD_FONT, fontSize: 160, color: theme.panel,
    margin: 0, valign: 'top',
  })
  const text = typeof quote === 'string' ? quote : (quote?.text || titleText)
  const source = typeof quote === 'object' ? (quote?.source || '') : ''
  slide.addText(String(text), {
    x: 1.6, y: 2.2, w: 10.7, h: 3.4,
    fontFace: HEAD_FONT, fontSize: 28, italic: true, color: theme.text,
    margin: 0, valign: 'top', fit: 'shrink',
  })
  if (source) {
    slide.addShape(shape(pptx, 'rect'), {
      x: 1.6, y: 5.80, w: 0.5, h: 0.04,
      fill: { color: theme.accent }, line: { color: theme.accent, width: 0 },
    })
    slide.addText(`— ${source}`, {
      x: 1.6, y: 5.95, w: 10.7, h: 0.4,
      fontFace: BODY_FONT, fontSize: 13, color: theme.soft, margin: 0,
    })
  }
}

export function renderEnd(slide, pptx, theme, { titleText, bullets, brand }) {
  paintBackground(slide, pptx, theme)
  slide.addText(String(titleText || 'Thank You'), {
    x: 0.85, y: 2.80, w: 11.6, h: 1.8,
    fontFace: HEAD_FONT, fontSize: 64, bold: true, color: theme.text,
    margin: 0, fit: 'shrink',
  })
  slide.addShape(shape(pptx, 'rect'), {
    x: 0.85, y: 4.75, w: 1.5, h: 0.05,
    fill: { color: theme.accent }, line: { color: theme.accent, width: 0 },
  })
  if (bullets[0]) {
    slide.addText(bullets[0], {
      x: 0.85, y: 4.95, w: 11.0, h: 0.6,
      fontFace: BODY_FONT, fontSize: 16, color: theme.soft, margin: 0, fit: 'shrink',
    })
  }
  slide.addText(String(brand || 'GUGO').toUpperCase(), {
    x: 0.85, y: 6.40, w: 6.0, h: 0.3,
    fontFace: BODY_FONT, fontSize: 9, bold: true, color: theme.accent, charSpace: 3.5, margin: 0,
  })
}

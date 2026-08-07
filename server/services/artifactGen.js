/**
 * G1: 服务端真实生成 PPT/Word/Excel — 模型 tool_call → 服务端 zip → 返回下载链接.
 *
 * Premium PPT pipeline (refactored):
 *   - 跨端安全字体（Calibri/Calibri Light）— 不再依赖 Aptos（仅 Win11 + 新版 Office 365 内置）
 *   - 内容感知 layout 选择（cover / section / kpi / statement / split / process / chart / bullets / end）
 *   - cover 用 deck title（而不是 slide[0].title）
 *   - bullets 自动截断长度，避免 fit:shrink 救到 7pt 不可读
 *   - 真实 chart 支持（pptxgenjs addChart：bar/line/pie），不再"高级 PPT 全是 bullet"
 *   - 真实 KPI 数据卡（结构化数字 + label + delta）
 *   - decor 的 transparency 数值修正语义（pptxgenjs 里 transparency=0 不透明、100 全透）
 *
 * MVP 范围:
 *   - create_pptx({ title, subtitle?, theme?, slides: [{ title, layout?, bullets?, kpi?, chart?, quote? ... }] })   → .pptx
 *   - create_docx({ title, paragraphs })                                                                            → .docx
 *   - create_xlsx({ title, sheets })                                                                                → .xlsx
 *
 * 不做(下一轮):图片嵌入 / 多 sheet 复杂样式 / 字体内嵌
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { authenticateRequest } from '../middleware.js'
import { getArtifactByFilename } from './jobStore.js'
import { getTurnArtifactByFilename } from './turnArtifactStore.js'
import {
  HEAD_FONT, BODY_FONT, CJK_FONT,
  PREMIUM_THEMES, resolvePremiumTheme,
  escapeXml, normalizeBullets, injectEaFont, shape,
} from '../../src/lib/pptCore.js'

const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR && path.isAbsolute(process.env.ARTIFACT_DIR)
    ? process.env.ARTIFACT_DIR
    : path.resolve(process.cwd(), process.env.ARTIFACT_DIR || '.artifacts')

function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  return ARTIFACT_DIR
}

const ARTIFACT_FALLBACK_NAMES = Object.freeze({
  pptx: 'presentation',
  docx: 'document',
  xlsx: 'spreadsheet',
  png: 'image',
  jpg: 'image',
  webp: 'image',
})

const FORBIDDEN_FILENAME_CHARACTERS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

function hasUnsafeFilenameCharacter(value) {
  return Array.from(String(value || '')).some((character) => {
    const code = character.codePointAt(0)
    return code <= 31 || code === 127 || FORBIDDEN_FILENAME_CHARACTERS.has(character)
  })
}

function replaceUnsafeFilenameCharacters(value) {
  return Array.from(String(value || ''), (character) => {
    const code = character.codePointAt(0)
    return code <= 31 || code === 127 || FORBIDDEN_FILENAME_CHARACTERS.has(character) ? ' ' : character
  }).join('')
}

function cleanArtifactTitle(title, ext) {
  const fallback = ARTIFACT_FALLBACK_NAMES[ext] || 'artifact'
  let value = String(title || fallback)
    .normalize('NFKC')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(?:tool[_ -]?call|create_(?:pptx|docx|xlsx))\b[\s\S]*$/i, ' ')
    .replace(new RegExp(`\\.${ext}$`, 'i'), '')
    .replace(/^(?:请|請|帮我|幫我|请帮我|請幫我|please\s+)?(?:生成|產生|创建|建立|制作|製作|导出|匯出|create|generate|export)(?:一份|一个|一個|a|an)?\s*/i, '')
    .replace(/^(?:基于|基於|根据|根據)(?:已获取的|已取得的|上述|以上)?\s*/i, '')
    .replace(/(?:现在|現在|并|並|然后|然後)?\s*(?:生成|產生|创建|建立|制作|製作|导出|匯出|create|generate|export)(?:一份|一个|一個)?\s*(?:PPTX?|Word|DOCX?|Excel|XLSX?|文档|文件|文檔|檔案|演示文稿|簡報|表格)?\s*$/i, '')
  value = replaceUnsafeFilenameCharacters(value)
    .replace(/[，。；：！？、,;:!]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '')

  value = Array.from(value || fallback).slice(0, 64).join('').replace(/[.\s_-]+$/g, '') || fallback
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `file-${value}`
  return value
}

export function buildArtifactFilename(title, extension) {
  const ext = String(extension || '').replace(/^\./, '').toLowerCase()
  if (!/^[a-z0-9]{1,12}$/.test(ext)) throw new Error('invalid artifact extension')
  return `${cleanArtifactTitle(title, ext)}.${ext}`
}

function artifactNameExists(filename) {
  if (fs.existsSync(path.join(ensureArtifactDir(), filename))) return true
  try {
    return !!(getArtifactByFilename(filename) || getTurnArtifactByFilename(filename))
  } catch {
    return false
  }
}

function newArtifactPath(title, ext) {
  ensureArtifactDir()
  const id = crypto.randomBytes(8).toString('hex')
  const preferred = buildArtifactFilename(title, ext)
  const parsed = path.parse(preferred)
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const filename = suffix === 1 ? preferred : `${parsed.name}-${suffix}${parsed.ext}`
    if (artifactNameExists(filename)) continue
    const fullPath = path.join(ARTIFACT_DIR, filename)
    try {
      const fd = fs.openSync(fullPath, 'wx')
      fs.closeSync(fd)
      return { id, filename, fullPath, url: `/api/artifacts/${encodeURIComponent(filename)}` }
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('could not allocate a unique artifact filename')
}

export function createImageArtifact({ title = 'generated-image', buffer, mimeType = 'image/png' } = {}) {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  const bytes = Buffer.from(buffer || [])
  if (!bytes.length) throw new Error('image buffer is empty')
  const artifactPath = newArtifactPath(title, extension)
  fs.writeFileSync(artifactPath.fullPath, bytes)
  return { ...artifactPath, type: 'image', title: String(title || 'generated-image').slice(0, 200) }
}


/* ════════════════════════ PPTX (premium) ════════════════════════ */
// fonts / themes / shape helper / normalizeBullets 均来自 src/lib/pptCore.js
const THEMES = PREMIUM_THEMES
const resolvePptxTheme = resolvePremiumTheme
const execFileAsync = promisify(execFile)

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

function addFooter(slide, pptx, theme, index, total, brand) {
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

function renderCover(slide, pptx, theme, { deckTitle, subtitle, brand }) {
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
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })
  slide.addText(dateStr, {
    x: 1.55, y: 6.55, w: 6.0, h: 0.3,
    fontFace: BODY_FONT, fontSize: 10, color: theme.muted, charSpace: 1.5, margin: 0,
  })
}

function renderSection(slide, pptx, theme, { titleText, eyebrow, index, brand }) {
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

function renderStatement(slide, pptx, theme, { titleText, bullets }) {
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

function renderBullets(slide, pptx, theme, { titleText, bullets, eyebrow }) {
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

function renderSplit(slide, pptx, theme, { titleText, bullets, eyebrow }) {
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

function renderProcess(slide, pptx, theme, { titleText, bullets, eyebrow }) {
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

function renderKpi(slide, pptx, theme, { titleText, kpis, eyebrow }) {
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

function renderChart(slide, pptx, theme, { titleText, chart, eyebrow }) {
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

function renderQuote(slide, pptx, theme, { titleText, quote }) {
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

function renderEnd(slide, pptx, theme, { titleText, bullets, brand }) {
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

/* ── 主入口 ── */

export async function createPptx({ title = 'Presentation', subtitle = '', theme: themeName, brand = 'Gugo', slides = [] } = {}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('slides 不能为空')
  }
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

  const explicit = themeName && THEMES[themeName]
  const theme = explicit || resolvePptxTheme(`${title} ${subtitle} ${slides.map((s) => s?.title || '').join(' ')}`)
  const total = slides.length

  let sectionCounter = 0

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i] || {}
    const slide = pptx.addSlide()
    const layout = pickLayout(s, i, total)
    const titleText = String(s.title || `Slide ${i + 1}`)
    const eyebrow = s.eyebrow
    const bullets = normalizeBullets(s)
    const kpis = normalizeKpis(s)
    const chart = normalizeChart(s)

    switch (layout) {
      case 'cover':
        renderCover(slide, pptx, theme, {
          deckTitle: title,
          subtitle: subtitle || s.subtitle || bullets[0] || '',
          brand,
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
  }

  let buffer = await pptx.write({ outputType: 'nodebuffer' })

  // 后处理 theme.xml 注入 east-asia 字体，保证 Win/Mac Office 中文字形一致
  const injected = await injectEaFont(buffer, CJK_FONT)
  buffer = Buffer.isBuffer(injected) ? injected : Buffer.from(injected)

  const a = newArtifactPath(title, 'pptx')
  fs.writeFileSync(a.fullPath, buffer)
  return { ...a, type: 'pptx', title, slideCount: slides.length, byteLength: buffer.length, themeName: explicit ? themeName : undefined }
}

/* ── 注入 east-asia 字体（让 CJK 渲染稳定） ──
 * 实现已下沉到 src/lib/pptCore.js#injectEaFont
 */

/* ────────────────────────── DOCX ────────────────────────── */

function buildDocxParagraphsXml(paragraphs) {
  // 接受 string 或 { heading?: 1|2|3, text }
  const out = []
  for (const p of paragraphs) {
    if (!p) continue
    const isObj = typeof p === 'object'
    const text = escapeXml(isObj ? (p.text || '') : String(p))
    const heading = isObj ? Number(p.heading) || 0 : 0
    if (heading >= 1 && heading <= 3) {
      out.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`,
      )
    } else {
      out.push(`<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    }
  }
  return out.join('')
}

export async function createDocx({ title = 'Document', paragraphs = [] } = {}) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    throw new Error('paragraphs 不能为空')
  }
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  )
  zip.folder('_rels').file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  )
  const word = zip.folder('word')
  word.folder('_rels').file(
    'document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  )
  // Normal style + Heading 1/2/3，并把 east-asia 字体绑死成 Microsoft YaHei
  word.file(
    'styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>
      <w:sz w:val="22"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:spacing w:before="280" w:after="140"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:spacing w:before="220" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:spacing w:before="180" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`,
  )
  // 标题作为第一段 H1
  const allParagraphs = [{ heading: 1, text: title }, ...paragraphs]
  word.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${buildDocxParagraphsXml(allParagraphs)}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`,
  )
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const a = newArtifactPath(title, 'docx')
  fs.writeFileSync(a.fullPath, buffer)
  return { ...a, type: 'docx', title, paragraphCount: paragraphs.length, byteLength: buffer.length }
}

/* ────────────────────────── XLSX ────────────────────────── */

function colLetter(i) {
  // 0 → A, 25 → Z, 26 → AA
  let n = i, s = ''
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}

function buildSheetXml(rows) {
  const lines = []
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || []
    const cells = []
    for (let c = 0; c < row.length; c++) {
      const ref = `${colLetter(c)}${r + 1}`
      const raw = row[c]
      if (raw == null || raw === '') continue
      // 数字直接 n,其他走 inlineStr
      if (typeof raw === 'number' || (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw))) {
        cells.push(`<c r="${ref}"><v>${raw}</v></c>`)
      } else {
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(raw)}</t></is></c>`)
      }
    }
    lines.push(`<row r="${r + 1}">${cells.join('')}</row>`)
  }
  return lines.join('')
}

export async function createXlsx({ title = 'Spreadsheet', sheets = [] } = {}) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('sheets 不能为空')
  }
  const validSheets = sheets
    .map((s, i) => ({
      name: String(s?.name || `Sheet${i + 1}`).slice(0, 31).replace(/[\\/?*[\]]/g, '_'),
      rows: Array.isArray(s?.rows) ? s.rows : [],
    }))
    .filter((s) => s.rows.length > 0)
  if (!validSheets.length) throw new Error('至少要有一个非空 sheet')

  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${validSheets.map((_, i) => `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
  )
  zip.folder('_rels').file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  )
  const xl = zip.folder('xl')
  xl.folder('_rels').file(
    'workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${validSheets.map((_, i) => `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`,
  )
  xl.file(
    'workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${validSheets.map((s, i) => `    <sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
  </sheets>
</workbook>`,
  )
  const ws = xl.folder('worksheets')
  validSheets.forEach((s, i) => {
    ws.file(
      `sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${buildSheetXml(s.rows)}</sheetData>
</worksheet>`,
    )
  })

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const a = newArtifactPath(title, 'xlsx')
  fs.writeFileSync(a.fullPath, buffer)
  const totalRows = validSheets.reduce((sum, s) => sum + s.rows.length, 0)
  return { ...a, type: 'xlsx', title, sheetCount: validSheets.length, rowCount: totalRows, byteLength: buffer.length }
}

/* ────────────────────────── 静态服务 ────────────────────────── */

function isSafeArtifactFilename(filename) {
  const value = String(filename || '')
  return value.length > 0 && value.length <= 240 &&
    value === path.basename(value) && value !== '.' && value !== '..' &&
    !hasUnsafeFilenameCharacter(value) &&
    /^\.[a-z0-9]{1,12}$/i.test(path.extname(value))
}

const ARTIFACT_CONTENT_TYPES = Object.freeze({
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  java: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8',
  ps1: 'text/plain; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  ogv: 'video/ogg',
})

function artifactContentType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase()
  return ARTIFACT_CONTENT_TYPES[ext] || 'application/octet-stream'
}

function artifactContentDisposition(kind, filename) {
  const ext = path.extname(filename)
  const asciiStem = path.basename(filename, ext)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]+/g, '-')
    .replace(/["\\;]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'artifact'
  const ascii = `${asciiStem}${ext.replace(/[^.a-z0-9]/gi, '')}`
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function parseArtifactRange(header, size) {
  const match = String(header || '').match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null
  let start = match[1] ? Number(match[1]) : null
  let end = match[2] ? Number(match[2]) : null
  if (start == null && end != null) {
    start = Math.max(0, size - end)
    end = size - 1
  } else {
    start = start ?? 0
    end = end == null ? size - 1 : Math.min(end, size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null
  return { start, end }
}

function withStatus(statusCode, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

async function findExecutable(names) {
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync('which', [name], { timeout: 3000 })
      const bin = stdout.trim().split(/\n+/)[0]
      if (bin) return bin
    } catch {
      // try next executable name
    }
  }
  return ''
}

function filenameFromArtifactPath(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw, 'http://localhost')
    if (url.pathname.startsWith('/api/artifacts/')) {
      return decodeURIComponent(path.basename(url.pathname))
    }
  } catch {
    // fall through to filename/path handling
  }
  if (isSafeArtifactFilename(raw) && path.extname(raw).toLowerCase() === '.pptx') return raw
  return ''
}

function resolvePreviewArtifactPath(input, userId) {
  const raw = String(input || '').trim()
  if (!raw) throw withStatus(400, 'artifactPath is required')

  const filename = filenameFromArtifactPath(raw)
  let full = filename ? path.join(ensureArtifactDir(), filename) : raw
  if (!path.isAbsolute(full)) throw withStatus(400, 'artifactPath must be a pptx artifact path or filename')
  if (path.extname(full).toLowerCase() !== '.pptx') throw withStatus(400, 'render-preview only supports pptx artifacts')

  const artifactDirReal = fs.realpathSync(ensureArtifactDir())
  try {
    full = fs.realpathSync(full)
  } catch {
    throw withStatus(404, 'artifact not found')
  }
  if (full !== artifactDirReal && !full.startsWith(artifactDirReal + path.sep)) {
    throw withStatus(400, 'artifactPath must be inside the artifact directory')
  }

  const dbArtifact = getArtifactByFilename(path.basename(full)) || getTurnArtifactByFilename(path.basename(full))
  if (dbArtifact?.userId && dbArtifact.userId !== userId) {
    throw withStatus(404, 'artifact not found')
  }
  return full
}

export async function getArtifactPreviewRendererStatus() {
  const libreOfficePath = await findExecutable(['libreoffice', 'soffice'])
  const pdftoppmPath = await findExecutable(['pdftoppm'])
  return {
    available: !!libreOfficePath,
    libreOfficePath,
    pdftoppmPath,
  }
}

export async function renderArtifactPreviewPng({ artifactPath, page = 1, userId = '' } = {}) {
  const status = await getArtifactPreviewRendererStatus()
  if (!status.libreOfficePath) {
    throw withStatus(503, 'LibreOffice is not installed; render-preview is unavailable')
  }
  if (!status.pdftoppmPath) {
    throw withStatus(503, 'pdftoppm is not installed; render-preview cannot extract a specific page')
  }

  const pageNo = Math.max(1, Math.floor(Number(page) || 1))
  const input = resolvePreviewArtifactPath(artifactPath, userId)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-preview-'))
  try {
    const profileDir = path.join(tmp, 'lo-profile')
    fs.mkdirSync(profileDir, { recursive: true })
    await execFileAsync(status.libreOfficePath, [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      tmp,
      input,
    ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })

    let pdfPath = path.join(tmp, `${path.basename(input, path.extname(input))}.pdf`)
    if (!fs.existsSync(pdfPath)) {
      const pdf = fs.readdirSync(tmp).find((name) => name.toLowerCase().endsWith('.pdf'))
      if (pdf) pdfPath = path.join(tmp, pdf)
    }
    if (!fs.existsSync(pdfPath)) throw withStatus(500, 'LibreOffice did not produce a PDF preview source')

    const outPrefix = path.join(tmp, 'page')
    await execFileAsync(status.pdftoppmPath, [
      '-f', String(pageNo),
      '-l', String(pageNo),
      '-singlefile',
      '-png',
      '-r', '144',
      pdfPath,
      outPrefix,
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })

    const pngPath = `${outPrefix}.png`
    if (!fs.existsSync(pngPath)) throw withStatus(404, `page ${pageNo} was not rendered`)
    const png = fs.readFileSync(pngPath)
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      page: pageNo,
      byteLength: png.length,
      renderer: 'libreoffice',
      libreOfficePath: status.libreOfficePath,
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export function handleArtifactDownload(req, res) {
  const url = req.url || ''
  const m = url.match(/^\/api\/artifacts\/([^?#]+)/)
  if (!m) { res.statusCode = 404; res.end('not found'); return }
  let filename = ''
  try { filename = decodeURIComponent(m[1]) } catch { /* rejected below */ }
  if (!isSafeArtifactFilename(filename)) { res.statusCode = 400; res.end('bad filename'); return }

  // 鉴权:Header 优先,query token 兜底(浏览器 <a> 下载没法带 Authorization 头)
  let userId = authenticateRequest(req)
  if (!userId) {
    const u = new URL(req.url, 'http://localhost')
    const queryToken = u.searchParams.get('token')
    if (queryToken) {
      req.headers.authorization = `Bearer ${queryToken}`
      userId = authenticateRequest(req)
    }
  }
  if (!userId) { res.statusCode = 401; res.end('Unauthorized'); return }

  // Ownership:artifact 的 user_id 必须匹配
  const artifact = getArtifactByFilename(filename) || getTurnArtifactByFilename(filename)
  if (!artifact) { res.statusCode = 404; res.end('not found'); return }
  if (artifact.userId !== userId) {
    // 不暴露存在性,统一 404
    res.statusCode = 404; res.end('not found'); return
  }

  ensureArtifactDir()
  let full = path.join(ARTIFACT_DIR, filename)
  // 防 path traversal (含 symlink)
  try {
    full = fs.realpathSync(full)
  } catch {
    res.statusCode = 404; res.end('not found'); return
  }
  if (!full.startsWith(fs.realpathSync(ARTIFACT_DIR) + path.sep)) { res.statusCode = 400; res.end('bad filename'); return }
  if (!fs.existsSync(full)) { res.statusCode = 404; res.end('not found'); return }
  const requestUrl = new URL(req.url, 'http://localhost')
  const preview = requestUrl.searchParams.get('preview') === '1'
  const contentType = artifactContentType(filename)
  const size = fs.statSync(full).size
  const requestedRange = req.headers.range
  const range = requestedRange ? parseArtifactRange(requestedRange, size) : null
  if (requestedRange && !range) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
    res.end()
    return
  }
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': artifactContentDisposition(preview ? 'inline' : 'attachment', filename),
    'Content-Length': range ? range.end - range.start + 1 : size,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
  if (preview && contentType === 'application/pdf') headers['X-Frame-Options'] = 'SAMEORIGIN'
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
  if (preview && /^text\/html/i.test(contentType)) {
    headers['Content-Security-Policy'] = "sandbox allow-scripts allow-forms; default-src 'none'; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; style-src 'unsafe-inline' https:; font-src data: https:; script-src 'unsafe-inline' https:"
  } else if (preview && /^image\/svg\+xml/i.test(contentType)) {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
  }
  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  const stream = fs.createReadStream(full, range || undefined)
  stream.on('error', (err) => {
    console.error('[artifactGen] read stream error:', err?.message)
    if (!res.headersSent) {
      res.statusCode = 500; res.end('read error')
    }
  })
  stream.pipe(res)
}

export function getArtifactDir() {
  return ARTIFACT_DIR
}

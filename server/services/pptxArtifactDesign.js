import { BODY_FONT, CJK_FONT, HEAD_FONT, PREMIUM_THEMES, escapeXml } from '../../src/lib/pptCore.js'
import { PPTX_DESIGN_SCHEMA } from './pptxArtifactContract.js'
import { assertPptxSchema, invalidPptx, pptxColor } from './pptxArtifactValidation.js'

const DIMENSIONS = Object.freeze({
  '16:9': [40 / 3, 7.5],
  '4:3': [10, 7.5],
  '16:10': [12, 7.5],
  '1:1': [10, 10],
  '9:16': [7.5, 40 / 3],
})

function isDark(color) {
  const rgb = color.match(/../gu).map((value) => Number.parseInt(value, 16) / 255)
  return (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) < 0.5
}

export function resolvePptxDesign({ design, theme: themeName }) {
  if (design !== undefined) assertPptxSchema(design, PPTX_DESIGN_SCHEMA, 'design')
  const input = design || {}
  if ((input.width === undefined) !== (input.height === undefined)) {
    invalidPptx('design', 'must supply width and height together')
  }
  const dimensions = DIMENSIONS[input.aspect_ratio || '16:9']
  const explicitTheme = Object.hasOwn(PREMIUM_THEMES, themeName) ? PREMIUM_THEMES[themeName] : null
  const base = explicitTheme || {
    bg: 'FFFFFF', text: '172033', accent: '2563EB', accentSoft: '0F766E',
    soft: '475569', muted: '64748B', panel: 'F1F5F9', line: 'CBD5E1',
  }
  const bg = pptxColor(input.background) || base.bg
  const text = pptxColor(input.foreground) || (input.background ? (isDark(bg) ? 'F8FAFC' : '172033') : base.text)
  const muted = pptxColor(input.muted) || (isDark(bg) ? 'CBD5E1' : '475569')
  const headingFont = input.heading_font || HEAD_FONT
  const bodyFont = input.body_font || BODY_FONT
  return {
    width: input.width ?? dimensions[0],
    height: input.height ?? dimensions[1],
    headingFont,
    bodyFont,
    eastAsianFont: input.east_asian_font || input.body_font || CJK_FONT,
    headingEastAsianFont: input.east_asian_font || input.heading_font || CJK_FONT,
    headingSize: input.heading_font_size || 32,
    bodySize: input.body_font_size || 18,
    headingSizeExplicit: input.heading_font_size !== undefined,
    bodySizeExplicit: input.body_font_size !== undefined,
    showPageNumbers: input.show_page_numbers === true,
    showBrand: input.show_brand === true,
    showDate: input.show_date === true,
    theme: {
      ...base, bg, text, soft: muted, muted,
      accent: pptxColor(input.accent) || base.accent,
      accentSoft: pptxColor(input.secondary) || base.accentSoft,
      panel: input.background ? bg : base.panel,
      line: pptxColor(input.muted) || base.line,
    },
    themeName: explicitTheme ? themeName : undefined,
  }
}

export function slidePptxDesign(design, slide, path) {
  if (slide.background === undefined) return design
  assertPptxSchema(slide.background, PPTX_DESIGN_SCHEMA.properties.background, `${path}.background`)
  return { ...design, theme: { ...design.theme, bg: pptxColor(slide.background) } }
}

export function applyPptxRunFonts(xml, design) {
  const faces = new Map([
    [escapeXml(design.bodyFont), escapeXml(design.eastAsianFont)],
    [escapeXml(design.headingFont), escapeXml(design.headingEastAsianFont)],
  ])
  return xml.replace(/<a:(rPr|defRPr)\b[^>]*>[\s\S]*?<\/a:\1>/gu, (run) => {
    const latin = run.match(/<a:latin\b[^>]*typeface="([^"]*)"/u)?.[1]
    const eastAsian = faces.get(latin)
    if (!eastAsian) return run
    return run.replace(/(<a:ea\b[^>]*typeface=")[^"]*(")/gu,
      (_match, prefix, suffix) => prefix + eastAsian + suffix)
  })
}

function characterWidth(character) {
  if (/\s/u.test(character)) return 0.3
  if (/[ilI1.,'!|:;]/u.test(character)) return 0.3
  if (/[MW@#%&]/u.test(character)) return 0.9
  return character.codePointAt(0) > 0x2FF ? 1 : 0.6
}

function estimatedTextLines(text, width, fontSize) {
  const capacity = width * 72 / fontSize * 0.92
  if (capacity <= 0) return Infinity
  return text.split(/\r?\n/u).reduce((lines, line) => {
    const length = Array.from(line).reduce((sum, character) => sum + characterWidth(character), 0)
    return lines + Math.max(1, Math.ceil(length / capacity))
  }, 0)
}

export function fittingPptxFont(text, { w, h }, requestedSize, path, { minimum = 12, allowShrink = true } = {}) {
  const lowerBound = allowShrink ? Math.min(requestedSize, minimum) : requestedSize
  for (let size = requestedSize; ; size = Math.max(lowerBound, size - 1)) {
    if (estimatedTextLines(text, w, size) * size / 72 * 1.3 <= h) return size
    if (size === lowerBound) break
  }
  invalidPptx(path, 'does not fit its text box without unreadable text; enlarge the box, use a more suitable layout, or split the content', 'PPTX_CONTENT_OVERFLOW')
}

export function addPptxText(slide, text, box, design, options = {}, path = 'slide.text') {
  if (!text) return
  const { strictFontSize = design.bodySizeExplicit, ...nativeOptions } = options
  const requestedSize = options.fontSize || design.bodySize
  const fontSize = fittingPptxFont(text, box, requestedSize, path, { allowShrink: !strictFontSize })
  slide.addText(text, {
    ...box,
    margin: 0,
    fontFace: design.bodyFont,
    color: design.theme.text,
    valign: 'top',
    breakLine: false,
    paraSpaceAfterPt: 0,
    ...nativeOptions,
    fontSize,
  })
}

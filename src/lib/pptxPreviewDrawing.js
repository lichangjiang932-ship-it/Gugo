import { emu, pptxColor, pptxColorData, pptxSolidFill, xmlChild, xmlChildren, xmlDescendants, xmlNumber } from './pptxPreviewXml.js'
import { PPTX_SHADOW_FILTER_LIMITS, pptxShadowFilterRegion } from './pptxPreviewShadow.js'

const SHAPES = new Set(['rect', 'roundRect', 'ellipse', 'line', 'triangle', 'rtTriangle', 'diamond'])
const FILL_NAMES = new Set(['solidFill', 'noFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])
const hasFill = (node) => xmlChildren(node).some((child) => FILL_NAMES.has(child.localName))

export function transformBox(node) {
  const offset = xmlChild(node, 'off')
  const extent = xmlChild(node, 'ext')
  if (!offset || !extent) throw new Error('Inherited PPTX positioning is not supported')
  const box = {
    x: emu(xmlNumber(offset, 'x')), y: emu(xmlNumber(offset, 'y')),
    w: emu(xmlNumber(extent, 'cx')), h: emu(xmlNumber(extent, 'cy')),
    rotation: xmlNumber(node, 'rot') / 60000,
    flipH: ['1', 'true'].includes(node.getAttribute('flipH')),
    flipV: ['1', 'true'].includes(node.getAttribute('flipV')),
  }
  if (box.w < 0 || box.h < 0 || Math.max(box.w, box.h, Math.abs(box.x), Math.abs(box.y)) > 32768) {
    throw new Error('Invalid PPTX drawing bounds')
  }
  return box
}

export function assertDrawingSupported(properties) {
  for (const node of xmlChildren(properties)) {
    if (['xfrm', 'prstGeom', 'solidFill', 'noFill', 'ln', 'effectLst'].includes(node.localName)) continue
    throw new Error(`Unsupported PPTX drawing: ${node.localName}`)
  }
}

export function geometry(properties) {
  const preset = xmlChild(properties, 'prstGeom')
  const shape = preset?.getAttribute('prst') || 'rect'
  if (!SHAPES.has(shape)) throw new Error(`Unsupported PPTX shape: ${shape}`)
  const adjustments = xmlDescendants(preset, 'gd')
  let rounding = 1 / 6
  for (const adjustment of adjustments) {
    const value = adjustment.getAttribute('fmla')?.match(/^val (\d+)$/)
    if (shape !== 'roundRect' || adjustment.getAttribute('name') !== 'adj' || !value) {
      throw new Error('Unsupported PPTX shape adjustment')
    }
    rounding = Math.min(0.5, Number(value[1]) / 100000)
  }
  return { shape, rounding }
}

function styleReference(style, name, theme, listName) {
  const reference = xmlChild(style, name)
  if (!reference) return { node: null, placeholder: null }
  const index = xmlNumber(reference, 'idx', -1)
  if (!Number.isInteger(index) || index < 0) throw new Error('Invalid PPTX style reference')
  if (index === 0) return { node: null, placeholder: null }
  const list = xmlDescendants(theme.xml, listName)[0]
  const node = xmlChildren(list)[index - 1]
  if (!node) throw new Error('Missing PPTX theme style')
  return { node, placeholder: pptxColorData(reference, theme) }
}

export function pptxStyleFont(style, theme) {
  const reference = xmlChild(style, 'fontRef')
  if (!reference) return {}
  const index = reference.getAttribute('idx')
  if (!['major', 'minor', 'none'].includes(index)) throw new Error('Unsupported PPTX font style reference')
  const fontFamily = index === 'major' ? theme.majorFont : index === 'minor' ? theme.minorFont : ''
  const color = pptxColor(reference, theme)
  return { ...(fontFamily ? { fontFamily } : {}), ...(color ? { color } : {}) }
}

export function lineStyle(properties, theme, inherited = null, placeholder = null, directLine = false) {
  const line = directLine ? properties : xmlChild(properties, 'ln')
  const attribute = (name, fallback = '') => line?.hasAttribute(name) ? line.getAttribute(name) : inherited?.getAttribute(name) || fallback
  const child = (name) => xmlChild(line, name) || xmlChild(inherited, name)
  for (const node of [line, inherited].filter(Boolean)) {
    if (xmlChildren(node).some((item) => ![...FILL_NAMES, 'prstDash', 'round', 'bevel', 'miter', 'headEnd', 'tailEnd'].includes(item.localName))) {
      throw new Error('Unsupported PPTX line effect')
    }
  }
  if (attribute('cmpd', 'sng') !== 'sng' || attribute('algn', 'ctr') !== 'ctr') throw new Error('Unsupported PPTX compound line')
  const dash = child('prstDash')?.getAttribute('val')
  if (dash && dash !== 'solid') throw new Error('Unsupported PPTX line dash')
  if (['headEnd', 'tailEnd'].some((name) => !['none', null, undefined].includes(child(name)?.getAttribute('type')))) {
    throw new Error('Unsupported PPTX arrow')
  }
  const widthNode = line?.hasAttribute('w') ? line : inherited
  const strokeWidth = emu(xmlNumber(widthNode, 'w', 12700))
  if (strokeWidth < 0 || strokeWidth > 2048) throw new Error('PPTX line exceeds the preview limit')
  const cap = attribute('cap', 'flat')
  if (!['flat', 'rnd', 'sq'].includes(cap)) throw new Error('Unsupported PPTX line cap')
  const join = xmlChildren(line).find((node) => ['round', 'bevel', 'miter'].includes(node.localName))
    || xmlChildren(inherited).find((node) => ['round', 'bevel', 'miter'].includes(node.localName))
  const fillNode = hasFill(line) ? line : inherited
  return { stroke: pptxSolidFill(fillNode, theme, 'none', hasFill(line) ? null : placeholder), strokeWidth,
    strokeLinecap: { flat: 'butt', rnd: 'round', sq: 'square' }[cap],
    ...(join ? { strokeLinejoin: join.localName } : {}) }
}

function outerShadow(effect, theme, placeholder, box, budget) {
  if (xmlChildren(effect).some((node) => !['srgbClr', 'schemeClr', 'sysClr'].includes(node.localName))
    || xmlNumber(effect, 'sx', 100000) !== 100000 || xmlNumber(effect, 'sy', 100000) !== 100000
    || xmlNumber(effect, 'kx') || xmlNumber(effect, 'ky')) throw new Error('Unsupported PPTX shadow transform')
  const blur = emu(xmlNumber(effect, 'blurRad')) / 2
  const distance = emu(xmlNumber(effect, 'dist'))
  if (blur < 0 || blur > 64 || distance < 0 || distance > 2048) throw new Error('PPTX shadow exceeds the preview limit')
  const angle = xmlNumber(effect, 'dir') / 60000 * Math.PI / 180
  let dx = distance * Math.cos(angle)
  let dy = distance * Math.sin(angle)
  if (['0', 'false'].includes(effect.getAttribute('rotWithShape'))) {
    const rotation = box.rotation * Math.PI / 180
    const localX = Math.cos(rotation) * dx + Math.sin(rotation) * dy
    const localY = -Math.sin(rotation) * dx + Math.cos(rotation) * dy
    dx = box.flipH ? -localX : localX
    dy = box.flipV ? -localY : localY
  }
  const color = pptxColor(effect, theme, null, placeholder)
  if (!color) throw new Error('Missing PPTX shadow color')
  const shadow = { dx: Math.abs(dx) < 1e-12 ? 0 : dx, dy: Math.abs(dy) < 1e-12 ? 0 : dy, blur, color }
  const region = pptxShadowFilterRegion({ ...box, shadow })
  const pixels = region.width * region.height
  if (budget && (!Number.isFinite(budget.pixels) || budget.pixels < 0
    || budget.pixels + pixels > PPTX_SHADOW_FILTER_LIMITS.totalPixels)) throw new Error('PPTX shadow area exceeds the preview limit')
  if (budget) budget.pixels += pixels
  return shadow
}

function drawingShadow(properties, style, theme, box, budget) {
  const inherited = styleReference(style, 'effectRef', theme, 'effectStyleLst')
  if (xmlChildren(inherited.node).some((node) => node.localName !== 'effectLst')) throw new Error('Unsupported PPTX theme 3D effect')
  const list = xmlChild(properties, 'effectLst') || xmlChild(inherited.node, 'effectLst')
  const effects = xmlChildren(list)
  if (!effects.length) return null
  if (effects.length !== 1 || effects[0].localName !== 'outerShdw') throw new Error('Unsupported PPTX drawing effect')
  return outerShadow(effects[0], theme, inherited.placeholder, box, budget)
}

/** Resolve only properties that are actually inherited; explicit noFill/paint wins. */
export function pptxDrawingPaint(properties, style, theme, box, effectBudget) {
  if (xmlChildren(style).some((node) => !['lnRef', 'fillRef', 'effectRef', 'fontRef'].includes(node.localName))) {
    throw new Error('Unsupported PPTX shape style')
  }
  let fill
  if (hasFill(properties)) fill = pptxSolidFill(properties, theme)
  else {
    const inherited = styleReference(style, 'fillRef', theme, 'fillStyleLst')
    if (!inherited.node) fill = 'none'
    else if (inherited.node.localName === 'noFill') fill = 'none'
    else if (inherited.node.localName === 'solidFill') fill = pptxColor(inherited.node, theme, 'none', inherited.placeholder)
    else throw new Error('Unsupported PPTX inherited fill')
  }
  const inheritedLine = styleReference(style, 'lnRef', theme, 'lnStyleLst')
  const line = lineStyle(properties, theme, inheritedLine.node, inheritedLine.placeholder)
  const shadow = drawingShadow(properties, style, theme, { ...box, ...line }, effectBudget)
  return { fill, ...line, ...(shadow ? { shadow } : {}) }
}

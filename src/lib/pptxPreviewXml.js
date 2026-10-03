// A deliberately small OOXML reader. Unsupported drawing features must fail
// closed to an explicitly labelled outline, never to a replacement template.
import { PPTX_PREVIEW_BYTE_LIMITS, readPptxXmlText } from './pptxPreviewArchive.js'

export const PPTX_XML_NS = Object.freeze({
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  relationships: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
})

export function xmlChildren(node, name = '') {
  return Array.from(node?.children || []).filter((child) => !name || child.localName === name)
}

export function xmlChild(node, name) {
  return xmlChildren(node, name)[0] || null
}

export function xmlDescendants(node, name) {
  return Array.from(node?.getElementsByTagNameNS?.('*', name) || [])
}

export function xmlNumber(node, name, fallback = 0) {
  if (!node?.hasAttribute(name)) return fallback
  const value = Number(node.getAttribute(name))
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('Invalid PPTX drawing number')
  return value
}

export function emu(value) { return value / 9525 }

export function relationshipTarget(part, target) {
  // Embedded parts only: never fetch a URL or interpret package paths as host
  // paths. JSZip also normalizes traversal names; do not use its unsafe name.
  if (!target || /[\\?#]/.test(target) || Array.from(target).some((char) => char.charCodeAt(0) < 32)
    || /^[a-z][a-z\d+.-]*:/i.test(target)) return ''
  const segments = target.startsWith('/') ? [] : part.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return ''
      segments.pop()
    } else segments.push(segment)
  }
  return segments.join('/')
}

export function createPptxXmlReader(zip, Parser) {
  const cache = new Map()
  const budget = { bytes: 0, limit: PPTX_PREVIEW_BYTE_LIMITS.xmlTotal }
  return async (name) => {
    if (!name || !zip.file(name)) return null
    if (cache.has(name)) return cache.get(name)
    const text = await readPptxXmlText(zip.file(name), budget)
    const document = new Parser().parseFromString(text, 'application/xml')
    if (xmlDescendants(document, 'parsererror').length) throw new Error('Invalid PPTX XML')
    cache.set(name, document)
    return document
  }
}

export async function readPptxRelationships(readXml, part) {
  const segments = part.split('/')
  const filename = segments.pop()
  const xml = await readXml([...segments, '_rels', `${filename}.rels`].join('/'))
  return new Map(xmlDescendants(xml, 'Relationship').map((node) => [node.getAttribute('Id'), {
    type: node.getAttribute('Type')?.split('/').at(-1),
    target: node.getAttribute('TargetMode') === 'External' ? '' : relationshipTarget(part, node.getAttribute('Target')),
  }]))
}

export async function relatedPptxPart(readXml, part, type) {
  const relationships = await readPptxRelationships(readXml, part)
  const relation = [...relationships.values()].find((item) => item.type === type)
  if (relation && !relation.target) throw new Error('External or invalid PPTX part relationship')
  const target = relation?.target || ''
  const xml = await readXml(target)
  if (target && !xml) throw new Error('Referenced PPTX part is missing')
  return { path: target, xml, relationships }
}

function baseColor(node, theme, placeholder) {
  if (node?.localName === 'srgbClr') return node.getAttribute('val')
  if (node?.localName === 'sysClr') return node.getAttribute('lastClr')
  if (node?.localName === 'schemeClr') {
    const key = node.getAttribute('val')
    if (key === 'phClr') return placeholder
    return theme.colors[theme.mapping[key] || key]
  }
  return null
}

export function pptxColorData(container, theme, fallback = null, placeholder = '') {
  const node = xmlChildren(container).find((child) => /^(?:srgbClr|schemeClr|sysClr)$/.test(child.localName))
  if (!node) return fallback
  const hex = baseColor(node, theme, placeholder)
  const inherited = hex && typeof hex === 'object' && Array.isArray(hex.channels)
  if (!inherited && !/^[\da-f]{6}$/i.test(hex || '')) throw new Error('Unsupported PPTX color')
  let channels = inherited ? [...hex.channels] : [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16))
  let alpha = inherited ? hex.alpha : 1
  for (const transform of xmlChildren(node)) {
    const fraction = xmlNumber(transform, 'val') / 100000
    if (transform.localName === 'alpha') alpha = fraction
    // DrawingML tint retains val% of the input; zero is white, not unchanged.
    else if (transform.localName === 'tint') channels = channels.map((value) => value * fraction + 255 * (1 - fraction))
    else if (transform.localName === 'shade') channels = channels.map((value) => value * fraction)
    else throw new Error('Unsupported PPTX color effect')
  }
  return { channels, alpha }
}

export function pptxColor(container, theme, fallback = null, placeholder = '') {
  const color = pptxColorData(container, theme, null, placeholder)
  if (!color) return fallback
  return `rgba(${color.channels.map((value) => Math.round(Math.max(0, Math.min(255, value)))).join(',')},${Math.max(0, Math.min(1, color.alpha))})`
}

export function pptxSolidFill(properties, theme, fallback = 'none', placeholder = '') {
  if (xmlChild(properties, 'noFill')) return 'none'
  if (xmlChildren(properties).some((node) => ['gradFill', 'blipFill', 'pattFill', 'grpFill'].includes(node.localName))) {
    throw new Error('Unsupported PPTX fill')
  }
  return pptxColor(xmlChild(properties, 'solidFill'), theme, fallback, placeholder)
}

export function readPptxTheme(themeXml, masterXml, layoutXml, slideXml) {
  const scheme = xmlDescendants(themeXml, 'clrScheme')[0]
  const colors = Object.fromEntries(xmlChildren(scheme).map((node) => [
    node.localName, xmlChild(node, 'srgbClr')?.getAttribute('val') || xmlChild(node, 'sysClr')?.getAttribute('lastClr'),
  ]))
  const mapping = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }
  for (const xml of [masterXml, layoutXml, slideXml]) {
    const map = xmlDescendants(xml, 'overrideClrMapping')[0] || xmlDescendants(xml, 'clrMap')[0]
    for (const attribute of Array.from(map?.attributes || [])) mapping[attribute.localName] = attribute.value
  }
  const font = (name) => xmlChild(xmlDescendants(themeXml, name)[0], 'latin')?.getAttribute('typeface') || ''
  return { colors, mapping, majorFont: font('majorFont'), minorFont: font('minorFont'), xml: themeXml }
}

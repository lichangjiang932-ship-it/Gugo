import {
  PPTX_XML_NS, createPptxXmlReader, emu, pptxColor, pptxSolidFill, readPptxRelationships,
  readPptxTheme, relatedPptxPart, xmlChild, xmlChildren, xmlDescendants, xmlNumber,
} from './pptxPreviewXml.js'
import { PPTX_PREVIEW_BYTE_LIMITS, readPptxZipPart } from './pptxPreviewArchive.js'
import { inspectPptxRasterImage } from './pptxPreviewRaster.js'
import { parsePptxText as parseText } from './pptxPreviewText.js'
import { assertDrawingSupported, geometry, pptxDrawingPaint, pptxStyleFont, transformBox } from './pptxPreviewDrawing.js'
import { parsePptxTable } from './pptxPreviewTable.js'

const MAX_SLIDES = 200
const MAX_ELEMENTS = 500

export function assertPptxPreviewPackage(zip) {
  const entries = Object.values(zip.files)
  if (entries.length > 10000 || entries.reduce((size, file) => size + (file._data?.uncompressedSize || 0), 0) > 128 * 1024 * 1024) {
    throw new Error('PPTX package exceeds the preview limit')
  }
}

function parseShape(node, context) {
  if (xmlDescendants(node, 'ph').length) throw new Error('Unsupported PPTX placeholder')
  const properties = xmlChild(node, 'spPr')
  const style = xmlChild(node, 'style')
  assertDrawingSupported(properties)
  const box = transformBox(xmlChild(properties, 'xfrm'))
  const outline = geometry(properties)
  const text = parseText(xmlChild(node, 'txBody'), { ...context, fontStyle: pptxStyleFont(style, context.theme) })
  if (text && (outline.shape !== 'rect' || box.flipH || box.flipV)) throw new Error('Unsupported PPTX shape text geometry')
  return {
    kind: 'shape', ...box, ...outline,
    ...pptxDrawingPaint(properties, style, context.theme, box, context.effectBudget),
    text,
  }
}

async function embeddedImage(blipFill, context) {
  const blip = xmlChild(blipFill, 'blip')
  const id = blip?.getAttributeNS(PPTX_XML_NS.relationships, 'embed')
  const relation = context.relationships.get(id)
  if (!relation?.target || relation.type !== 'image' || blip?.getAttributeNS(PPTX_XML_NS.relationships, 'link')) {
    throw new Error('External PPTX images are not supported')
  }
  if (xmlChildren(blip).some((node) => node.localName !== 'alphaModFix') || xmlChild(blipFill, 'tile')) {
    throw new Error('Unsupported PPTX image effect')
  }
  if (!context.images.has(relation.target)) {
    const entry = context.zip.file(relation.target)
    const bytes = await readPptxZipPart(entry, { limit: PPTX_PREVIEW_BYTE_LIMITS.imagePart, budget: context.imageBudget, label: 'image' })
    const { mime } = inspectPptxRasterImage(bytes, context.imageBudget)
    const chunks = []
    for (let index = 0; index < bytes.length; index += 8192) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)))
    context.images.set(relation.target, `data:${mime};base64,${btoa(chunks.join(''))}`)
  }
  const cropNode = xmlChild(blipFill, 'srcRect')
  const crop = Object.fromEntries(['l', 'r', 't', 'b'].map((name) => [name, xmlNumber(cropNode, name) / 100000]))
  if (Object.values(crop).some((value) => value < 0 || value >= 1) || crop.l + crop.r > 0.99 || crop.t + crop.b > 0.99) {
    throw new Error('Unsupported PPTX image crop')
  }
  return { src: context.images.get(relation.target), crop,
    opacity: xmlNumber(xmlChild(blip, 'alphaModFix'), 'amt', 100000) / 100000 }
}

async function parseImage(node, context) {
  const properties = xmlChild(node, 'spPr')
  assertDrawingSupported(properties)
  if (geometry(properties).shape !== 'rect' || xmlDescendants(node, 'videoFile').length || xmlDescendants(node, 'audioFile').length) {
    throw new Error('Unsupported PPTX image shape or media')
  }
  const box = transformBox(xmlChild(properties, 'xfrm'))
  return { kind: 'image', ...box, ...pptxDrawingPaint(properties, xmlChild(node, 'style'), context.theme, box, context.effectBudget),
    ...(await embeddedImage(xmlChild(node, 'blipFill'), context)),
    alt: xmlDescendants(node, 'cNvPr')[0]?.getAttribute('descr') || '' }
}

function backgroundFill(xml, theme) {
  const background = xmlChild(xmlChild(xml?.documentElement, 'cSld'), 'bg')
  if (!background) return null
  const properties = xmlChild(background, 'bgPr')
  if (properties) return pptxSolidFill(properties, theme, 'white')
  const reference = xmlChild(background, 'bgRef')
  if (!reference) throw new Error('Unsupported PPTX background')
  const index = xmlNumber(reference, 'idx')
  const list = xmlDescendants(theme.xml, index >= 1001 ? 'bgFillStyleLst' : 'fillStyleLst')[0]
  const fill = xmlChildren(list)[index >= 1001 ? index - 1001 : index - 1]
  if (fill?.localName !== 'solidFill') throw new Error('Unsupported PPTX theme background')
  const color = xmlChildren(fill)[0]
  if (color?.localName === 'schemeClr' && color.getAttribute('val') === 'phClr' && !xmlChildren(color).length) {
    return pptxColor(reference, theme, 'white')
  }
  return pptxColor(fill, theme, 'white')
}

async function parseShapeTree(xml, context, inherited = false) {
  const tree = xmlChild(xmlChild(xml?.documentElement, 'cSld'), 'spTree')
  if (!tree) return []
  const group = xmlChild(xmlChild(tree, 'grpSpPr'), 'xfrm')
  if (group && (xmlNumber(group, 'rot') || ['flipH', 'flipV'].some((name) => ['1', 'true'].includes(group.getAttribute(name)))
    || xmlChildren(group).some((node) => Array.from(node.attributes).some((attribute) => Number(attribute.value) !== 0)))) {
    throw new Error('Unsupported PPTX group transform')
  }
  const elements = []
  for (const node of xmlChildren(tree)) {
    if (['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(node.localName)) continue
    if (inherited && xmlDescendants(node, 'ph').length) continue
    if (xmlDescendants(node, 'cNvPr')[0]?.getAttribute('hidden') === '1') continue
    if (context.elementBudget.count >= MAX_ELEMENTS) throw new Error('PPTX slide exceeds the preview limit')
    let added
    if (node.localName === 'sp' || node.localName === 'cxnSp') added = [parseShape(node, context)]
    else if (node.localName === 'pic') added = [await parseImage(node, context)]
    else if (node.localName === 'graphicFrame') added = await parsePptxTable(node, context, MAX_ELEMENTS - context.elementBudget.count)
    else throw new Error(`Unsupported PPTX content: ${node.localName}`)
    context.elementBudget.count += added.length
    elements.push(...added)
    if (elements.length > MAX_ELEMENTS) throw new Error('PPTX slide exceeds the preview limit')
  }
  return elements
}

async function slideLayout(xml, path, context) {
  if (xml.documentElement.namespaceURI !== PPTX_XML_NS.presentation || !xmlChild(xml.documentElement, 'cSld')) {
    throw new Error('Invalid PPTX slide layout')
  }
  const layout = await relatedPptxPart(context.readXml, path, 'slideLayout')
  const master = await relatedPptxPart(context.readXml, layout.path, 'slideMaster')
  const theme = await relatedPptxPart(context.readXml, master.path, 'theme')
  const slideContext = { ...context, master: master.xml, effectBudget: { pixels: 0 }, elementBudget: { count: 0 },
    theme: readPptxTheme(theme.xml, master.xml, layout.xml, xml), relationships: layout.relationships }
  if (xmlDescendants(xml, 'timing').length) throw new Error('Animated PPTX slides are not supported')
  const background = backgroundFill(xml, slideContext.theme) ?? backgroundFill(layout.xml, slideContext.theme)
    ?? backgroundFill(master.xml, slideContext.theme) ?? 'white'
  const elements = []
  if (!['0', 'false'].includes(xml.documentElement.getAttribute('showMasterSp'))) {
    if (!['0', 'false'].includes(layout.xml?.documentElement.getAttribute('showMasterSp'))) {
      elements.push(...await parseShapeTree(master.xml, { ...slideContext,
        relationships: await readPptxRelationships(context.readXml, master.path) }, true))
    }
    elements.push(...await parseShapeTree(layout.xml, { ...slideContext, relationships: master.relationships }, true))
  }
  elements.push(...await parseShapeTree(xml, slideContext))
  if (elements.length > MAX_ELEMENTS) throw new Error('PPTX slide exceeds the preview limit')
  return { width: context.width, height: context.height, background, elements }
}

function slideOutline(xml, index) {
  const paragraphs = Array.from(xml.getElementsByTagNameNS(PPTX_XML_NS.drawing, 'p'))
  const lines = paragraphs.map((paragraph) => xmlDescendants(paragraph, 't').map((node) => node.textContent).join('').trim()).filter(Boolean)
  return { title: lines[0] || `Slide ${index + 1}`, lines: lines.slice(1) }
}

/** Read only the original package; no remote viewer, process, or font fetch. */
export async function readPptxFilePreview(zip, { Parser = globalThis.DOMParser || globalThis.window?.DOMParser } = {}) {
  assertPptxPreviewPackage(zip)
  if (!Parser) return null
  const readXml = createPptxXmlReader(zip, Parser)
  const presentation = await readXml('ppt/presentation.xml')
  if (!presentation) return null
  const relationships = await readPptxRelationships(readXml, 'ppt/presentation.xml')
  const ids = xmlChildren(xmlChild(presentation.documentElement, 'sldIdLst'), 'sldId')
  if (!ids.length || ids.length > MAX_SLIDES) throw new Error('PPTX slide count exceeds the preview limit')
  const size = xmlChild(presentation.documentElement, 'sldSz')
  const width = emu(xmlNumber(size, 'cx'))
  const height = emu(xmlNumber(size, 'cy'))
  const validSize = width >= 1 && height >= 1 && width <= 8192 && height <= 8192
  const context = { zip, readXml, presentation, width, height, images: new Map(),
    imageBudget: { bytes: 0, limit: PPTX_PREVIEW_BYTE_LIMITS.imageTotal, pixels: 0 } }
  const slides = []
  for (const id of ids) {
    const relation = relationships.get(id.getAttributeNS(PPTX_XML_NS.relationships, 'id'))
    if (relation?.type !== 'slide' || !/^ppt\/slides\/[^/]+\.xml$/i.test(relation?.target || '')) {
      throw new Error('Invalid PPTX slide relationship')
    }
    const xml = await readXml(relation.target)
    if (!xml) throw new Error('PPTX slide part is missing')
    const slide = { ...slideOutline(xml, slides.length), sourcePath: relation.target, layout: null }
    if (validSize) {
      try { slide.layout = await slideLayout(xml, relation.target, context) }
      catch { /* The UI labels this slide as an outline, not an original-layout render. */ }
    }
    slides.push(slide)
  }
  return { width, height, slides }
}

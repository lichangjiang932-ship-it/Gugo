import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import JSZip from 'jszip'
import { JSDOM } from 'jsdom'
import { readPptxFilePreview } from '../src/lib/pptxFilePreview.js'
import { pptxDrawingPaint, transformBox } from '../src/lib/pptxPreviewDrawing.js'
import { PPTX_SHADOW_FILTER_LIMITS, pptxShadowFilterRegion } from '../src/lib/pptxPreviewShadow.js'
import { PPTX_XML_NS, xmlChild } from '../src/lib/pptxPreviewXml.js'

const dom = new JSDOM('')
const Parser = dom.window.DOMParser
const theme = { xml: null, colors: {}, mapping: {} }
after(() => dom.window.close())

const asEmu = (pixels) => Math.round(pixels * 9525)

function drawingXml({ w = 1, h = 1, strokeWidth = 0, shape = 'rect', blurRadius = 0,
  distance = 0, flipV = false, rotation = 0 } = {}) {
  return `<a:spPr xmlns:a="${PPTX_XML_NS.drawing}">
    <a:xfrm rot="${Math.round(rotation * 60000)}"${flipV ? ' flipV="1"' : ''}>
      <a:off x="0" y="0"/><a:ext cx="${asEmu(w)}" cy="${asEmu(h)}"/>
    </a:xfrm>
    <a:prstGeom prst="${shape}"><a:avLst/></a:prstGeom>
    <a:solidFill><a:srgbClr val="1B3A5C"/></a:solidFill>
    <a:ln w="${asEmu(strokeWidth)}"><a:solidFill><a:srgbClr val="D0D4DB"/></a:solidFill></a:ln>
    <a:effectLst><a:outerShdw blurRad="${blurRadius}" dist="${distance}" dir="5400000" rotWithShape="0">
      <a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr>
    </a:outerShdw></a:effectLst>
  </a:spPr>`
}

function painted(options, budget = { pixels: 0 }) {
  const properties = new Parser().parseFromString(drawingXml(options), 'application/xml').documentElement
  const box = transformBox(xmlChild(properties, 'xfrm'))
  return { ...box, ...pptxDrawingPaint(properties, null, theme, box, budget) }
}

function packageFor(options) {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${PPTX_XML_NS.presentation}" xmlns:r="${PPTX_XML_NS.relationships}">
    <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/>
  </p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="${PPTX_XML_NS.relationships}/slide" Target="slides/slide1.xml"/>
  </Relationships>`)
  const shapes = options.map((option, index) => `<p:sp>
    <p:nvSpPr><p:cNvPr id="${index + 2}" name="Budget fixture ${index + 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    ${drawingXml(option)}<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
  </p:sp>`).join('')
  zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="${PPTX_XML_NS.presentation}" xmlns:a="${PPTX_XML_NS.drawing}">
    <p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapes}</p:spTree></p:cSld>
  </p:sld>`)
  return zip
}

test('shadow region rejects the 1px shape plus 2048px stroke counterexample before SVG allocation', async () => {
  const options = { w: 1, h: 1, strokeWidth: 2048 }
  const rendererAreaWithoutTheGate = (1 + 2 * (2048 + 1)) ** 2
  assert.equal(rendererAreaWithoutTheGate, 16_801_801)
  assert.ok(rendererAreaWithoutTheGate > PPTX_SHADOW_FILTER_LIMITS.pixels)
  assert.throws(() => pptxShadowFilterRegion({ ...options, shadow: { blur: 0, dx: 0, dy: 0 } }), /shadow area/)
  const budget = { pixels: 0 }
  assert.throws(() => painted(options, budget), /shadow area/)
  assert.equal(budget.pixels, 0, 'a rejected filter cannot be charged as a tiny accepted region')
  const preview = await readPptxFilePreview(packageFor([options]), { Parser })
  assert.equal(preview.slides[0].layout, null)
})

test('500 individually legal stroke-expanded shadows cannot evade the shared total budget', async () => {
  const options = { w: 1, h: 1, strokeWidth: 500 }
  const region = pptxShadowFilterRegion({ ...options, shadow: { blur: 0, dx: 0, dy: 0 } })
  const pixels = region.width * region.height
  assert.equal(pixels, 1_006_009)
  assert.ok(pixels < PPTX_SHADOW_FILTER_LIMITS.pixels)
  const limit = Math.floor(PPTX_SHADOW_FILTER_LIMITS.totalPixels / pixels)
  assert.equal(limit, 31)
  const budget = { pixels: 0 }
  for (let index = 0; index < limit; index += 1) painted(options, budget)
  assert.equal(budget.pixels, limit * pixels)
  for (let index = limit; index < 500; index += 1) assert.throws(() => painted(options, budget), /shadow area/)
  assert.equal(budget.pixels, limit * pixels, 'failed attempts cannot wrap or reset the budget')
  const legal = await readPptxFilePreview(packageFor(Array.from({ length: limit }, () => options)), { Parser })
  assert.equal(legal.slides[0].layout.elements.length, limit)
  const oversized = await readPptxFilePreview(packageFor(Array.from({ length: 500 }, () => options)), { Parser })
  assert.equal(oversized.slides[0].layout, null, 'exactly 500 shapes pass the element-count ceiling but must fail the shadow budget')
})

test('thin zero-height timeline lines and small empty-text circles use the same finite region without false rejection', async () => {
  const line = { w: 100, h: 0, strokeWidth: 1.6, shape: 'line', blurRadius: 40000, distance: 20000 }
  const circle = { w: 13.44, h: 13.44, strokeWidth: 0, shape: 'ellipse', blurRadius: 40000, distance: 23000 }
  const options = Array.from({ length: 500 }, (_, index) => index % 2 ? line : circle)
  const preview = await readPptxFilePreview(packageFor(options), { Parser })
  const elements = preview.slides[0].layout?.elements
  assert.equal(elements?.length, 500)
  let expectedPixels = 0
  for (const element of elements) {
    const region = pptxShadowFilterRegion(element)
    assert.ok(region.width > 0 && region.height > 0)
    assert.ok(Object.values(region).every(Number.isFinite))
    assert.equal(element.text, null, 'an empty txBody cannot turn a point into unsupported shape text')
    expectedPixels += region.width * region.height
  }
  assert.ok(expectedPixels < PPTX_SHADOW_FILTER_LIMITS.totalPixels)
  const budget = { pixels: 0 }
  for (const option of options) painted(option, budget)
  assert.ok(Math.abs(budget.pixels - expectedPixels) < 1e-6, 'parser accounting must equal the shared renderer region')
})

test('shadow blur is an SVG standard deviation in pixels and the filter region accounts for the final line width', () => {
  const element = painted({ w: 100, h: 0, strokeWidth: 1.6, shape: 'line', blurRadius: 40000, distance: 20000 })
  assert.ok(Math.abs(element.shadow.blur - 40000 / 9525 / 2) < 1e-12)
  assert.equal(element.shadow.dx, 0)
  assert.ok(Math.abs(element.shadow.dy - 20000 / 9525) < 1e-12)
  const padding = element.shadow.blur * 3 + element.shadow.dy + 1.6 + 1
  assert.deepEqual(pptxShadowFilterRegion(element), { x: -padding, y: -padding,
    width: 100 + padding * 2, height: padding * 2 })
})

test('nonfinite or negative filter geometry and cumulative counters fail closed', () => {
  const base = { w: 1, h: 1, strokeWidth: 1, shadow: { blur: 1, dx: 0, dy: 0 } }
  for (const value of [NaN, Infinity, -Infinity, -1]) {
    for (const key of ['w', 'h', 'strokeWidth']) assert.throws(() => pptxShadowFilterRegion({ ...base, [key]: value }))
    assert.throws(() => pptxShadowFilterRegion({ ...base, shadow: { ...base.shadow, blur: value } }))
    assert.throws(() => painted({}, { pixels: value }))
  }
  for (const key of ['dx', 'dy']) {
    for (const value of [NaN, Infinity, -Infinity, -2049, 2049]) {
      assert.throws(() => pptxShadowFilterRegion({ ...base, shadow: { ...base.shadow, [key]: value } }))
    }
  }
})

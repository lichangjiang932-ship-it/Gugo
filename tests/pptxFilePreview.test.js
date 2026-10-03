import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { JSDOM } from 'jsdom'
import { readPptxFilePreview } from '../src/lib/pptxFilePreview.js'
import { PPTX_XML_NS, pptxColor } from '../src/lib/pptxPreviewXml.js'

const dom = new JSDOM('')
const Parser = dom.window.DOMParser
const Serializer = dom.window.XMLSerializer
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438DwHwAGgAJ/EEwb4QAAAABJRU5ErkJggg=='
after(() => dom.window.close())

async function deck({ background = '113355', font = 'Georgia', x = 1, image = false, portrait = false, twoSlides = false } = {}) {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'ORIGINAL', width: portrait ? 7.5 : 13.333333, height: portrait ? 13.333333 : 7.5 })
  pptx.layout = 'ORIGINAL'
  pptx.theme = { headFontFace: 'Arial', bodyFontFace: font }
  const slide = pptx.addSlide()
  slide.background = { color: background }
  slide.addText([{ text: 'Same title', options: { bold: true } }, { text: ' original detail', options: { italic: true, color: '66AA44' } }],
    { x, y: 1, w: 5, h: 1.5, margin: 0, fontFace: font, fontSize: 30, color: 'FFDD55', valign: 'top' })
  slide.addShape(pptx.ShapeType.ellipse, { x: 2, y: 3, w: 3, h: 2, fill: { color: 'EE5588', transparency: 25 }, line: { color: 'FFFFFF', width: 2 } })
  if (image) slide.addImage({ data: `image/png;base64,${pixel}`, x: 6, y: 2, w: 2, h: 1, altText: 'Embedded pixel' })
  if (twoSlides) {
    const second = pptx.addSlide()
    second.background = { color: 'CC7722' }
    second.addText('Second original slide', { x: 1, y: 2, w: 6, h: 1, fontSize: 24 })
  }
  return JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }))
}

async function editXml(zip, path, edit) {
  const document = new Parser().parseFromString(await zip.file(path).async('string'), 'application/xml')
  edit(document)
  zip.file(path, new Serializer().serializeToString(document))
}

function descendants(node, name) { return Array.from(node.getElementsByTagNameNS('*', name)) }
const read = (zip) => readPptxFilePreview(zip, { Parser })

test('original PPTX layout preserves page size, coordinates, background, colors, fonts, and embedded pixels', async () => {
  const preview = await read(await deck({ image: true }))
  assert.equal(preview.width, 1280)
  assert.equal(preview.height, 720)
  const layout = preview.slides[0].layout
  assert.ok(layout)
  assert.equal(layout.background, 'rgba(17,51,85,1)')
  const [text, ellipse, image] = layout.elements
  assert.deepEqual([text.x, text.y, text.w, text.h], [96, 96, 480, 144])
  const runs = text.text.paragraphs[0].runs
  assert.equal(runs[0].text, 'Same title')
  assert.equal(runs[0].style.fontSize, 40)
  assert.equal(runs[0].style.fontFamily, 'Georgia')
  assert.equal(runs[0].style.color, 'rgba(255,221,85,1)')
  assert.equal(runs[0].style.fontWeight, 700)
  assert.equal(runs[1].style.fontStyle, 'italic')
  assert.equal(runs[1].style.color, 'rgba(102,170,68,1)')
  assert.equal(ellipse.shape, 'ellipse')
  assert.equal(ellipse.fill, 'rgba(238,85,136,0.75)')
  assert.equal(ellipse.strokeWidth, 8 / 3)
  assert.equal(image.kind, 'image')
  assert.equal(image.src, `data:image/png;base64,${pixel}`)
  assert.deepEqual([image.x, image.y, image.w, image.h], [576, 192, 192, 96])
})

test('changing style without changing slide text changes the original-file preview', async () => {
  const first = (await read(await deck())).slides[0]
  const second = (await read(await deck({ background: 'F0EEDD', font: 'Arial', x: 2 }))).slides[0]
  assert.equal(first.title, second.title)
  assert.notEqual(first.layout.background, second.layout.background)
  assert.notEqual(first.layout.elements[0].x, second.layout.elements[0].x)
  assert.notEqual(first.layout.elements[0].text.paragraphs[0].runs[0].style.fontFamily,
    second.layout.elements[0].text.paragraphs[0].runs[0].style.fontFamily)
})

test('portrait decks retain the original aspect ratio instead of a fixed widescreen template', async () => {
  const preview = await read(await deck({ portrait: true }))
  assert.equal(preview.width, 720)
  assert.equal(preview.height, 1280)
  assert.equal(preview.slides[0].layout.height, 1280)
})

test('slide sequence follows presentation relationships rather than numbered filenames', async () => {
  const zip = await deck({ twoSlides: true })
  await editXml(zip, 'ppt/presentation.xml', (xml) => {
    const list = descendants(xml, 'sldIdLst')[0]
    list.insertBefore(list.lastElementChild, list.firstElementChild)
  })
  const preview = await read(zip)
  assert.deepEqual(preview.slides.map((slide) => slide.sourcePath), ['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'])
  assert.equal(preview.slides[0].title, 'Second original slide')
  assert.equal(preview.slides[0].layout.background, 'rgba(204,119,34,1)')
})

test('theme color, master text font, and layout background inheritance come from the file', async () => {
  const zip = await deck({ font: 'Georgia' })
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
    descendants(xml, 'bg')[0].remove()
    for (const properties of descendants(xml, 'rPr')) {
      for (const name of ['sz', 'b', 'i']) properties.removeAttribute(name)
      for (const node of Array.from(properties.children)) node.remove()
    }
  })
  await editXml(zip, 'ppt/slideMasters/slideMaster1.xml', (xml) => {
    const style = descendants(descendants(xml, 'otherStyle')[0], 'lvl1pPr')[0]
    descendants(style, 'defRPr')[0].setAttribute('sz', '2800')
  })
  await editXml(zip, 'ppt/theme/theme1.xml', (xml) => {
    const colors = descendants(xml, 'clrScheme')[0]
    const light = descendants(colors, 'lt1')[0].firstElementChild
    const dark = descendants(colors, 'dk1')[0].firstElementChild
    light.setAttribute(light.localName === 'sysClr' ? 'lastClr' : 'val', 'FAEEDD')
    dark.setAttribute(dark.localName === 'sysClr' ? 'lastClr' : 'val', '224466')
  })
  const slide = (await read(zip)).slides[0]
  assert.ok(slide.layout)
  assert.equal(slide.layout.background, 'rgba(250,238,221,1)')
  const style = slide.layout.elements[0].text.paragraphs[0].runs[0].style
  assert.equal(style.fontFamily, 'Georgia')
  assert.equal(style.fontSize, 2800 / 75)
  assert.equal(style.color, 'rgba(34,68,102,1)')
})

test('explicit inherited master decorations precede original slide elements', async () => {
  const zip = await deck()
  const slideXml = new Parser().parseFromString(await zip.file('ppt/slides/slide1.xml').async('string'), 'application/xml')
  const ellipse = descendants(slideXml, 'sp')[1]
  await editXml(zip, 'ppt/slideMasters/slideMaster1.xml', (xml) => {
    descendants(xml, 'spTree')[0].appendChild(xml.importNode(ellipse, true))
  })
  const layout = (await read(zip)).slides[0].layout
  assert.equal(layout.elements.length, 3)
  assert.equal(layout.elements[0].shape, 'ellipse')
  assert.equal(layout.elements[1].text.paragraphs[0].runs[0].text, 'Same title')
})

test('image crop and rotation use original OOXML values', async () => {
  const zip = await deck({ image: true })
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
    const image = descendants(xml, 'pic')[0]
    const transform = descendants(image, 'xfrm')[0]
    transform.setAttribute('rot', '5400000')
    transform.setAttribute('flipH', '1')
    const fill = descendants(image, 'blipFill')[0]
    const crop = xml.createElementNS(PPTX_XML_NS.drawing, 'a:srcRect')
    crop.setAttribute('l', '10000')
    crop.setAttribute('r', '20000')
    fill.appendChild(crop)
  })
  const image = (await read(zip)).slides[0].layout.elements.at(-1)
  assert.equal(image.rotation, 90)
  assert.equal(image.flipH, true)
  assert.deepEqual(image.crop, { l: 0.1, r: 0.2, t: 0, b: 0 })
})

test('unsupported chart/group/placeholder/gradient pages fall back to outlines, not invented drawings', async () => {
  for (const kind of ['graphicFrame', 'grpSp', 'ph', 'gradFill']) {
    const zip = await deck({ twoSlides: true })
    await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
      const parent = kind === 'ph' ? descendants(xml, 'nvPr')[1]
        : kind === 'gradFill' ? descendants(xml, 'spPr')[0] : descendants(xml, 'spTree')[0]
      parent.appendChild(xml.createElementNS(kind === 'gradFill' ? PPTX_XML_NS.drawing : PPTX_XML_NS.presentation,
        `${kind === 'gradFill' ? 'a' : 'p'}:${kind}`))
    })
    const preview = await read(zip)
    assert.equal(preview.slides[0].layout, null, kind)
    assert.match(preview.slides[0].title, /Same title/, kind)
    assert.ok(preview.slides[1].layout, 'supported slides in the same deck remain previewable')
  }
})

test('external images and SVG bytes never become remote or active preview resources', async () => {
  for (const unsafe of ['external', 'svg', 'svg-disguised-as-png']) {
    const zip = await deck({ image: true })
    await editXml(zip, 'ppt/slides/_rels/slide1.xml.rels', (xml) => {
      const image = descendants(xml, 'Relationship').find((node) => node.getAttribute('Type').endsWith('/image'))
      if (unsafe === 'external') {
        image.setAttribute('TargetMode', 'External')
        image.setAttribute('Target', 'https://attacker.invalid/tracking.svg')
      } else {
        const filename = unsafe === 'svg' ? 'active.svg' : 'active.png'
        image.setAttribute('Target', `../media/${filename}`)
        zip.file(`ppt/media/${filename}`, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("https://attacker.invalid")</script></svg>')
      }
    })
    assert.equal((await read(zip)).slides[0].layout, null, unsafe)
  }
})

test('PPTX XML DTD/entities and unsafe slide relationships are rejected without parsing active content', async () => {
  const unsafeXml = await deck()
  const xml = await unsafeXml.file('ppt/slides/slide1.xml').async('string')
  unsafeXml.file('ppt/slides/slide1.xml', xml.replace(/<p:sld\b/, '<!DOCTYPE sld [<!ENTITY leak SYSTEM "file:///private">]><p:sld'))
  await assert.rejects(read(unsafeXml), /entities are not supported/)
  const unsafeRelationship = await deck()
  await editXml(unsafeRelationship, 'ppt/_rels/presentation.xml.rels', (document) => {
    const relation = descendants(document, 'Relationship').find((node) => node.getAttribute('Type').endsWith('/slide'))
    relation.setAttribute('Target', 'https://attacker.invalid/slide.xml')
    relation.setAttribute('TargetMode', 'External')
  })
  await assert.rejects(read(unsafeRelationship), /slide relationship/)
})

test('decompressed package, XML, and image budgets fail closed', async () => {
  const oversizedPackage = await deck()
  oversizedPackage.file('ppt/slides/slide1.xml')._data.uncompressedSize = 129 * 1024 * 1024
  await assert.rejects(read(oversizedPackage), /package exceeds/)
  const oversizedXml = await deck()
  oversizedXml.file('ppt/slides/slide1.xml')._data.uncompressedSize = 9 * 1024 * 1024
  await assert.rejects(read(oversizedXml), /XML exceeds/)
  const oversizedImage = await deck({ image: true })
  const image = Object.values(oversizedImage.files).find((entry) => entry.name.startsWith('ppt/media/') && !entry.dir)
  image._data.uncompressedSize = 17 * 1024 * 1024
  assert.equal((await read(oversizedImage)).slides[0].layout, null)
})

test('missing page dimensions do not silently impose a widescreen template', async () => {
  const zip = await deck()
  await editXml(zip, 'ppt/presentation.xml', (xml) => descendants(xml, 'sldSz')[0].remove())
  const preview = await read(zip)
  assert.equal(preview.slides[0].layout, null)
  assert.match(preview.slides[0].title, /Same title/)
})

test('unknown inherited transforms, missing layout parts, and flipped text do not get guessed', async () => {
  for (const unsupported of ['root-transform', 'missing-layout', 'flipped-text']) {
    const zip = await deck()
    if (unsupported === 'missing-layout') zip.remove('ppt/slideLayouts/slideLayout1.xml')
    else await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
      if (unsupported === 'root-transform') descendants(descendants(xml, 'grpSpPr')[0], 'off')[0].setAttribute('x', '9525')
      else descendants(descendants(xml, 'spPr')[0], 'xfrm')[0].setAttribute('flipH', '1')
    })
    assert.equal((await read(zip)).slides[0].layout, null, unsupported)
  }
})

function fragment(xml, markup) {
  const parsed = new Parser().parseFromString(`<root xmlns:a="${PPTX_XML_NS.drawing}" xmlns:p="${PPTX_XML_NS.presentation}">${markup}</root>`, 'application/xml')
  assert.equal(descendants(parsed, 'parsererror').length, 0)
  return xml.importNode(parsed.documentElement.firstElementChild, true)
}

const shapeStyle = (fill = 1, effect = 1, line = 2) => `<p:style><a:lnRef idx="${line}"><a:srgbClr val="112233"/></a:lnRef><a:fillRef idx="${fill}"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="${effect}"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="major"><a:schemeClr val="accent1"/></a:fontRef></p:style>`

async function nativeStyles(zip) {
  await editXml(zip, 'ppt/theme/theme1.xml', (xml) => {
    descendants(descendants(xml, 'clrScheme')[0], 'accent1')[0].firstElementChild.setAttribute('val', '7B6B9E')
    for (const [name, markup] of [
      ['fillStyleLst', '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:noFill/><a:gradFill/></a:fillStyleLst>'],
      ['lnStyleLst', '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill></a:ln><a:ln w="25400" cap="flat"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>'],
      ['effectStyleLst', '<a:effectStyleLst><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/><a:scene3d/></a:effectStyle></a:effectStyleLst>'],
    ]) descendants(xml, name)[0].replaceWith(fragment(xml, markup))
  })
}

test('shape style inherits only referenced theme paint, font and bounded outer shadow', async () => {
  const zip = await deck()
  await nativeStyles(zip)
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
    const shape = descendants(xml, 'sp')[0]
    const properties = descendants(shape, 'spPr')[0]
    for (const child of Array.from(properties.children).filter((node) => ['solidFill', 'noFill', 'ln'].includes(node.localName))) child.remove()
    shape.appendChild(fragment(xml, shapeStyle()))
    descendants(shape, 'txBody')[0].replaceWith(fragment(xml, '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Keep original editable words</a:t></a:r></a:p></p:txBody>'))
  })
  const element = (await read(zip)).slides[0].layout.elements[0]
  assert.equal(element.fill, 'rgba(123,107,158,1)')
  assert.equal(element.stroke, 'rgba(17,34,51,1)')
  assert.equal(element.strokeWidth, 25400 / 9525)
  const run = element.text.paragraphs[0].runs[0]
  assert.equal(run.text, 'Keep original editable words')
  assert.equal(run.style.fontFamily, 'Arial')
  assert.equal(run.style.color, 'rgba(123,107,158,1)')
  assert.deepEqual(element.shadow, { dx: 0, dy: 20000 / 9525, blur: 20000 / 9525, color: 'rgba(0,0,0,0.38)' })
})

test('DrawingML tint retains the declared input fraction and distinguishes zero tint from no transform', () => {
  const xml = new Parser().parseFromString('<root/>', 'application/xml')
  const theme = { colors: {}, mapping: {} }
  const color = (hex, tint) => pptxColor(fragment(xml,
    `<a:solidFill><a:srgbClr val="${hex}">${tint === null ? '' : `<a:tint val="${tint}"/>`}</a:srgbClr></a:solidFill>`), theme)
  assert.equal(color('000000', 0), 'rgba(255,255,255,1)')
  assert.equal(color('000000', 10000), 'rgba(230,230,230,1)')
  assert.equal(color('123456', 100000), 'rgba(18,52,86,1)')
  assert.equal(color('123456', null), 'rgba(18,52,86,1)')
})

test('explicit ellipse paint wins over unused gradient/line effects and an actually empty txBody has no visible text', async () => {
  const zip = await deck()
  await nativeStyles(zip)
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
    const shape = descendants(xml, 'sp')[1]
    descendants(shape, 'ln')[0].replaceWith(fragment(xml, '<a:ln><a:noFill/></a:ln>'))
    shape.appendChild(fragment(xml, shapeStyle(3, 1, 1)))
    shape.appendChild(fragment(xml, '<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/></a:p></p:txBody>'))
  })
  const element = (await read(zip)).slides[0].layout.elements[1]
  assert.equal(element.shape, 'ellipse')
  assert.equal(element.fill, 'rgba(238,85,136,0.75)')
  assert.equal(element.stroke, 'none')
  assert.equal(element.text, null)
  assert.ok(element.shadow)
})

test('unsupported visible inherited effects and empty-body layout/bullets still fail honestly', async () => {
  for (const kind of ['gradient', 'three-dimensional', 'bullet', 'warp']) {
    const zip = await deck({ twoSlides: true })
    await nativeStyles(zip)
    await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
      const shape = descendants(xml, 'sp')[1]
      if (kind === 'gradient') {
        descendants(shape, 'solidFill')[0].remove()
        shape.appendChild(fragment(xml, shapeStyle(3, 2)))
      } else if (kind === 'three-dimensional') shape.appendChild(fragment(xml, shapeStyle(1, 3)))
      else shape.appendChild(fragment(xml, `<p:txBody><a:bodyPr>${kind === 'warp' ? '<a:prstTxWarp prst="textCircle"/>' : ''}</a:bodyPr><a:lstStyle/><a:p><a:pPr>${kind === 'bullet' ? '<a:buChar char="•"/>' : ''}</a:pPr></a:p></p:txBody>`))
    })
    const preview = await read(zip)
    assert.equal(preview.slides[0].layout, null, kind)
    assert.ok(preview.slides[1].layout)
  }
})

test('non-rotating shadows compensate both local line flips and rotation', async () => {
  const zip = await deck()
  await nativeStyles(zip)
  await editXml(zip, 'ppt/theme/theme1.xml', (xml) => descendants(xml, 'outerShdw')[0].setAttribute('dir', '0'))
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
    const shape = descendants(xml, 'sp')[1]
    shape.appendChild(fragment(xml, shapeStyle(1, 1)))
    descendants(shape, 'xfrm')[0].setAttribute('rot', '5400000')
    descendants(shape, 'xfrm')[0].setAttribute('flipV', '1')
  })
  const shadow = (await read(zip)).slides[0].layout.elements[1].shadow
  assert.equal(shadow.dx, 0)
  assert.equal(shadow.dy, 20000 / 9525)
})

const originalTableStyle = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'
function tableMarkup({ rows = 3, columns = 2, style = originalTableStyle } = {}) {
  const cells = Array.from({ length: rows }, (_, row) => `<a:tr h="457200">${Array.from({ length: columns }, (_, column) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr"><a:defRPr sz="1200"><a:solidFill><a:srgbClr val="334055"/></a:solidFill><a:latin typeface="Tahoma"/></a:defRPr></a:pPr><a:r><a:t>Cell ${row}:${column}</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"><a:solidFill><a:srgbClr val="${row === 0 ? '1B3A5C' : 'ECEDF1'}"/></a:solidFill></a:tcPr></a:tc>`).join('')}</a:tr>`).join('')
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="80" name="Source table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="1828800"/><a:ext cx="${columns * 1828800}" cy="${rows * 457200}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${style}</a:tableStyleId></a:tblPr><a:tblGrid>${Array.from({ length: columns }, () => '<a:gridCol w="1828800"/>').join('')}</a:tblGrid>${cells}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

async function tableDeck(options = {}) {
  const zip = await deck({ twoSlides: true })
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => descendants(xml, 'spTree')[0].appendChild(fragment(xml, tableMarkup(options))))
  return zip
}

test('native table preserves source cell coordinates/paint/text and resolves its exact builtin style borders', async () => {
  const layout = (await read(await tableDeck())).slides[0].layout
  const cells = layout.elements.filter((element) => element.tableCell)
  const borders = layout.elements.filter((element) => element.tableBorder)
  assert.equal(cells.length, 6)
  assert.equal(borders.length, 17)
  assert.deepEqual([cells[0].x, cells[0].y, cells[0].w, cells[0].h], [96, 192, 192, 48])
  assert.deepEqual([cells.at(-1).x, cells.at(-1).y], [288, 288])
  assert.equal(cells[0].fill, 'rgba(27,58,92,1)')
  assert.equal(cells[2].fill, 'rgba(236,237,241,1)')
  assert.deepEqual(cells.map((cell) => cell.text.paragraphs[0].runs[0].text), ['Cell 0:0', 'Cell 0:1', 'Cell 1:0', 'Cell 1:1', 'Cell 2:0', 'Cell 2:1'])
  assert.ok(cells.every((cell) => cell.text.valign === 'center' && cell.text.paragraphs[0].runs[0].style.fontFamily === 'Tahoma'))
  assert.ok(borders.every((border) => border.stroke === 'rgba(255,255,255,1)'))
  assert.equal(borders.filter((border) => border.strokeWidth === 4).length, 2, 'native firstRow style supplies its 3pt bottom edge')
})

test('explicit native cell borders override style edges without losing the surrounding grid', async () => {
  const zip = await tableDeck()
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => descendants(xml, 'tcPr')[0].appendChild(fragment(xml, '<a:lnR w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnR>')))
  const borders = (await read(zip)).slides[0].layout.elements.filter((element) => element.tableBorder)
  const red = borders.filter((border) => border.stroke === 'rgba(255,0,0,1)')
  assert.equal(red.length, 1)
  assert.deepEqual([red[0].x, red[0].y, red[0].w, red[0].h, red[0].strokeWidth], [288, 192, 0, 48, 2])
  assert.equal(borders.length, 17)
})

test('builtin table band/whole tints use retention fractions while untinted header/font/borders keep source colors', async () => {
  const zip = await tableDeck()
  await editXml(zip, 'ppt/theme/theme1.xml', (xml) => {
    descendants(descendants(xml, 'clrScheme')[0], 'accent1')[0].firstElementChild.setAttribute('val', '4F81BD')
  })
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
    const properties = descendants(xml, 'tcPr')
    for (const index of [0, 2, 4]) descendants(properties[index], 'solidFill')[0].remove()
  })
  const elements = (await read(zip)).slides[0].layout.elements
  const cells = elements.filter((element) => element.tableCell)
  assert.equal(cells[0].fill, 'rgba(79,129,189,1)', 'header has no tint transform')
  assert.equal(cells[2].fill, 'rgba(185,205,229,1)', 'band1H retains 40% accent1')
  assert.equal(cells[4].fill, 'rgba(220,230,242,1)', 'wholeTbl retains 20% accent1')
  assert.equal(cells[1].fill, 'rgba(27,58,92,1)', 'explicit source fill remains authoritative')
  assert.equal(cells[0].text.paragraphs[0].runs[0].style.color, 'rgba(51,64,85,1)')
  assert.ok(elements.filter((element) => element.tableBorder).every((border) => border.stroke === 'rgba(255,255,255,1)'))
})

test('unknown/custom table styles, merges and invalid grids remain explicitly unsupported', async () => {
  for (const kind of ['unknown-style', 'custom-override', 'merge', 'cell-count', 'grid-size', 'diagonal-border']) {
    const zip = await tableDeck(kind === 'unknown-style' ? { style: '{UNKNOWN-STYLE}' } : {})
    if (kind === 'custom-override') zip.file('ppt/tableStyles.xml', `<a:tblStyleLst xmlns:a="${PPTX_XML_NS.drawing}" def="${originalTableStyle}"><a:tblStyle styleId="${originalTableStyle}" styleName="custom"/></a:tblStyleLst>`)
    else if (kind !== 'unknown-style') await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
      if (kind === 'merge') descendants(xml, 'tc')[0].setAttribute('gridSpan', '2')
      if (kind === 'cell-count') descendants(xml, 'tc')[0].remove()
      if (kind === 'grid-size') descendants(xml, 'gridCol')[0].setAttribute('w', '999999999999')
      if (kind === 'diagonal-border') descendants(xml, 'tcPr')[0].appendChild(fragment(xml, '<a:lnTlToBr/>'))
    })
    const preview = await read(zip)
    assert.equal(preview.slides[0].layout, null, kind)
    assert.ok(preview.slides[1].layout, kind)
  }
})

test('native table expansion obeys both its own cell cap and the already consumed slide primitive budget', async () => {
  assert.equal((await read(await tableDeck({ rows: 21, columns: 10 }))).slides[0].layout, null)
  const zip = await tableDeck({ rows: 2, columns: 2 })
  await editXml(zip, 'ppt/slides/slide1.xml', (xml) => {
    const tree = descendants(xml, 'spTree')[0]
    const reference = descendants(tree, 'sp')[0]
    const table = descendants(tree, 'graphicFrame')[0]
    for (let index = 0; index < 488; index += 1) {
      const copy = reference.cloneNode(true)
      descendants(copy, 'cNvPr')[0].setAttribute('id', String(100 + index))
      tree.insertBefore(copy, table)
    }
  })
  const preview = await read(zip)
  assert.equal(preview.slides[0].layout, null)
  assert.ok(preview.slides[1].layout)
})

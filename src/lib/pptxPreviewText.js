import { emu, pptxColor, xmlChild, xmlChildren, xmlNumber } from './pptxPreviewXml.js'

function resolvedFont(properties, theme) {
  const typeface = xmlChild(properties, 'latin')?.getAttribute('typeface')
    || xmlChild(properties, 'ea')?.getAttribute('typeface')
  if (!typeface) return ''
  if (typeface.startsWith('+mj-')) return theme.majorFont
  if (typeface.startsWith('+mn-')) return theme.minorFont
  return typeface
}

function runStyle(properties, inherited, theme) {
  if (!properties) return inherited
  if (xmlChildren(properties).some((node) => ['gradFill', 'blipFill', 'pattFill', 'effectDag', 'ln', 'highlight'].includes(node.localName))
    || xmlChildren(xmlChild(properties, 'effectLst')).length) throw new Error('Unsupported PPTX text effect')
  const result = { ...inherited }
  if (properties.hasAttribute('sz')) result.fontSize = xmlNumber(properties, 'sz') / 75
  if (properties.hasAttribute('b')) result.fontWeight = ['1', 'true'].includes(properties.getAttribute('b')) ? 700 : 400
  if (properties.hasAttribute('i')) result.fontStyle = ['1', 'true'].includes(properties.getAttribute('i')) ? 'italic' : 'normal'
  if (properties.hasAttribute('u')) result.textDecoration = properties.getAttribute('u') === 'none' ? 'none' : 'underline'
  if (properties.hasAttribute('strike') && properties.getAttribute('strike') !== 'noStrike') result.textDecoration = 'line-through'
  if (xmlNumber(properties, 'baseline') !== 0) throw new Error('Unsupported PPTX text baseline')
  if (properties.hasAttribute('spc')) result.letterSpacing = xmlNumber(properties, 'spc') / 75
  result.color = pptxColor(xmlChild(properties, 'solidFill'), theme, result.color)
  result.fontFamily = resolvedFont(properties, theme) || result.fontFamily
  if (!(result.fontSize > 0 && result.fontSize <= 1024)) throw new Error('Invalid PPTX font size')
  return result
}

function spacing(properties, name, fontSize, fallback = 0) {
  const node = xmlChild(properties, name)
  const points = xmlChild(node, 'spcPts')
  if (points) return xmlNumber(points, 'val') / 75
  const percent = xmlChild(node, 'spcPct')
  return percent ? xmlNumber(percent, 'val') / 100000 * fontSize : fallback
}

function inheritedParagraph(level, context) {
  const name = `lvl${level + 1}pPr`
  return [
    xmlChild(xmlChild(context.presentation.documentElement, 'defaultTextStyle'), name),
    xmlChild(xmlChild(xmlChild(context.master?.documentElement, 'txStyles'), 'otherStyle'), name),
  ].filter(Boolean)
}

function parseParagraph(paragraph, body, context, index) {
  const properties = xmlChild(paragraph, 'pPr')
  const level = xmlNumber(properties, 'lvl')
  if (!Number.isInteger(level) || level < 0 || level > 8) throw new Error('Invalid PPTX text level')
  const inherited = inheritedParagraph(level, context)
  const localDefaults = [xmlChild(xmlChild(body, 'lstStyle'), `lvl${level + 1}pPr`), properties].filter(Boolean)
  const defaults = [...inherited, ...localDefaults]
  let style = { fontFamily: context.theme.minorFont || 'sans-serif', fontSize: 24, color: 'black' }
  for (const item of inherited) style = runStyle(xmlChild(item, 'defRPr'), style, context.theme)
  style = { ...style, ...context.fontStyle }
  for (const item of localDefaults) style = runStyle(xmlChild(item, 'defRPr'), style, context.theme)
  const bodyFontScale = xmlNumber(xmlChild(xmlChild(body, 'bodyPr'), 'normAutofit'), 'fontScale', 100000) / 100000
  if (bodyFontScale <= 0 || bodyFontScale > 1) throw new Error('Unsupported PPTX font scaling')
  const runs = xmlChildren(paragraph).filter((node) => ['r', 'fld', 'br'].includes(node.localName)).map((node) => {
    const nextStyle = runStyle(xmlChild(node, 'rPr'), style, context.theme)
    return { text: node.localName === 'br' ? '\n' : xmlChild(node, 't')?.textContent || '',
      style: { ...nextStyle, fontSize: nextStyle.fontSize * bodyFontScale } }
  })
  const mergedAttribute = (name, fallback = '') => defaults.findLast((node) => node.hasAttribute(name))?.getAttribute(name) || fallback
  const mergedNumber = (name) => xmlNumber(defaults.findLast((node) => node.hasAttribute(name)), name)
  const bulletProperties = defaults.findLast((node) => xmlChildren(node).some((child) => child.localName.startsWith('bu')))
  let bullet = xmlChild(bulletProperties, 'buChar')?.getAttribute('char') || ''
  const auto = xmlChild(bulletProperties, 'buAutoNum')
  if (auto) {
    if (auto.getAttribute('type') !== 'arabicPeriod') throw new Error('Unsupported PPTX numbering')
    bullet = `${xmlNumber(auto, 'startAt', index + 1)}.`
  }
  if (xmlChild(bulletProperties, 'buBlip')) throw new Error('Unsupported PPTX picture bullet')
  const lineSpacing = defaults.findLast((node) => xmlChild(node, 'lnSpc'))
  const linePoints = xmlChild(xmlChild(lineSpacing, 'lnSpc'), 'spcPts')
  const linePercent = xmlChild(xmlChild(lineSpacing, 'lnSpc'), 'spcPct')
  const fontSize = Math.max(style.fontSize * bodyFontScale, ...runs.map((run) => run.style.fontSize))
  return { runs, bullet, style: {
    ...style, fontSize,
    textAlign: { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[mergedAttribute('algn', 'l')] || 'left',
    paddingLeft: emu(mergedNumber('marL')), paddingRight: emu(mergedNumber('marR')),
    textIndent: emu(mergedNumber('indent')),
    lineHeight: linePoints ? `${xmlNumber(linePoints, 'val') / 75}px` : linePercent ? xmlNumber(linePercent, 'val') / 100000 : 'normal',
    marginTop: spacing(defaults.findLast((node) => xmlChild(node, 'spcBef')), 'spcBef', fontSize),
    marginBottom: spacing(defaults.findLast((node) => xmlChild(node, 'spcAft')), 'spcAft', fontSize),
  } }
}

export function parsePptxText(body, context, cellProperties = null) {
  if (!body) return null
  const properties = xmlChild(body, 'bodyPr')
  if ((properties?.getAttribute('vert') && properties.getAttribute('vert') !== 'horz')
    || xmlNumber(properties, 'rot') !== 0 || xmlNumber(properties, 'numCol', 1) !== 1
    || xmlNumber(xmlChild(properties, 'normAutofit'), 'lnSpcReduction') !== 0
    || ['1', 'true'].includes(properties?.getAttribute('upright'))
    || !['t', 'ctr', 'b', null, undefined].includes(properties?.getAttribute('anchor'))
    || xmlChildren(properties).some((node) => ['prstTxWarp', 'scene3d', 'sp3d'].includes(node.localName))) {
    throw new Error('Unsupported PPTX text layout')
  }
  const paragraphs = xmlChildren(body, 'p').map((paragraph, index) => parseParagraph(paragraph, body, context, index))
  if (!paragraphs.some((paragraph) => paragraph.bullet || paragraph.runs.some((run) => run.text))) return null
  const anchor = cellProperties?.getAttribute('anchor') || properties?.getAttribute('anchor') || 't'
  if (!['t', 'ctr', 'b'].includes(anchor)) throw new Error('Unsupported PPTX text anchor')
  const insets = cellProperties
    ? [emu(xmlNumber(cellProperties, 'marT', 45720)), emu(xmlNumber(cellProperties, 'marR', 91440)),
      emu(xmlNumber(cellProperties, 'marB', 45720)), emu(xmlNumber(cellProperties, 'marL', 91440))]
    : [emu(xmlNumber(properties, 'tIns', 45720)), emu(xmlNumber(properties, 'rIns', 91440)),
      emu(xmlNumber(properties, 'bIns', 45720)), emu(xmlNumber(properties, 'lIns', 91440))]
  if (insets.some((value) => value < 0 || value > 32768)) throw new Error('Invalid PPTX text inset')
  return {
    paragraphs,
    valign: { t: 'flex-start', ctr: 'center', b: 'flex-end' }[anchor],
    wrap: properties?.getAttribute('wrap') !== 'none',
    insets,
  }
}

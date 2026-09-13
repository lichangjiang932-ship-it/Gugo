import { estimatedTextLines, PPTX_LINE_HEIGHT_FACTOR, slidePptxDesign } from './pptxArtifactDesign.js'
import { renderPptxElements } from './pptxArtifactElements.js'
import { markNativePptxPreflightFailure } from './pptxPreflightDiagnostics.js'

const MAX_REPORTED_ISSUES = 32
const VALIDATION_SLIDE = Object.freeze(Object.fromEntries(
  ['addText', 'addShape', 'addImage', 'addChart', 'addTable'].map((name) => [name, () => {}]),
))
const up = (value) => Math.ceil(value * 1_000_000) / 1_000_000

function diagnostic(error, element, slideIndex, elementIndex, design) {
  element = element && typeof element === 'object' ? element : {}
  const fit = error.pptxTextFit
  const geometry = { x: element.x, y: element.y, w: element.w, h: element.h }
  const simpleText = element.type === 'text' && fit
  const fitsWholeSlide = !simpleText || estimatedTextLines(element.text, design.width, fit.font_size)
    * fit.font_size / 72 * PPTX_LINE_HEIGHT_FACTOR <= design.height
  return {
    slide_index: slideIndex, element_index: elementIndex,
    path: `slides[${slideIndex}].elements[${elementIndex}]`,
    code: error.code, message: error.message,
    kind: fit ? 'text_fit' : error.pptxGeometry ? 'geometry' : 'content', geometry,
    ...(fit ? { text_fit: fit } : {}),
    ...(simpleText ? { minimum_h: up(fit.required_h_inches / design.height), at_unchanged_width_and_font: true } : {}),
    geometry_repairable: Boolean((fit || error.pptxGeometry) && fitsWholeSlide),
  }
}

/** Exercise the same native validators against non-writing sinks, once per element. */
export function preflightPptxCanvas(slides, design, images) {
  const issues = []
  let firstError
  let issueCount = 0
  let geometryRepairable = true
  slides.forEach((source, slideIndex) => {
    if (!Array.isArray(source?.elements) || !source.elements.length) return
    const slideDesign = slidePptxDesign(design, source, `slides[${slideIndex}]`)
    source.elements.forEach((element, elementIndex) => {
      try {
        renderPptxElements(VALIDATION_SLIDE, {}, { ...source, elements: [element] }, slideDesign, images, slideIndex, { elementIndexOffset: elementIndex })
      } catch (error) {
        if (!['PPTX_CONTENT_OVERFLOW', 'PPTX_CONTENT_INVALID'].includes(error?.code)) throw error
        firstError ||= error
        issueCount += 1
        const issue = diagnostic(error, element, slideIndex, elementIndex, slideDesign)
        geometryRepairable &&= issue.geometry_repairable
        if (issues.length < MAX_REPORTED_ISSUES) issues.push(issue)
      }
    })
  })
  if (firstError) {
    throw markNativePptxPreflightFailure(firstError, { issues, issue_count: issueCount, geometry_repairable: geometryRepairable, truncated: issueCount > issues.length })
  }
}

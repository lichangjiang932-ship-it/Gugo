import { presentationTheme } from './pptxThemeState.js'

export function addAmbientDecor(slide, pptx, index, { dense = false } = {}) {
  slide.addShape(pptx.ShapeType.ellipse, {
    x: index % 2 === 0 ? 10.7 : -1.2,
    y: index % 2 === 0 ? -1.3 : 5.1,
    w: dense ? 3.3 : 2.7,
    h: dense ? 3.3 : 2.7,
    fill: { color: presentationTheme().glowA, transparency: 78 },
    line: { color: presentationTheme().glowA, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: index % 2 === 0 ? -0.8 : 10.8,
    y: index % 2 === 0 ? 5.5 : -1.1,
    w: dense ? 2.5 : 2.1,
    h: dense ? 2.5 : 2.1,
    fill: { color: presentationTheme().glowB, transparency: 84 },
    line: { color: presentationTheme().glowB, width: 0 },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 11.55, y: 0.36, w: 1.05, h: 0.22,
    fill: { color: presentationTheme().paper2, transparency: 12 },
    line: { color: presentationTheme().skeleton, width: 0.5 },
  })
}

export function addPageNumber(slide, index, total) {
  const num = String(index + 1).padStart(2, '0')
  const totalStr = String(total).padStart(2, '0')
  slide.addText(`${num} / ${totalStr}`, {
    x: 11.2, y: 7.05, w: 1.5, h: 0.22,
    fontSize: 9, color: presentationTheme().inkFade, align: 'right', margin: 0,
  })
}

export function addBottomLine(slide, color = presentationTheme().skeleton) {
  slide.addShape('rect', {
    x: 0.7, y: 6.9, w: 12, h: 0.02,
    fill: { color }, line: { color, width: 0 },
  })
}

/* \u2500\u2500 Cover \u2500\u2500 */


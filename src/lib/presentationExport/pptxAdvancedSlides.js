import { addAmbientDecor, addBottomLine, addPageNumber } from './pptxSlideChrome.js'
import { SLIDE_H, SLIDE_W } from './pptxConstants.js'
import { presentationTheme } from './pptxThemeState.js'

export function addDataSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  const accentColor = index % 3 === 0 ? presentationTheme().ember : index % 3 === 1 ? presentationTheme().cyan : '8A7B68'
  slide.background = { color: presentationTheme().paper }
  addAmbientDecor(slide, pptx, index, { dense: true })
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: presentationTheme().ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: accentColor },
    line: { color: accentColor, width: 0 },
  })

  const points = slideData.dataPoints || []
  const count = Math.min(points.length, 4)
  if (count > 0) {
    const cardW = 11.5 / count
    const startX = 0.7
    const y = 2.0
    points.slice(0, count).forEach((point, i) => {
      const x = startX + i * cardW
      slide.addText(point.value, {
        x, y, w: cardW - 0.3, h: 0.9,
        fontFace: 'Calibri', fontSize: 36, bold: true, color: accentColor,
        align: 'center', margin: 0,
      })
      slide.addText(point.label, {
        x, y: y + 1.0, w: cardW - 0.3, h: 0.8,
        fontFace: 'Calibri', fontSize: 14, color: presentationTheme().inkSoft,
        align: 'center', margin: 0,
      })
      slide.addShape(pptx.ShapeType.rect, {
        x: x + (cardW - 0.3) / 2 - 0.5, y: y + 1.9, w: 1.0, h: 0.03,
        fill: { color: accentColor },
        line: { color: accentColor, width: 0 },
      })
    })
  }
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Quote \u2500\u2500 */

export function addQuoteSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 180,
      stops: [{ color: presentationTheme().paper, position: 0 }, { color: presentationTheme().paper2, position: 100 }],
    },
    line: { color: presentationTheme().paper, width: 0 },
  })
  slide.addText('"', {
    x: 0.8, y: 1.2, w: 1.5, h: 1.2,
    fontFace: 'Calibri', fontSize: 72, bold: true, color: presentationTheme().ember, margin: 0,
  })
  if (slideData.quote?.text) {
    slide.addText(slideData.quote.text, {
      x: 1.5, y: 2.2, w: 10.3, h: 2.0,
      fontFace: 'Calibri', fontSize: 24, italic: true, color: presentationTheme().ink,
      align: 'center', margin: 0,
    })
  }
  if (slideData.quote?.source) {
    slide.addText(`\u2014 ${slideData.quote.source}`, {
      x: 1.5, y: 4.4, w: 10.3, h: 0.5,
      fontFace: 'Calibri', fontSize: 14, color: presentationTheme().inkFade,
      align: 'right', margin: 0,
    })
  }
  slide.addShape(pptx.ShapeType.rect, {
    x: 5.5, y: 5.2, w: 2.333, h: 0.04,
    fill: { color: presentationTheme().ember },
    line: { color: presentationTheme().ember, width: 0 },
  })
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Split \u2500\u2500 */

export function addSplitSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: presentationTheme().paper }
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: presentationTheme().ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: presentationTheme().ember },
    line: { color: presentationTheme().ember, width: 0 },
  })

  const left = slideData.leftColumn || { title: '', bullets: [] }
  const right = slideData.rightColumn || { title: '', bullets: [] }

  slide.addShape(pptx.ShapeType.rect, {
    x: 0.5, y: 1.5, w: 5.8, h: 4.8,
    fill: { color: 'F8F4EC' },
    line: { color: presentationTheme().skeleton, width: 0.5 },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 6.8, y: 1.5, w: 5.8, h: 4.8,
    fill: { color: 'F8F4EC' },
    line: { color: presentationTheme().skeleton, width: 0.5 },
  })

  if (left.title) {
    slide.addText(left.title, {
      x: 0.7, y: 1.7, w: 5.4, h: 0.5,
      fontFace: 'Calibri', fontSize: 18, bold: true, color: presentationTheme().cyan, margin: 0,
    })
  }
  if (left.bullets.length) {
    slide.addText(
      left.bullets.map((b) => ({ text: b, options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 6 } })),
      {
        x: 0.8, y: 2.3, w: 5.2, h: 3.8,
        fontFace: 'Calibri', fontSize: 14, color: presentationTheme().inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }

  if (right.title) {
    slide.addText(right.title, {
      x: 7.0, y: 1.7, w: 5.4, h: 0.5,
      fontFace: 'Calibri', fontSize: 18, bold: true, color: presentationTheme().ember, margin: 0,
    })
  }
  if (right.bullets.length) {
    slide.addText(
      right.bullets.map((b) => ({ text: b, options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 6 } })),
      {
        x: 7.1, y: 2.3, w: 5.2, h: 3.8,
        fontFace: 'Calibri', fontSize: 14, color: presentationTheme().inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }

  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Table \u2500\u2500 */

export function addTableSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: presentationTheme().paper }
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: presentationTheme().ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: presentationTheme().cyan },
    line: { color: presentationTheme().cyan, width: 0 },
  })

  const table = slideData.table || []
  if (table.length >= 2) {
    const cols = Math.max(...table.map((r) => r.length))
    const header = table[0]
    const body = table.slice(1)
    const tableData = [
      header.map((cell) => ({ text: cell, options: { bold: true, fill: presentationTheme().cyan, color: presentationTheme().white, fontFace: 'Calibri', fontSize: 13 } })),
      ...body.map((row) => row.map((cell) => ({ text: cell, options: { fill: 'F8F4EC', color: presentationTheme().inkSoft, fontFace: 'Calibri', fontSize: 12 } }))),
    ]
    slide.addTable(tableData, {
      x: 0.7, y: 1.5, w: 12, h: 4.5,
      border: { type: 'solid', pt: 0.5, color: presentationTheme().skeleton },
      colW: Array(cols).fill(12 / cols),
      autoPage: false,
    })
  }
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Process \u2500\u2500 */

export function addProcessSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: presentationTheme().paper }
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: presentationTheme().ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: presentationTheme().cyan },
    line: { color: presentationTheme().cyan, width: 0 },
  })

  const steps = slideData.processSteps || []
  const count = Math.min(steps.length, 5)
  if (count > 0) {
    const stepW = 11.5 / count
    const startX = 0.7
    const y = 2.2

    steps.slice(0, count).forEach((step, i) => {
      const x = startX + i * stepW

      slide.addShape(pptx.ShapeType.ellipse, {
        x: x + stepW / 2 - 0.3, y, w: 0.6, h: 0.6,
        fill: { color: i % 2 === 0 ? presentationTheme().ember : presentationTheme().cyan },
        line: { color: i % 2 === 0 ? presentationTheme().ember : presentationTheme().cyan, width: 0 },
      })
      slide.addText(String(i + 1), {
        x: x + stepW / 2 - 0.3, y, w: 0.6, h: 0.6,
        fontFace: 'Calibri', fontSize: 16, bold: true, color: presentationTheme().white,
        align: 'center', valign: 'middle', margin: 0,
      })

      slide.addText(step.name, {
        x, y: y + 0.8, w: stepW - 0.2, h: 0.5,
        fontFace: 'Calibri', fontSize: 14, bold: true, color: presentationTheme().ink,
        align: 'center', margin: 0,
      })

      if (step.desc) {
        slide.addText(step.desc, {
          x, y: y + 1.3, w: stepW - 0.2, h: 1.5,
          fontFace: 'Calibri', fontSize: 11, color: presentationTheme().inkSoft,
          align: 'center', margin: 0,
        })
      }

      if (i < count - 1) {
        slide.addShape(pptx.ShapeType.rect, {
          x: x + stepW - 0.15, y: y + 0.25, w: 0.3, h: 0.04,
          fill: { color: presentationTheme().skeleton },
          line: { color: presentationTheme().skeleton, width: 0 },
        })
        slide.addShape(pptx.ShapeType.triangle, {
          x: x + stepW + 0.05, y: y + 0.18, w: 0.12, h: 0.18,
          fill: { color: presentationTheme().skeleton },
          line: { color: presentationTheme().skeleton, width: 0 },
        })
      }
    })
  }
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Chart \u2500\u2500 */
// \u7528 pptxgenjs \u539f\u751f addChart \u753b\u67f1/\u6298/\u997c.\u8c03\u8272\u677f\u4ece\u4e3b\u9898 accent \u6d3e\u751f,\u4fdd\u6301\u89c6\u89c9\u4e00\u81f4.

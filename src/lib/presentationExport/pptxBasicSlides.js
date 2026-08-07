import { addAmbientDecor, addBottomLine, addPageNumber } from './pptxSlideChrome.js'
import { SLIDE_H, SLIDE_W } from './pptxConstants.js'
import { presentationTheme } from './pptxThemeState.js'

export function addCoverSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 135,
      stops: [{ color: presentationTheme().paper, position: 0 }, { color: presentationTheme().paper2, position: 100 }],
    },
    line: { color: presentationTheme().paper, width: 0 },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: 0.35,
    fill: { color: presentationTheme().ember },
    line: { color: presentationTheme().ember, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.2, y: -1.8, w: 4.8, h: 4.8,
    fill: { color: presentationTheme().ember, transparency: 85 },
    line: { color: presentationTheme().ember, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: -0.9, y: 5.3, w: 2.8, h: 2.8,
    fill: { color: presentationTheme().cyan, transparency: 88 },
    line: { color: presentationTheme().cyan, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 1, y: 2.2, w: 11.3, h: 1.2,
    fontFace: 'Calibri', fontSize: 44, bold: true, color: presentationTheme().ink,
    align: 'center', margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 1, y: 3.6, w: 11.3, h: 0.6,
      fontFace: 'Calibri', fontSize: 20, color: presentationTheme().inkSoft,
      align: 'center', margin: 0,
    })
  }
  slide.addText(new Date().toLocaleDateString('zh-CN'), {
    x: 1, y: 4.4, w: 11.3, h: 0.4,
    fontFace: 'Calibri', fontSize: 12, color: presentationTheme().inkFade,
    align: 'center', margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 5.5, y: 6.8, w: 2.333, h: 0.04,
    fill: { color: presentationTheme().ember },
    line: { color: presentationTheme().ember, width: 0 },
  })
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 TOC \u2500\u2500 */

export function addTocSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: presentationTheme().paper }
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 3.6, h: SLIDE_H,
    fill: { color: presentationTheme().cyan },
    line: { color: presentationTheme().cyan, width: 0 },
  })
  slide.addText('\u76ee\u5f55', {
    x: 0.5, y: 2.8, w: 2.6, h: 1,
    fontFace: 'Calibri', fontSize: 32, bold: true, color: presentationTheme().white, margin: 0,
  })
  slide.addText('CONTENTS', {
    x: 0.5, y: 3.6, w: 2.6, h: 0.4,
    fontFace: 'Calibri', fontSize: 11, color: 'B8D4DB', margin: 0,
  })
  slideData.bullets.forEach((bullet, i) => {
    const yBase = 1.2 + i * 0.85
    slide.addText(String(i + 1).padStart(2, '0'), {
      x: 4.2, y: yBase, w: 0.8, h: 0.4,
      fontFace: 'Calibri', fontSize: 22, bold: true, color: presentationTheme().ember, margin: 0,
    })
    slide.addText(bullet, {
      x: 5.1, y: yBase + 0.05, w: 7.5, h: 0.5,
      fontFace: 'Calibri', fontSize: 18, color: presentationTheme().ink, margin: 0,
    })
    if (i < slideData.bullets.length - 1) {
      slide.addShape(pptx.ShapeType.rect, {
        x: 5.1, y: yBase + 0.65, w: 7.5, h: 0.01,
        fill: { color: presentationTheme().skeleton },
        line: { color: presentationTheme().skeleton, width: 0 },
      })
    }
  })
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Content \u2500\u2500 */

export function addContentSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  const accentColor = index % 2 === 0 ? presentationTheme().ember : presentationTheme().cyan
  slide.background = { color: presentationTheme().paper }
  addAmbientDecor(slide, pptx, index)
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.12, h: SLIDE_H,
    fill: { color: accentColor },
    line: { color: accentColor, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: presentationTheme().ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: accentColor },
    line: { color: accentColor, width: 0 },
  })
  if (slideData.bullets.length) {
    slide.addText(
      slideData.bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 10 },
      })),
      {
        x: 0.95, y: 1.5, w: 11.35, h: 5.2,
        fontFace: 'Calibri', fontSize: 18, color: presentationTheme().inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Image \u2500\u2500 */

export function addImageSlide(pptx, slideData, index, total) {
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
  if (slideData.bullets.length) {
    slide.addText(
      slideData.bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 8 },
      })),
      {
        x: 0.95, y: 1.5, w: 6.5, h: 5.2,
        fontFace: 'Calibri', fontSize: 17, color: presentationTheme().inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }
  const imgX = 7.8
  const imgY = 1.5
  const imgW = 4.8
  const imgH = 4.5
  slide.addShape(pptx.ShapeType.rect, {
    x: imgX, y: imgY, w: imgW, h: imgH,
    fill: { color: 'F8F4EC' },
    line: { color: 'C9BFA8', width: 1.5, dashType: 'dash' },
  })
  slide.addText(`[ ${slideData.images?.[0]?.alt || '\u914d\u56fe\u5efa\u8bae'} ]`, {
    x: imgX, y: imgY + imgH / 2 - 0.3, w: imgW, h: 0.6,
    fontFace: 'Calibri', fontSize: 14, color: presentationTheme().inkFade,
    align: 'center', valign: 'middle', margin: 0,
  })
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 End \u2500\u2500 */

export function addEndSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 315,
      stops: [{ color: presentationTheme().paper, position: 0 }, { color: presentationTheme().paper2, position: 100 }],
    },
    line: { color: presentationTheme().paper, width: 0 },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: SLIDE_H - 0.35, w: SLIDE_W, h: 0.35,
    fill: { color: presentationTheme().cyan },
    line: { color: presentationTheme().cyan, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: -1.6, y: -1.6, w: 4.2, h: 4.2,
    fill: { color: presentationTheme().cyan, transparency: 85 },
    line: { color: presentationTheme().cyan, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.8, y: 5.3, w: 2.8, h: 2.8,
    fill: { color: presentationTheme().ember, transparency: 88 },
    line: { color: presentationTheme().ember, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 1, y: 2.4, w: 11.3, h: 1.2,
    fontFace: 'Calibri', fontSize: 40, bold: true, color: presentationTheme().ink,
    align: 'center', margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 1, y: 3.7, w: 11.3, h: 0.6,
      fontFace: 'Calibri', fontSize: 18, color: presentationTheme().inkSoft,
      align: 'center', margin: 0,
    })
  }
  slide.addShape(pptx.ShapeType.rect, {
    x: 5.5, y: 4.5, w: 2.333, h: 0.04,
    fill: { color: presentationTheme().cyan },
    line: { color: presentationTheme().cyan, width: 0 },
  })
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Data \u2500\u2500 */

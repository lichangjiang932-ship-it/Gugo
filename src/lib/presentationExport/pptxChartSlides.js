import { addAmbientDecor, addBottomLine, addPageNumber } from './pptxSlideChrome.js'
import { SLIDE_H, SLIDE_W } from './pptxConstants.js'
import { presentationTheme } from './pptxThemeState.js'

const CHART_PALETTE = [presentationTheme().ember, presentationTheme().cyan, '8A7B68', '4A6B82', 'C97C5D', '3E7A8C']

export function addChartSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: presentationTheme().paper }
  addAmbientDecor(slide, pptx, index)
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.12, h: SLIDE_H,
    fill: { color: presentationTheme().ember }, line: { color: presentationTheme().ember, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 28, bold: true, color: presentationTheme().ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: presentationTheme().ember }, line: { color: presentationTheme().ember, width: 0 },
  })

  const chart = slideData.chart || { type: 'bar', categories: [], series: [] }
  // PR4a: \u6269\u5c55 chart \u7c7b\u578b \u2014 area/scatter/stacked \u8d70 pptxgenjs \u539f\u751f
  const chartType =
    chart.type === 'line' ? pptx.ChartType.line
    : chart.type === 'area' ? pptx.ChartType.area
    : chart.type === 'scatter' ? pptx.ChartType.scatter
    : chart.type === 'pie' ? pptx.ChartType.pie
    : pptx.ChartType.bar
  const isStacked = chart.type === 'stacked'

  let data
  if (chart.type === 'pie') {
    const first = chart.series[0] || { name: '\u5360\u6bd4', values: [] }
    data = [{
      name: first.name,
      labels: chart.categories.length ? chart.categories : first.values.map((_, i) => `\u9879${i + 1}`),
      values: first.values,
    }]
  } else {
    data = chart.series.map((s) => ({
      name: s.name,
      labels: chart.categories.length ? chart.categories : s.values.map((_, i) => String(i + 1)),
      values: s.values,
    }))
  }

  if (data.length && data.some((d) => d.values && d.values.length)) {
    slide.addChart(isStacked ? pptx.ChartType.bar : chartType, data, {
      x: 0.7, y: 1.55, w: 12, h: 5.1,
      chartColors: CHART_PALETTE.slice(0, Math.max(1, data.length)),
      showLegend: data.length > 1 || chart.type === 'pie',
      legendPos: 'b',
      legendFontFace: 'Calibri',
      legendFontSize: 11,
      legendColor: presentationTheme().inkSoft,
      catAxisLabelFontFace: 'Calibri',
      catAxisLabelFontSize: 10,
      catAxisLabelColor: presentationTheme().inkSoft,
      valAxisLabelFontFace: 'Calibri',
      valAxisLabelFontSize: 10,
      valAxisLabelColor: presentationTheme().inkSoft,
      dataLabelColor: presentationTheme().ink,
      dataLabelFontFace: 'Calibri',
      dataLabelFontSize: 10,
      showValue: chart.type === 'pie',
      barGapWidthPct: 60,
      barGrouping: isStacked ? 'stacked' : 'clustered',
      lineDataSymbol: chart.type === 'line' || chart.type === 'area' ? 'circle' : undefined,
      lineDataSymbolSize: chart.type === 'line' || chart.type === 'area' ? 6 : undefined,
      catGridLine: { style: 'none' },
      valGridLine: { color: presentationTheme().skeleton, style: 'solid', size: 0.5 },
    })
  } else {
    slide.addText('\uff08\u56fe\u8868\u6570\u636e\u7f3a\u5931\uff09', {
      x: 0.7, y: 3, w: 12, h: 0.5,
      fontFace: 'Calibri', fontSize: 14, color: presentationTheme().inkFade, align: 'center', margin: 0,
    })
  }

  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Section \u2500\u2500 */

export function addSectionSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 90,
      stops: [{ color: presentationTheme().paper, position: 0 }, { color: presentationTheme().paper2, position: 100 }],
    },
    line: { color: presentationTheme().paper, width: 0 },
  })
  addAmbientDecor(slide, pptx, index, { dense: true })
  const sectionNum = String(index + 1).padStart(2, '0')
  slide.addText(sectionNum, {
    x: 0.5, y: 1.5, w: 4, h: 2,
    fontFace: 'Calibri', fontSize: 96, bold: true, color: presentationTheme().ember, margin: 0,
  })
  slide.addText(slideData.title, {
    x: 0.7, y: 3.5, w: 11, h: 1,
    fontFace: 'Calibri', fontSize: 36, bold: true, color: presentationTheme().ink, margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 0.7, y: 4.6, w: 11, h: 0.6,
      fontFace: 'Calibri', fontSize: 16, color: presentationTheme().inkSoft, margin: 0,
    })
  }
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 4.3, w: 2, h: 0.04,
    fill: { color: presentationTheme().ember },
    line: { color: presentationTheme().ember, width: 0 },
  })
  addPageNumber(slide, index, total)
}

/* \u2500\u2500 Main builder \u2500\u2500 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import PptxSlideCanvas from '../../src/pages/ChatSplit/preview/PptxSlideCanvas.jsx'

const shape = (values = {}) => ({
  kind: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 40, rotation: 0,
  flipH: false, flipV: false, fill: 'none', stroke: 'none', strokeWidth: 0, ...values,
})
const slide = (elements) => ({ title: 'Original timeline', layout: { width: 1280, height: 720, background: 'white', elements } })

function inspect(component, check) {
  const dom = new JSDOM(renderToStaticMarkup(component))
  try { check(dom.window.document) } finally { dom.window.close() }
}

test('timeline primitives retain original positions, line lengths, circle colors and slide ratio', () => {
  const original = slide([
    shape({ shape: 'line', x: 80, y: 360, w: 1120, h: 0, stroke: 'rgba(10,20,30,1)', strokeWidth: 2 }),
    ...[80, 320, 560, 800, 1040].map((x) => shape({ shape: 'ellipse', x, y: 352, w: 16, h: 16, fill: 'rgba(0,130,110,1)' })),
  ])
  inspect(<PptxSlideCanvas slide={original} />, (document) => {
    const canvas = document.querySelector('[data-testid="pptx-original-layout"]')
    assert.equal(canvas.getAttribute('viewBox'), '0 0 1280 720')
    assert.equal(canvas.getAttribute('aria-label'), 'Original timeline')
    assert.equal(canvas.querySelectorAll('ellipse').length, 5)
    assert.equal(canvas.querySelector('line').getAttribute('x2'), '1120')
    assert.equal(canvas.querySelector('line').getAttribute('y2'), '0')
    assert.equal(canvas.querySelector('line').getAttribute('stroke-width'), '2')
    assert.equal(canvas.querySelector('ellipse').getAttribute('fill'), 'rgba(0,130,110,1)')
    assert.match(canvas.querySelector('[data-pptx-shape="ellipse"]').getAttribute('transform'), /^translate\(80 352\)/)
    assert.equal(canvas.querySelector('foreignObject'), null, 'empty shape text creates no foreignObject')
  })
})

test('theme shadows use bounded local filters and the parser standard deviation exactly once', () => {
  const shadow = { dx: -2, dy: 3, blur: 2.1, color: 'rgba(0,0,0,0.38)' }
  const original = slide([shape({ shape: 'ellipse', w: 16, h: 16, shadow, fill: 'white' })])
  inspect(<><PptxSlideCanvas slide={original} /><PptxSlideCanvas slide={original} /></>, (document) => {
    const filters = [...document.querySelectorAll('filter')]
    assert.equal(filters.length, 2)
    assert.notEqual(filters[0].id, filters[1].id, 'multiple open canvases cannot share filter IDs')
    assert.ok(Number(filters[0].getAttribute('x')) < 0)
    assert.ok(Number(filters[0].getAttribute('width')) > 16)
    assert.equal(filters[0].getAttribute('filterUnits'), 'userSpaceOnUse')
    const effect = filters[0].firstElementChild
    assert.equal(effect.localName.toLowerCase(), 'fedropshadow')
    assert.equal(effect.getAttribute('dx'), '-2')
    assert.equal(effect.getAttribute('dy'), '3')
    assert.equal(effect.getAttribute('stdDeviation'), '2.1')
    assert.equal(effect.getAttribute('flood-color'), shadow.color)
    assert.equal(document.querySelector('ellipse').getAttribute('filter'), `url(#${filters[0].id})`)
    assert.equal(document.querySelector('feImage, script, iframe'), null)
  })
})

test('table cell text and borders render independently without introducing template styling', () => {
  const text = { valign: 'center', wrap: true, insets: [4, 8, 4, 8], paragraphs: [{
    style: { fontFamily: 'Arial', fontSize: 18, color: 'black', textAlign: 'center' },
    runs: [{ text: 'A < B', style: { fontWeight: 700 } }],
  }] }
  inspect(<PptxSlideCanvas slide={slide([
    shape({ x: 80, y: 120, w: 160, h: 60, fill: 'rgba(240,246,250,1)', text }),
    shape({ shape: 'line', x: 80, y: 180, w: 160, h: 0, stroke: 'black', strokeWidth: 1,
      strokeDasharray: '4 2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
  ])} />, (document) => {
    assert.equal(document.querySelector('foreignObject').getAttribute('width'), '160')
    assert.equal(document.querySelector('foreignObject span').textContent, 'A < B')
    assert.equal(document.querySelector('foreignObject p').style.textAlign, 'center')
    const line = document.querySelector('line')
    assert.equal(line.getAttribute('stroke-dasharray'), '4 2')
    assert.equal(line.getAttribute('stroke-linecap'), 'round')
    assert.equal(line.getAttribute('stroke-linejoin'), 'round')
    assert.equal(document.querySelector('filter, iframe, style, script'), null)
  })
})

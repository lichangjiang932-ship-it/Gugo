import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { collectEditableTextNodes, collectHtmlDeckSlides } from '../src/lib/htmlSlidesToPptx.js'

test('collectHtmlDeckSlides accepts non-standard page classes and normalizes them to .slide', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="deck-page"><h1>One</h1></div>
    <div class="deck-page"><h1>Two</h1></div>
  </body>`)

  const slides = collectHtmlDeckSlides(dom.window.document)

  assert.equal(slides.length, 2)
  assert.equal(slides[0].classList.contains('slide'), true)
  assert.equal(slides[0].dataset.slide, '1')
  assert.equal(slides[1].dataset.slide, '2')
})

test('collectHtmlDeckSlides keeps outer slide when it contains nested sections', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <section class="slide"><section><h2>Nested card</h2></section></section>
    <section class="slide"><h1>Second</h1></section>
  </body>`)

  const slides = collectHtmlDeckSlides(dom.window.document)

  assert.equal(slides.length, 2)
  assert.match(slides[0].textContent, /Nested card/)
  assert.match(slides[1].textContent, /Second/)
})

test('editable text collection never overlays inline emphasis on its parent paragraph', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <section class="slide">
      <h1><span>One clear title</span></h1>
      <ul><li><p><strong>Claim</strong> with one evidence line</p></li></ul>
      <div class="kpi-num"><strong>42%</strong></div>
    </section>
  </body>`)
  const slide = dom.window.document.querySelector('.slide')
  const nodes = collectEditableTextNodes(slide)
  const texts = nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim())

  assert.deepEqual(texts, ['One clear title', 'Claim with one evidence line', '42%'])
  assert.equal(nodes.some((node) => node.tagName === 'STRONG'), false)
})

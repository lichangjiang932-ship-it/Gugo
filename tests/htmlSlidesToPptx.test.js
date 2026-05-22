import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { collectHtmlDeckSlides } from '../src/lib/htmlSlidesToPptx.js'

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

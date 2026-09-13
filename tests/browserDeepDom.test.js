import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { _browserInternals } from '../server/adapters/browserAutomation.js'

function visible(element) {
  element.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 20, bottom: 20, width: 20, height: 20,
  })
  return element
}

test('browser snapshot and element lookup traverse open shadow roots and same-origin iframes', () => {
  const dom = new JSDOM(`<!doctype html><html><head><title>Deep DOM</title></head><body>
    <button id="main-action">Main action</button>
    <section id="shadow-host"></section>
    <iframe id="child-frame"></iframe>
  </body></html>`, {
    url: 'https://example.test/root',
    runScripts: 'outside-only',
  })
  const { document } = dom.window
  visible(document.getElementById('main-action'))

  const shadow = document.getElementById('shadow-host').attachShadow({ mode: 'open' })
  shadow.innerHTML = '<button class="shadow-action">Shadow action</button><input class="shadow-file" type="file">'
  visible(shadow.querySelector('.shadow-action'))
  visible(shadow.querySelector('.shadow-file'))

  const frameDocument = document.getElementById('child-frame').contentDocument
  frameDocument.body.innerHTML = '<button class="frame-action">Frame action</button>'
  visible(frameDocument.querySelector('.frame-action'))

  try {
    const snapshot = dom.window.eval(_browserInternals.browserSnapshotExpression(12_000))
    assert.equal(snapshot.title, 'Deep DOM')
    assert.equal(snapshot.traversalTruncated, false)
    assert.equal(snapshot.frames.length, 1)
    assert.equal(snapshot.frames[0].accessible, true)
    assert.match(snapshot.elements.join('\n'), /\[main\].*Main action/)
    assert.match(snapshot.elements.join('\n'), /shadow\(section\).*Shadow action/)
    assert.match(snapshot.elements.join('\n'), /iframe\(about:blank\).*Frame action/)

    const shadowRef = shadow.querySelector('.shadow-action').getAttribute('data-yma-ref')
    const frameRef = frameDocument.querySelector('.frame-action').getAttribute('data-yma-ref')
    assert.ok(shadowRef)
    assert.ok(frameRef)

    const shadowResult = dom.window.eval(_browserInternals.elementExpression(
      shadowRef,
      "el.setAttribute('data-clicked', 'yes'); return {ok:true, text:el.textContent}",
    ))
    assert.equal(shadowResult.ok, true)
    assert.equal(shadowResult.text, 'Shadow action')
    assert.equal(shadow.querySelector('.shadow-action').getAttribute('data-clicked'), 'yes')

    const frameResult = dom.window.eval(_browserInternals.elementExpression(
      '.frame-action',
      "el.setAttribute('data-clicked', 'yes'); return {ok:true, text:el.textContent}",
    ))
    assert.equal(frameResult.ok, true)
    assert.equal(frameResult.text, 'Frame action')
    assert.equal(frameDocument.querySelector('.frame-action').getAttribute('data-clicked'), 'yes')
  } finally {
    dom.window.close()
  }
})

test('deep DOM traversal is bounded and reports truncation', () => {
  const items = Array.from({ length: 10_100 }, (_, index) => `<span>${index}</span>`).join('')
  const dom = new JSDOM(`<!doctype html><body>${items}</body>`, {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  })
  try {
    const snapshot = dom.window.eval(_browserInternals.browserSnapshotExpression(1_000))
    assert.equal(snapshot.traversalTruncated, true)
    assert.equal(snapshot.elements.length, 0)
  } finally {
    dom.window.close()
  }
})

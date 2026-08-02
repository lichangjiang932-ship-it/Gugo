import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  buildHtmlDocument,
  enhanceHtmlPreviewReadability,
} from '../src/lib/artifactPreview.js'

test('injects an idempotent readability guard into generated HTML previews', () => {
  const source = '<!doctype html><html><head></head><body><p style="color:#f1f5f9;opacity:.2">Too faint</p></body></html>'
  const guarded = enhanceHtmlPreviewReadability(source)
  const guardedTwice = enhanceHtmlPreviewReadability(guarded)

  assert.match(guarded, /data-yma-readability-guard="true"/)
  assert.match(guarded, /MIN_CONTRAST = 2\.65/)
  assert.match(guarded, /data-yma-contrast-fixed/)
  assert.equal((guardedTwice.match(/data-yma-readability-guard/g) || []).length, 1)
})

test('buildHtmlDocument protects complete documents and fragments', () => {
  const complete = buildHtmlDocument('<!doctype html><html><body><p>Complete</p></body></html>')
  const fragment = buildHtmlDocument('<main><p>Fragment</p></main>')

  assert.match(complete, /data-yma-readability-guard="true"/)
  assert.match(fragment, /data-yma-readability-guard="true"/)
})

test('readability guard repairs faint text without changing readable text', async () => {
  const documentHtml = buildHtmlDocument(`
    <main style="background:rgb(248,250,252)">
      <p id="faint" style="color:rgb(241,245,249);opacity:0.2">Faint text</p>
      <p id="readable" style="color:rgb(71,85,105)">Readable text</p>
    </main>
  `)
  const dom = new JSDOM(documentHtml, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  })

  try {
    await new Promise((resolve) => setTimeout(resolve, 240))
    const faint = dom.window.document.getElementById('faint')
    const readable = dom.window.document.getElementById('readable')

    assert.equal(faint.getAttribute('data-yma-contrast-fixed'), 'true')
    assert.match(faint.style.getPropertyValue('color'), /^(?:#374151|rgb\(55, 65, 81\))$/)
    assert.equal(faint.style.getPropertyPriority('color'), 'important')
    assert.equal(readable.hasAttribute('data-yma-contrast-fixed'), false)
  } finally {
    dom.window.close()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  buildChartDocument,
  buildHtmlDocument,
  buildMermaidDocument,
  buildMultiHtmlDocument,
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

test('preview-owned scripts receive a validated response nonce without authorizing source scripts', () => {
  const html = buildHtmlDocument(`
    <script data-user-script>window.userScriptRan = true</script>
    <section class="slide active">One</section>
    <section class="slide">Two</section>
  `, { nonce: 'abcDEF0123+/=' })

  assert.match(html, /<script nonce="abcDEF0123\+\/=" data-yma-readability-guard="true">/)
  assert.match(html, /<script nonce="abcDEF0123\+\/=" data-yma-deck-enhancer="script">/)
  assert.match(html, /<script data-user-script>/)
  assert.doesNotMatch(html, /<script nonce="abcDEF0123\+\/=" data-user-script>/)

  const rejected = buildHtmlDocument('<p>Unsafe nonce</p>', { nonce: '"><script>alert(1)</script>' })
  assert.doesNotMatch(rejected, /nonce=/)
})

test('prebuilt multi-file previews refresh only Gugo-owned helper nonces', () => {
  const nonce = 'multiPreviewNonce123+/='
  const prebuilt = buildMultiHtmlDocument({
    'index.html': '<section class="slide active">One</section><section class="slide">Two</section>',
    'app.js': 'window.multiFileUserScript = true',
  })
  const html = buildHtmlDocument(prebuilt, { nonce })

  assert.match(html, new RegExp(`<script nonce="${nonce.replace(/[+/]/g, '\\$&')}" data-yma-readability-guard="true">`))
  assert.match(html, new RegExp(`<script nonce="${nonce.replace(/[+/]/g, '\\$&')}" data-yma-deck-enhancer="script">`))
  assert.match(html, /<script>window\.multiFileUserScript = true<\/script>/)
  assert.doesNotMatch(html, /<script nonce="multiPreviewNonce123\+\/=">window\.multiFileUserScript/)
})

test('trusted Mermaid and Chart previews nonce only their generated scripts', () => {
  const nonce = 'visualPreviewNonce123+/='
  const mermaid = buildHtmlDocument(buildMermaidDocument('flowchart TD\nA-->B'), {
    nonce,
    previewType: 'mermaid',
  })
  const chart = buildHtmlDocument(buildChartDocument({
    type: 'bar',
    data: { labels: ['A'], datasets: [{ data: [1] }] },
  }), {
    nonce,
    previewType: 'chart',
  })

  for (const marker of ['mermaid-library', 'mermaid-init']) {
    assert.match(mermaid, new RegExp(`<script nonce="visualPreviewNonce123\\+\\/=" data-yma-preview-script="${marker}"`))
  }
  for (const marker of ['chart-library', 'chart-init']) {
    assert.match(chart, new RegExp(`<script nonce="visualPreviewNonce123\\+\\/=" data-yma-preview-script="${marker}"`))
  }

  const spoofed = buildHtmlDocument(
    '<script data-yma-preview-script="mermaid-init">alert(1)</script>',
    { nonce, previewType: 'mermaid' },
  )
  assert.match(spoofed, /<script data-yma-preview-script="mermaid-init">alert\(1\)<\/script>/)
  assert.doesNotMatch(
    spoofed,
    /<script(?=[^>]*\bnonce=)(?=[^>]*data-yma-preview-script="mermaid-init")[^>]*>/,
  )
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

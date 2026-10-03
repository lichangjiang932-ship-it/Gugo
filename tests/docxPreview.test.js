import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOCX_PREVIEW_CSP,
  DOCX_PREVIEW_OPTIONS,
  buildDocxSrcdoc,
} from '../src/lib/docxPreview.js'

test('the docx frame document is self-contained and locked down', () => {
  const srcdoc = buildDocxSrcdoc({
    bodyHtml: '<section class="docx"><table><tr><td>cell</td></tr></table></section>',
    styleText: '.docx { color: #204060; }',
    title: 'layout-fixture.docx',
  })
  // Nothing may be fetched at render time: the document must work offline and
  // a hostile .docx must not be able to call out.
  assert.match(srcdoc, /default-src 'none'/u)
  assert.match(srcdoc, /img-src data:/u)
  assert.match(DOCX_PREVIEW_CSP, /style-src 'unsafe-inline'/u)
  // Styles and body must live in one document, with the rules before the markup.
  assert.equal(srcdoc.split('<style>').length, 2, 'exactly one style block')
  assert.ok(srcdoc.indexOf('<style>') < srcdoc.indexOf('<body>'))
  assert.match(srcdoc, /#204060/u)
  assert.match(srcdoc, /<section class="docx">/u)
  assert.match(srcdoc, /^<!doctype html>/u)
})

test('a hostile document title cannot break out of the title element', () => {
  const srcdoc = buildDocxSrcdoc({ title: '</title><script>alert(1)</script>' })
  assert.doesNotMatch(srcdoc, /<script/u)
  assert.doesNotMatch(srcdoc, /<\/title><script/u)
})

test('preview options keep page boundaries and inline images', () => {
  // breakPages -> one <section> per Word page; useBase64URL -> images become
  // data: URLs, which is what makes the sandboxed frame work without network.
  assert.equal(DOCX_PREVIEW_OPTIONS.breakPages, true)
  assert.equal(DOCX_PREVIEW_OPTIONS.useBase64URL, true)
  assert.equal(DOCX_PREVIEW_OPTIONS.inWrapper, false)
  assert.equal(DOCX_PREVIEW_OPTIONS.className, 'docx')
  assert.equal(DOCX_PREVIEW_OPTIONS.renderHeaders, true)
  assert.equal(DOCX_PREVIEW_OPTIONS.renderFooters, true)
  assert.ok(Object.isFrozen(DOCX_PREVIEW_OPTIONS))
})

test('the document flows into the pane instead of keeping its own page box', () => {
  // The library otherwise writes the document's page width onto every section as
  // an inline pixel width, which overflows a side panel narrower than A4, and a
  // minimum height that pads short documents with a tall empty block.
  assert.equal(DOCX_PREVIEW_OPTIONS.ignoreWidth, true)
  assert.equal(DOCX_PREVIEW_OPTIONS.ignoreHeight, true)
  // Page boundaries must survive the reflow: this is the visible page break.
  assert.equal(DOCX_PREVIEW_OPTIONS.breakPages, true)
  const srcdoc = buildDocxSrcdoc({ bodyHtml: '<section class="docx"></section>' })
  assert.match(srcdoc, /section\.docx\{width:100%/u)
  assert.match(srcdoc, /\.docx img,\.docx svg\{max-width:100%/u)
})

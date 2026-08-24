import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import MarkdownRenderer from '../../src/components/MarkdownRenderer.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

test('MarkdownRenderer emits highlighted tokens inside a semantic code-block shell', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)

  await act(async () => {
    root.render(
      <MarkdownRenderer>{'```js\nconst answer = "ready"\n```'}</MarkdownRenderer>,
    )
  })

  try {
    const shell = rootElement.querySelector('.chat-code-block')
    assert.ok(shell)
    assert.match(shell.className, /border-ink\/10/)
    assert.match(shell.className, /bg-paper-2\/70/)
    assert.doesNotMatch(shell.className, /(?:border|bg|text)-neutral-/)
    assert.ok(shell.querySelector('.chat-code-block-header'))
    assert.ok(shell.querySelector('pre.chat-code-scroll'))

    const highlighted = shell.querySelector('code.hljs.language-js')
    assert.ok(highlighted)
    assert.equal(highlighted.querySelector('.hljs-keyword')?.textContent, 'const')
    assert.equal(highlighted.querySelector('.hljs-string')?.textContent, '"ready"')
    assert.equal(shell.querySelectorAll('button').length, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

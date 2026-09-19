import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatMessages from '../../src/pages/ChatSplit/ChatMessages.jsx'

async function fixture(run) {
  const dom = new JSDOM('<!doctype html><div id="root"></div><p id="outside">private panel text</p>', { url: 'http://localhost/' })
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 50, left: 10, width: 40 })
  const root = createRoot(document.getElementById('root'))
  const quotes = []
  const messages = [
    { id: 'user-quote', role: 'user', content: 'User message', timestamp: 1 },
    { id: 'assistant-quote', role: 'assistant', content: 'A useful paragraph for copying.', timestamp: 2, meta: {} },
  ]
  try {
    await act(async () => root.render(<ChatMessages messages={messages} onQuoteSelection={(text) => quotes.push(text)} />))
    await run({ dom, quotes })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
}

function selectText(node, start = 0, end = node.textContent.length) {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  window.getSelection().removeAllRanges()
  window.getSelection().addRange(range)
}

test('selecting and copying text never opens an automatic quote overlay or changes the draft', async () => {
  await fixture(async ({ dom, quotes }) => {
    selectText(document.querySelector('#message-assistant-quote [data-quotable="true"] p').firstChild, 2, 18)
    const selected = window.getSelection().toString()
    await act(async () => {
      document.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }))
      document.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'c', ctrlKey: true, bubbles: true }))
    })
    assert.equal(document.querySelector('button.absolute.z-20'), null)
    assert.equal(window.getSelection().toString(), selected)
    assert.deepEqual(quotes, [])
  })
})

test('explicit quote uses only this message selection, otherwise its body, without submitting', async () => {
  await fixture(async ({ dom, quotes }) => {
    const row = document.getElementById('message-assistant-quote')
    const button = row.querySelector('[data-testid="quote-message"]')
    assert.ok(button, 'quote is an explicit message action')
    selectText(row.querySelector('[data-quotable="true"] p').firstChild, 2, 18)
    await act(async () => {
      const down = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
      button.dispatchEvent(down)
      assert.equal(down.defaultPrevented, true, 'retain the selection until the deliberate click')
      button.click()
    })
    assert.deepEqual(quotes, ['useful paragraph'])
    assert.equal(window.getSelection().isCollapsed, true)

    selectText(document.getElementById('outside').firstChild)
    await act(async () => button.click())
    assert.deepEqual(quotes, ['useful paragraph', 'A useful paragraph for copying.'])
    assert.equal(window.getSelection().toString(), 'private panel text', 'unrelated selection is untouched')

    window.getSelection().removeAllRanges()
    const userButton = document.getElementById('message-user-quote').querySelector('[data-testid="quote-message"]')
    await act(async () => userButton.click())
    assert.equal(quotes.at(-1), 'User message')
  })
})

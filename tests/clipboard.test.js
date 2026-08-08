import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { copyTextToClipboard } from '../src/lib/clipboard.js'

test('copyTextToClipboard prefers the trusted desktop bridge', async () => {
  const writes = []
  const result = await copyTextToClipboard('desktop', {
    desktopBridge: { writeClipboardText: async (text) => writes.push(text) },
    navigatorObject: { clipboard: { writeText: async () => { throw new Error('must not run') } } },
    documentObject: null,
  })

  assert.equal(result, true)
  assert.deepEqual(writes, ['desktop'])
})

test('copyTextToClipboard uses the Clipboard API when it succeeds', async () => {
  const writes = []
  const result = await copyTextToClipboard('hello', {
    desktopBridge: null,
    navigatorObject: { clipboard: { writeText: async (text) => writes.push(text) } },
    documentObject: null,
  })

  assert.equal(result, true)
  assert.deepEqual(writes, ['hello'])
})

test('copyTextToClipboard falls back when Clipboard API is unavailable or denied', async (t) => {
  for (const navigatorObject of [
    {},
    { clipboard: { writeText: async () => { throw new Error('denied') } } },
  ]) {
    await t.test(navigatorObject.clipboard ? 'denied' : 'unavailable', async () => {
      const dom = new JSDOM('<!doctype html><html><body><button id="focus">focus</button></body></html>')
      const button = dom.window.document.getElementById('focus')
      button.focus()
      let selectedText = ''
      dom.window.document.execCommand = (command) => {
        assert.equal(command, 'copy')
        selectedText = dom.window.document.querySelector('textarea').value
        return true
      }

      try {
        assert.equal(await copyTextToClipboard('fallback', {
          desktopBridge: null,
          navigatorObject,
          documentObject: dom.window.document,
        }), true)
        assert.equal(selectedText, 'fallback')
        assert.equal(dom.window.document.querySelector('textarea'), null)
        assert.equal(dom.window.document.activeElement, button)
      } finally {
        dom.window.close()
      }
    })
  }
})

test('copyTextToClipboard reports failure when neither strategy can copy', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  dom.window.document.execCommand = () => false
  try {
    await assert.rejects(
      copyTextToClipboard('nope', {
        desktopBridge: null,
        navigatorObject: {},
        documentObject: dom.window.document,
      }),
      /Clipboard copy failed/,
    )
    assert.equal(dom.window.document.querySelector('textarea'), null)
  } finally {
    dom.window.close()
  }
})

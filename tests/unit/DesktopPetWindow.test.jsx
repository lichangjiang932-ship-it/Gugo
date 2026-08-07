import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import DesktopPetWindow from '../../src/pages/ChatSplit/DesktopPetWindow.jsx'

function pointerEvent(dom, type, values) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  return event
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5180/?gugoPet=1',
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  })
  Object.defineProperty(dom.window.document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.PointerEvent = dom.window.MouseEvent
  globalThis.CustomEvent = dom.window.CustomEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.localStorage.setItem('lang', 'en')
  return dom
}

test('standalone desktop pet releases pointer capture on blur and opens the native close menu', async () => {
  const dom = setupDom()
  const dragMessages = []
  let mainCancel = null
  let menuRequests = 0
  let unsubscribed = 0
  dom.window.gugoDesktop = {
    dragPetWindow: (payload) => dragMessages.push(payload),
    getPetState: async () => ({ visible: true, status: { kind: 'idle', tool: '' } }),
    onPetState: () => () => {},
    onPetDragCancel: (callback) => {
      mainCancel = callback
      return () => { unsubscribed += 1 }
    },
    resizePetWindow: async () => ({}),
    showPetMenu: async () => { menuRequests += 1 },
  }

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<I18nProvider><DesktopPetWindow /></I18nProvider>)
    })

    const pet = rootElement.querySelector('.pet-window-root')
    assert.ok(pet)
    let capturedPointer = null
    let releaseCount = 0
    pet.setPointerCapture = (pointerId) => { capturedPointer = pointerId }
    pet.hasPointerCapture = (pointerId) => capturedPointer === pointerId
    pet.releasePointerCapture = (pointerId) => {
      if (capturedPointer === pointerId) capturedPointer = null
      releaseCount += 1
    }

    await act(async () => {
      pet.dispatchEvent(pointerEvent(dom, 'pointerdown', {
        pointerId: 7, pointerType: 'mouse', button: 0, screenX: 100, screenY: 100,
      }))
    })
    assert.equal(capturedPointer, null, 'a simple click must not capture the system pointer')
    assert.equal(dragMessages.at(-1).phase, 'start')

    await act(async () => {
      pet.dispatchEvent(pointerEvent(dom, 'pointermove', {
        pointerId: 7, pointerType: 'mouse', button: 0, screenX: 112, screenY: 108,
      }))
    })
    assert.equal(capturedPointer, 7, 'capture begins only after the drag threshold')
    assert.equal(dragMessages.at(-1).phase, 'move')

    await act(async () => dom.window.dispatchEvent(new dom.window.Event('blur')))
    assert.equal(capturedPointer, null)
    assert.equal(releaseCount, 1)
    assert.equal(dragMessages.at(-1).phase, 'end')

    await act(async () => {
      pet.dispatchEvent(pointerEvent(dom, 'pointerdown', {
        pointerId: 9, pointerType: 'mouse', button: 0, screenX: 40, screenY: 40,
      }))
      pet.dispatchEvent(pointerEvent(dom, 'pointermove', {
        pointerId: 9, pointerType: 'mouse', button: 0, screenX: 52, screenY: 40,
      }))
    })
    assert.equal(capturedPointer, 9)
    await act(async () => mainCancel())
    assert.equal(capturedPointer, null, 'the Electron main-process fallback must release renderer capture')
    assert.equal(dragMessages.at(-1).phase, 'end')

    const menuEvent = new dom.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    })
    await act(async () => pet.dispatchEvent(menuEvent))
    assert.equal(menuEvent.defaultPrevented, true)
    assert.equal(menuRequests, 1)
  } finally {
    await act(async () => root.unmount())
    assert.equal(unsubscribed, 1)
    dom.window.close()
  }
})

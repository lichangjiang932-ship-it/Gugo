import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import DesktopPet from '../../src/pages/ChatSplit/DesktopPet.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { translations } from '../../src/i18n/translations.js'
import {
  DESKTOP_PET_POSITION_KEY,
  clampDesktopPetPosition,
  deriveDesktopPetStatus,
} from '../../src/pages/ChatSplit/desktopPetState.js'

function setupDom({ width = 800, height = 600 } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, writable: true, value: height })
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.PointerEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function pointerEvent(dom, type, values) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  return event
}

test('desktop pet derives idle, thinking, tool, completed, and failed work states', () => {
  assert.equal(deriveDesktopPetStatus().kind, 'idle')
  assert.equal(deriveDesktopPetStatus({ isGenerating: true }).kind, 'thinking')
  assert.deepEqual(
    deriveDesktopPetStatus({
      isGenerating: true,
      messages: [{ role: 'assistant', meta: { toolCalls: [{ name: 'read_file', status: 'running' }] } }],
    }),
    { kind: 'tool', tool: 'read_file' },
  )
  assert.equal(deriveDesktopPetStatus({ tasks: [{ status: 'completed' }] }).kind, 'completed')
  assert.equal(
    deriveDesktopPetStatus({
      isGenerating: true,
      tasks: [{ status: 'failed' }],
      messages: [{ role: 'assistant', meta: { toolCalls: [{ name: 'bash_exec', status: 'running' }] } }],
    }).kind,
    'failed',
  )
})

test('desktop pet status and accessibility copy exists in all supported languages', () => {
  const expectedStatuses = ['completed', 'failed', 'idle', 'thinking', 'tool']
  for (const language of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    const copy = translations[language].desktopPet
    assert.equal(typeof copy.close, 'string')
    assert.equal(typeof copy.handle, 'string')
    assert.equal(typeof copy.unknownTool, 'string')
    assert.deepEqual(Object.keys(copy.status).sort(), expectedStatuses)
    assert.match(copy.status.tool, /\{tool\}/)
  }
})

test('desktop pet position clamp keeps the handle inside the viewport', () => {
  assert.deepEqual(clampDesktopPetPosition({ x: -100, y: 999 }, { width: 320, height: 240 }), { x: 16, y: 168 })
  assert.deepEqual(clampDesktopPetPosition({ x: 90, y: 80 }, { width: 320, height: 240 }), { x: 90, y: 80 })
})

test('desktop pet supports pointer dragging, persistence, resize clamping, and click suppression', async () => {
  const dom = setupDom()
  dom.window.localStorage.setItem(DESKTOP_PET_POSITION_KEY, JSON.stringify({ x: 120, y: 100 }))
  dom.window.localStorage.setItem('lang', 'en')
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  let closed = 0

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <DesktopPet onClose={() => { closed += 1 }} isGenerating />
        </I18nProvider>,
      )
    })

    const pet = rootElement.querySelector('[data-testid="desktop-pet"]')
    const handle = rootElement.querySelector('[data-testid="desktop-pet-handle"]')
    assert.ok(pet)
    assert.ok(handle)
    assert.equal(pet.dataset.status, 'thinking')
    assert.equal(pet.style.left, '120px')
    assert.equal(pet.style.top, '100px')
    assert.equal(rootElement.querySelector('[role="status"]').getAttribute('aria-live'), 'polite')
    assert.equal(rootElement.querySelector('[data-testid="desktop-pet-status"]').textContent, 'Thinking')
    assert.match(handle.getAttribute('aria-label'), /Thinking.*Drag to move/)

    await act(async () => {
      root.render(
        <I18nProvider>
          <DesktopPet
            onClose={() => { closed += 1 }}
            isGenerating
            messages={[{ role: 'assistant', meta: { toolCalls: [{ name: 'read_file', status: 'running' }] } }]}
          />
        </I18nProvider>,
      )
    })
    assert.equal(pet.dataset.status, 'tool')
    assert.equal(rootElement.querySelector('[data-testid="desktop-pet-status"]').textContent, 'Using read_file')

    handle.setPointerCapture = () => {}
    handle.releasePointerCapture = () => {}
    await act(async () => {
      handle.dispatchEvent(pointerEvent(dom, 'pointerdown', {
        pointerId: 7, pointerType: 'mouse', button: 0, clientX: 120, clientY: 100,
      }))
      handle.dispatchEvent(pointerEvent(dom, 'pointermove', {
        pointerId: 7, pointerType: 'mouse', button: 0, clientX: 320, clientY: 240,
      }))
      handle.dispatchEvent(pointerEvent(dom, 'pointerup', {
        pointerId: 7, pointerType: 'mouse', button: 0, clientX: 320, clientY: 240,
      }))
      handle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(pet.style.left, '320px')
    assert.equal(pet.style.top, '240px')
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(DESKTOP_PET_POSITION_KEY)), { x: 320, y: 240 })
    assert.ok(rootElement.querySelector('[data-testid="desktop-pet-status"]'), 'drag end must not toggle the bubble')

    dom.window.innerWidth = 180
    dom.window.innerHeight = 150
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
    assert.equal(pet.style.left, '108px')
    assert.equal(pet.style.top, '78px')

    await act(async () => {
      handle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(rootElement.querySelector('[data-testid="desktop-pet-status"]'), null)

    const close = rootElement.querySelector('button[aria-label="Hide desktop pet"]')
    assert.ok(close)
    await act(async () => close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(closed, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

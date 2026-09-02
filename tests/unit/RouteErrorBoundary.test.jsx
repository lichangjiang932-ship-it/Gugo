import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import RouteErrorBoundary from '../../src/components/RouteErrorBoundary.jsx'
import {
  HashRouter,
  Link,
  Route,
  Routes,
} from '../../src/lib/router.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/broken',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function BrokenPage() {
  throw new Error('broken route')
}

function FallbackShell({ children }) {
  return (
    <div data-testid="persistent-route-shell">
      <Link to="/healthy">Open healthy route</Link>
      {children}
    </div>
  )
}

function Harness() {
  return (
    <>
      <div data-testid="persistent-app-ui">Persistent app UI</div>
      <RouteErrorBoundary fallbackWrapper={FallbackShell}>
        <Routes>
          <Route path="/broken" element={<BrokenPage />} />
          <Route path="/healthy" element={<div data-testid="healthy-route">Healthy route</div>} />
        </Routes>
      </RouteErrorBoundary>
    </>
  )
}

test('route failures preserve app UI and changing routes resets the page boundary', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const originalConsoleError = console.error
  console.error = () => {}

  try {
    await act(async () => root.render(
      <HashRouter>
        <I18nProvider>
          <Harness />
        </I18nProvider>
      </HashRouter>,
    ))

    assert.ok(rootElement.querySelector('[data-testid="persistent-app-ui"]'))
    assert.ok(rootElement.querySelector('[data-testid="persistent-route-shell"]'))
    assert.match(rootElement.textContent, /broken route/)

    const link = rootElement.querySelector('a[href="#/healthy"]')
    assert.ok(link)
    await act(async () => {
      link.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }))
      await Promise.resolve()
    })

    assert.equal(window.location.hash, '#/healthy')
    assert.ok(rootElement.querySelector('[data-testid="persistent-app-ui"]'))
    assert.ok(rootElement.querySelector('[data-testid="healthy-route"]'))
    assert.equal(rootElement.querySelector('[data-testid="persistent-route-shell"]'), null)
    assert.doesNotMatch(rootElement.textContent, /broken route/)
  } finally {
    console.error = originalConsoleError
    await act(async () => root.unmount())
    dom.window.close()
  }
})

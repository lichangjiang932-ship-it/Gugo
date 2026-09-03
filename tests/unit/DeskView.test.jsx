import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/desk',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

test('desk page renders through its application providers', async () => {
  const dom = setupDom()
  const [
    { act },
    { createRoot },
    { HashRouter },
    { default: DeskView },
    { ToastProvider },
    { I18nProvider },
    { AppProvider },
  ] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../../src/lib/router.jsx'),
    import('../../src/pages/DeskView.jsx'),
    import('../../src/components/Toast.jsx'),
    import('../../src/i18n/I18nProvider.jsx'),
    import('../../src/store/AppContext.jsx'),
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ notes: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(
        <HashRouter>
          <I18nProvider>
            <ToastProvider>
              <AppProvider>
                <DeskView />
              </AppProvider>
            </ToastProvider>
          </I18nProvider>
        </HashRouter>,
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    assert.match(rootElement.textContent, /书桌便笺/)
    assert.match(rootElement.textContent, /随手记录，会自动保存/)
    assert.doesNotMatch(rootElement.textContent, /titlesubtitlenewloadingpickOne/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
async function setup(context) {
  const d = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/settings?tab=history' })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'CustomEvent', 'localStorage']) globalThis[key] = key === 'window' ? d.window : d.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: d.window.navigator })
  const [{ act, createRef }, { createRoot }, { translateKey }] = await Promise.all([import('react'), import('react-dom/client'), import('../../src/i18n/translations.js')])
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); d.window.close() })
  return { d, root, act, createRef, t: (key, values) => translateKey(key, 'zh', values) }
}
test('the lower-left menu has settings but no separate history entry or spacer', async context => {
  const f = await setup(context), { default: AccountArea } = await import('../../src/components/leftRail/AccountArea.jsx')
  const navigations = []
  await f.act(async () => f.root.render(<AccountArea accountMenuOpen accountMenuRef={f.createRef()} localWorkspace user={{}} onToggle={() => {}} onNavigate={item => navigations.push(item.path)} t={f.t} />))
  const menu = document.querySelector('[data-left-rail-account-menu]')
  assert.equal([...menu.querySelectorAll('button')].some(button => button.textContent === f.t('nav.history')), false)
  const settings = [...menu.querySelectorAll('button')].find(button => button.textContent === f.t('nav.settings'))
  await f.act(async () => settings.click())
  assert.deepEqual(navigations, ['/settings'])
})
test('history is a supported settings section with a reachable navigation choice', async context => {
  const f = await setup(context)
  const [{ default: Navigation }, routes] = await Promise.all([import('../../src/pages/settingsView/SettingsDialogNavigation.jsx'), import('../../src/lib/settingsNavigation.js')])
  assert.equal(routes.resolveSettingsSectionFromSearch('?tab=history'), 'history')
  const selected = []
  await f.act(async () => f.root.render(<Navigation activeSection="history" contributedSettings={[]} setActiveSection={v => selected.push(v)} t={f.t} />))
  const history = [...document.querySelectorAll('button')].find(button => button.textContent === f.t('nav.history'))
  assert.ok(history)
  assert.equal(history.getAttribute('aria-current'), 'page')
  await f.act(async () => history.click())
  assert.deepEqual(selected, ['history'])
})
test('embedded history reuses records without a nested main, rail or full-screen shell', async context => {
  const f = await setup(context)
  context.mock.method(globalThis, 'fetch', async url => Response.json(String(url) === '/api/auth/bootstrap'
    ? { mode: 'local', authenticated: true, token: 'fixture-only', user: { id: 'fixture-owner' } }
    : { sessions: [], source: null, capabilities: {}, directories: [] }))
  const [{ AppProvider }, { I18nProvider }, { HashRouter }, { default: History }, { HostMotionProvider }] = await Promise.all([
    import('../../src/store/AppContext.jsx'), import('../../src/i18n/I18nProvider.jsx'), import('../../src/lib/router.jsx'), import('../../src/pages/HistoryView.jsx'), import('../../src/lib/hostMotion.js'),
  ])
  await f.act(async () => f.root.render(<I18nProvider><HashRouter><AppProvider><HostMotionProvider enabled={false}><History embedded /></HostMotionProvider></AppProvider></HashRouter></I18nProvider>))
  assert.ok(document.querySelector('[data-testid=settings-history-panel]'))
  assert.equal(document.querySelector('main'), null)
  assert.equal(document.querySelector('aside'), null)
  assert.equal(document.querySelector('[data-testid=settings-history-panel]').classList.contains('h-screen'), false)
})

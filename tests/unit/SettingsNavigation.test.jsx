import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { HashRouter } from '../../src/lib/router.jsx'
import {
  SETTINGS_PAGE_FILES_PERMISSIONS,
  SETTINGS_PAGE_MODEL_SEARCH,
  SETTINGS_TAB_FILES,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_WEB_SEARCH,
} from '../../src/lib/settingsNavigation.js'
import useSettingsNavigation from '../../src/lib/useSettingsNavigation.js'

function setupDom(hash = '#/settings?tab=web-search') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost/${hash}`,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function NavigationHarness() {
  const navigation = useSettingsNavigation()
  return <>
    <output data-testid="page">{navigation.activeNav}</output>
    <output data-testid="section">{navigation.activeSection}</output>
    <button type="button" data-testid="model-page" onClick={() => navigation.setActiveNav(SETTINGS_PAGE_MODEL_SEARCH)}>Models and search</button>
    <button type="button" data-testid="files-page" onClick={() => navigation.setActiveNav(SETTINGS_PAGE_FILES_PERMISSIONS)}>Files and permissions</button>
    <button type="button" data-testid="web-search" onClick={() => navigation.setActiveSection(SETTINGS_TAB_WEB_SEARCH)}>Web search</button>
    <button type="button" data-testid="permissions" onClick={() => navigation.setActiveSection(SETTINGS_TAB_PERMISSIONS)}>Permissions</button>
  </>
}

async function waitForHash(expected) {
  for (let index = 0; index < 40; index += 1) {
    if (window.location.hash === expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(window.location.hash, expected)
}

test('settings navigation keeps active main and child clicks out of browser history', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(<HashRouter><NavigationHarness /></HashRouter>))
    const initialLength = window.history.length

    await act(async () => rootElement.querySelector('[data-testid="model-page"]').click())
    await act(async () => rootElement.querySelector('[data-testid="web-search"]').click())
    assert.equal(window.location.hash, '#/settings?tab=web-search')
    assert.equal(window.history.length, initialLength)

    await act(async () => rootElement.querySelector('[data-testid="files-page"]').click())
    assert.equal(window.location.hash, '#/settings?tab=files')
    assert.equal(rootElement.querySelector('[data-testid="page"]').textContent, SETTINGS_PAGE_FILES_PERMISSIONS)
    assert.equal(rootElement.querySelector('[data-testid="section"]').textContent, SETTINGS_TAB_FILES)
    assert.equal(window.history.length, initialLength + 1)

    await act(async () => rootElement.querySelector('[data-testid="permissions"]').click())
    assert.equal(window.location.hash, '#/settings?tab=permissions')
    assert.equal(window.history.length, initialLength + 2)
    await act(async () => rootElement.querySelector('[data-testid="permissions"]').click())
    assert.equal(window.history.length, initialLength + 2)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('settings navigation restores sections after refresh and browser back/forward', async () => {
  const dom = setupDom('#/settings?tab=permissions')
  const rootElement = document.getElementById('root')
  let root = createRoot(rootElement)

  try {
    await act(async () => root.render(<HashRouter><NavigationHarness /></HashRouter>))
    assert.equal(rootElement.querySelector('[data-testid="section"]').textContent, SETTINGS_TAB_PERMISSIONS)

    await act(async () => rootElement.querySelector('[data-testid="model-page"]').click())
    assert.equal(window.location.hash, '#/settings?tab=models')

    await act(async () => {
      window.history.back()
      await waitForHash('#/settings?tab=permissions')
    })
    assert.equal(rootElement.querySelector('[data-testid="section"]').textContent, SETTINGS_TAB_PERMISSIONS)

    await act(async () => {
      window.history.forward()
      await waitForHash('#/settings?tab=models')
    })
    assert.equal(rootElement.querySelector('[data-testid="page"]').textContent, SETTINGS_PAGE_MODEL_SEARCH)

    await act(async () => root.unmount())
    root = createRoot(rootElement)
    await act(async () => root.render(<HashRouter><NavigationHarness /></HashRouter>))
    assert.equal(rootElement.querySelector('[data-testid="page"]').textContent, SETTINGS_PAGE_MODEL_SEARCH)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

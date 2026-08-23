import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { HashRouter } from '../../src/lib/router.jsx'
import {
  SETTINGS_TAB_FILES,
  SETTINGS_TAB_GENERAL,
  SETTINGS_TAB_MODELS,
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
    <output data-testid="return-to">{navigation.returnTo}</output>
    <button type="button" data-testid="models" onClick={() => navigation.setActiveNav(SETTINGS_TAB_MODELS)}>Models</button>
    <button type="button" data-testid="files" onClick={() => navigation.setActiveNav(SETTINGS_TAB_FILES)}>Files</button>
    <button type="button" data-testid="web-search" onClick={() => navigation.setActiveSection(SETTINGS_TAB_WEB_SEARCH)}>Web search</button>
    <button type="button" data-testid="permissions" onClick={() => navigation.setActiveSection(SETTINGS_TAB_PERMISSIONS)}>Permissions</button>
  </>
}

test('return-aware settings navigation preserves a safe target and replaces tab history', async () => {
  const dom = setupDom('#/settings?tab=models&returnTo=%2Ftasks%3Fjob%3Djob-1')
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(<HashRouter><NavigationHarness /></HashRouter>))
    const initialLength = window.history.length
    assert.equal(rootElement.querySelector('[data-testid="return-to"]').textContent, '/tasks?job=job-1')

    await act(async () => rootElement.querySelector('[data-testid="web-search"]').click())
    assert.equal(window.location.hash, '#/settings?tab=web-search&returnTo=%2Ftasks%3Fjob%3Djob-1')
    assert.equal(window.history.length, initialLength)

    await act(async () => rootElement.querySelector('[data-testid="permissions"]').click())
    assert.equal(window.location.hash, '#/settings?tab=permissions&returnTo=%2Ftasks%3Fjob%3Djob-1')
    assert.equal(window.history.length, initialLength)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

async function waitForHash(expected) {
  for (let index = 0; index < 40; index += 1) {
    if (window.location.hash === expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(window.location.hash, expected)
}

test('settings navigation gives every module its own history entry and avoids duplicate entries', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(<HashRouter><NavigationHarness /></HashRouter>))
    const initialLength = window.history.length

    await act(async () => rootElement.querySelector('[data-testid="models"]').click())
    assert.equal(window.location.hash, '#/settings?tab=models')
    assert.equal(rootElement.querySelector('[data-testid="page"]').textContent, SETTINGS_TAB_MODELS)
    await act(async () => rootElement.querySelector('[data-testid="web-search"]').click())
    assert.equal(window.location.hash, '#/settings?tab=web-search')
    assert.equal(window.history.length, initialLength + 2)

    await act(async () => rootElement.querySelector('[data-testid="files"]').click())
    assert.equal(window.location.hash, '#/settings?tab=files')
    assert.equal(rootElement.querySelector('[data-testid="page"]').textContent, SETTINGS_TAB_GENERAL)
    assert.equal(rootElement.querySelector('[data-testid="section"]').textContent, SETTINGS_TAB_GENERAL)
    assert.equal(window.history.length, initialLength + 3)

    await act(async () => rootElement.querySelector('[data-testid="permissions"]').click())
    assert.equal(window.location.hash, '#/settings?tab=permissions')
    assert.equal(window.history.length, initialLength + 4)
    await act(async () => rootElement.querySelector('[data-testid="permissions"]').click())
    assert.equal(window.history.length, initialLength + 4)
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

    await act(async () => rootElement.querySelector('[data-testid="models"]').click())
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
    assert.equal(rootElement.querySelector('[data-testid="page"]').textContent, SETTINGS_TAB_MODELS)

    await act(async () => root.unmount())
    root = createRoot(rootElement)
    await act(async () => root.render(<HashRouter><NavigationHarness /></HashRouter>))
    assert.equal(rootElement.querySelector('[data-testid="page"]').textContent, SETTINGS_TAB_MODELS)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

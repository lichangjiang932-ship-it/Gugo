import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { ConnectorCapabilityBadge } from '../../src/pages/AccessView.jsx'
import { CapabilityLegend } from '../../src/pages/access/AccessViewPrimitives.jsx'

const labels = {
  'access.capabilityLegend': 'Capability types',
  'access.capabilityNativeApi': 'Native API',
  'access.capabilityNativeApiHint': 'Uses a dedicated backend API.',
  'access.capabilityMcp': 'MCP Server',
  'access.capabilityMcpHint': 'Uses an installed MCP server.',
  'access.capabilitySocialBridge': 'Social bridge',
  'access.capabilitySocialBridgeHint': 'Sends and receives social messages.',
  'access.capabilityBrowserNative': 'Local browser',
  'access.capabilityBrowserNativeHint': 'Uses a local browser session.',
}

const t = (key) => labels[key] || key

test('connector capability badge exposes the access mode in text and data', () => {
  for (const [level, label] of [
    ['native_api', 'Native API'],
    ['mcp_server', 'MCP Server'],
    ['social_bridge', 'Social bridge'],
    ['browser_shortcut', 'Local browser'],
  ]) {
    const markup = renderToStaticMarkup(<ConnectorCapabilityBadge capabilityLevel={level} t={t} />)
    assert.match(markup, new RegExp(`data-capability-level="${level}"`))
    assert.match(markup, new RegExp(`>${label}<`))
  }
})

test('connector capability badge does not mislabel an unknown capability', () => {
  const markup = renderToStaticMarkup(<ConnectorCapabilityBadge capabilityLevel="unknown" t={t} />)
  assert.equal(markup, '')
})

test('capability explanation stays collapsed and supports keyboard dismissal', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/access',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => root.render(<CapabilityLegend t={t} />))

    const trigger = rootElement.querySelector('[data-testid="access-capability-help"]')
    assert.ok(trigger)
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(rootElement.querySelector('[data-testid="access-capability-popover"]'), null)

    await act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const popover = rootElement.querySelector('[data-testid="access-capability-popover"]')
    assert.ok(popover)
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(popover.querySelectorAll('[data-capability-level]').length, 4)

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(rootElement.querySelector('[data-testid="access-capability-popover"]'), null)
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(dom.window.document.activeElement, trigger)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

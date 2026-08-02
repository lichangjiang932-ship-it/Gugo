import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConnectorCapabilityBadge } from '../../src/pages/AccessView.jsx'

const labels = {
  'access.capabilityNativeApi': 'Native API',
  'access.capabilityMcp': 'MCP Server',
  'access.capabilitySocialBridge': 'Social bridge',
  'access.capabilityBrowserNative': 'Local browser',
}

test('connector capability badge exposes the access mode in text and data', () => {
  for (const [level, label] of [
    ['native_api', 'Native API'],
    ['mcp_server', 'MCP Server'],
    ['social_bridge', 'Social bridge'],
    ['browser_shortcut', 'Local browser'],
  ]) {
    const markup = renderToStaticMarkup(<ConnectorCapabilityBadge capabilityLevel={level} t={(key) => labels[key] || key} />)
    assert.match(markup, new RegExp(`data-capability-level="${level}"`))
    assert.match(markup, new RegExp(`>${label}<`))
  }
})

test('connector capability badge does not mislabel an unknown capability', () => {
  const markup = renderToStaticMarkup(<ConnectorCapabilityBadge capabilityLevel="unknown" t={(key) => labels[key] || key} />)
  assert.equal(markup, '')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import AccessMcpConnectorCard from '../../src/components/AccessMcpConnectorCard.jsx'

const connector = {
  provider: 'mcp_chrome_devtools',
  label: 'Chrome DevTools',
  publisher: 'Google',
  official: true,
  brandColor: '#1A73E8',
  descriptionKey: 'access.chromeDevtoolsMcpDesc',
}

const labels = {
  'access.chromeDevtoolsMcpDesc': 'Browser tools',
  'access.official': 'Official',
  'access.publishedBy': 'Maintained by {publisher}',
  'access.mcpReady': 'Ready to call',
  'access.mcpToolCount': '{count} tools discovered',
  'access.mcpNeedsRetry': 'Needs retry',
  'access.manageMcp': 'Advanced settings',
  'access.removeMcp': 'Remove MCP',
  'access.installMcp': 'Install & connect',
  'access.installingMcp': 'Installing',
  'access.retryMcp': 'Retry install',
}

const t = (key) => labels[key] || key

test('MCP catalog card distinguishes installable and ready states', () => {
  const installable = renderToStaticMarkup(
    <AccessMcpConnectorCard connector={connector} busy={false} badge={<span>MCP Server</span>} onInstall={() => {}} onRemove={() => {}} t={t} />,
  )
  assert.match(installable, /Install &amp; connect/)
  assert.doesNotMatch(installable, /Ready to call/)

  const ready = renderToStaticMarkup(
    <AccessMcpConnectorCard connector={connector} server={{ id: 'one', enabled: true }} runtime={{ tools: [{ name: 'inspect' }] }} busy={false} badge={<span>MCP Server</span>} onInstall={() => {}} onRemove={() => {}} t={t} />,
  )
  assert.match(ready, /Ready to call/)
  assert.match(ready, /1 tools discovered/)
  assert.match(ready, /href="#\/mcp"/)
})

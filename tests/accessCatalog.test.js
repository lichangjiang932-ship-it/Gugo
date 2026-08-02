import assert from 'node:assert/strict'
import test from 'node:test'
import { ACCESS_CAPABILITY_LEVELS, ACCESS_CATALOG, MCP_ACCESS, NATIVE_ACCESS, WEB_ACCESS, filterAccessCatalog, getAccessCatalogCounts } from '../src/lib/accessCatalog.js'
import { findWebConnectorsForUrl, getWebConnector, isWebConnectorProvider } from '../shared/webConnectorCatalog.js'

test('access catalog separates native connectors from popular Browser apps', () => {
  assert.equal(NATIVE_ACCESS.length, 9)
  assert.ok(WEB_ACCESS.length >= 30)
  assert.equal(MCP_ACCESS.length, 1)
  assert.equal(ACCESS_CATALOG.length, NATIVE_ACCESS.length + MCP_ACCESS.length + WEB_ACCESS.length)
  assert.ok(WEB_ACCESS.every((item) => /^https:\/\//.test(item.webUrl)))
  assert.equal(new Set(ACCESS_CATALOG.map((item) => item.provider)).size, ACCESS_CATALOG.length)
  assert.equal(NATIVE_ACCESS.find((item) => item.provider === 'google_drive')?.oauth, true)
  assert.equal(NATIVE_ACCESS.find((item) => item.provider === 'slack')?.oauth, true)
  assert.equal(WEB_ACCESS.some((item) => item.provider === 'web_google_drive'), false)
  assert.equal(WEB_ACCESS.some((item) => item.provider === 'web_slack'), false)
  assert.equal(WEB_ACCESS.some((item) => item.provider === 'web_telegram'), false)
  assert.equal(WEB_ACCESS.find((item) => item.provider === 'web_whatsapp')?.connectionMethod, 'qr_browser')
  assert.deepEqual([...new Set(WEB_ACCESS.map((item) => item.category))].sort(), ['communication', 'creative', 'productivity', 'work'])
})

test('access catalog exposes an honest capability level for every entry', () => {
  const knownLevels = new Set(Object.values(ACCESS_CAPABILITY_LEVELS))
  assert.ok(ACCESS_CATALOG.every((item) => knownLevels.has(item.capabilityLevel)))
  assert.deepEqual(
    NATIVE_ACCESS.filter((item) => item.capabilityLevel === ACCESS_CAPABILITY_LEVELS.NATIVE_API).map((item) => item.provider),
    ['notion', 'github', 'google_drive', 'slack'],
  )
  assert.deepEqual(
    NATIVE_ACCESS.filter((item) => item.capabilityLevel === ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE).map((item) => item.provider),
    ['feishu', 'wechat_personal', 'telegram', 'qq'],
  )
  assert.ok(WEB_ACCESS.every((item) => item.capabilityLevel === ACCESS_CAPABILITY_LEVELS.BROWSER_SHORTCUT))
  assert.ok(MCP_ACCESS.every((item) => item.capabilityLevel === ACCESS_CAPABILITY_LEVELS.MCP_SERVER))
  assert.equal(NATIVE_ACCESS.find((item) => item.provider === 'browser')?.capabilityLevel, ACCESS_CAPABILITY_LEVELS.BROWSER_SHORTCUT)
})

test('access catalog reports APIs, MCP servers, bridges, and browser fallbacks separately', () => {
  assert.deepEqual(getAccessCatalogCounts(), { api: 4, mcp: 1, bridges: 4, shortcuts: 30 })
})

test('access catalog searches aliases and exposes a shared trusted provider lookup', () => {
  assert.equal(filterAccessCatalog('邮箱').some((item) => item.provider === 'web_gmail'), true)
  assert.equal(filterAccessCatalog('jira').length, 1)
  assert.equal(filterAccessCatalog('google mcp').some((item) => item.provider === 'mcp_chrome_devtools'), true)
  assert.equal(getWebConnector('web_gmail')?.webUrl, 'https://mail.google.com/')
  assert.equal(isWebConnectorProvider('web_gmail'), true)
  assert.equal(isWebConnectorProvider('web_not_real'), false)
})

test('managed app URL matching separates shared domains by page path', () => {
  assert.deepEqual(findWebConnectorsForUrl('https://docs.google.com/document/d/abc').map((item) => item.provider), ['web_google_docs'])
  assert.deepEqual(findWebConnectorsForUrl('https://docs.google.com/spreadsheets/d/abc').map((item) => item.provider), ['web_google_sheets'])
  assert.deepEqual(findWebConnectorsForUrl('https://team.atlassian.net/wiki/spaces/demo').map((item) => item.provider), ['web_confluence'])
  assert.deepEqual(findWebConnectorsForUrl('https://team.atlassian.net/jira/software/projects/ABC').map((item) => item.provider), ['web_jira'])
  assert.deepEqual(findWebConnectorsForUrl('https://accounts.google.com/signin').map((item) => item.provider).sort(), [
    'web_calendar', 'web_gmail', 'web_google_docs', 'web_google_drive', 'web_google_sheets',
  ])
  assert.deepEqual(findWebConnectorsForUrl('https://example.com/'), [])
})

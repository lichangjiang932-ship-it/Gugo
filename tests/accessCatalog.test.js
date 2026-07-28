import assert from 'node:assert/strict'
import test from 'node:test'
import { ACCESS_CATALOG, NATIVE_ACCESS, WEB_ACCESS, filterAccessCatalog } from '../src/lib/accessCatalog.js'
import { findWebConnectorsForUrl, getWebConnector, isWebConnectorProvider } from '../shared/webConnectorCatalog.js'

test('access catalog separates native connectors from popular Browser apps', () => {
  assert.equal(NATIVE_ACCESS.length, 5)
  assert.ok(WEB_ACCESS.length >= 30)
  assert.equal(ACCESS_CATALOG.length, NATIVE_ACCESS.length + WEB_ACCESS.length)
  assert.ok(WEB_ACCESS.every((item) => /^https:\/\//.test(item.webUrl)))
  assert.equal(new Set(ACCESS_CATALOG.map((item) => item.provider)).size, ACCESS_CATALOG.length)
  assert.deepEqual([...new Set(WEB_ACCESS.map((item) => item.category))].sort(), ['communication', 'creative', 'productivity', 'work'])
})

test('access catalog searches aliases and exposes a shared trusted provider lookup', () => {
  assert.equal(filterAccessCatalog('邮箱').some((item) => item.provider === 'web_gmail'), true)
  assert.equal(filterAccessCatalog('jira').length, 1)
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

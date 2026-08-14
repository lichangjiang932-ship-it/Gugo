import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-connectors-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { closeDb, createUser } = await import('../server/db.js')
const { WEB_CONNECTOR_CATALOG } = await import('../shared/webConnectorCatalog.js')
const {
  getIntegrationByProvider,
  isIntegrationEnabled,
  listEnabledIntegrationToolNames,
  listProviderRegistry,
  upsertIntegration,
} = await import('../server/services/integrationsStore.js')
const {
  assertBrowserAppUrlAccess,
  connectBrowserApp,
  ensureConnectedBrowserAppSession,
  getGithubFile,
  listConnectedBrowserApps,
  openConnectedBrowserApp,
  searchNotion,
} = await import('../server/services/connectorService.js')

createUser({ id: 'u-connectors', email: 'connectors@example.com' })
createUser({ id: 'u-connectors-other', email: 'connectors-other@example.com' })
createUser({ id: 'u-connectors-all', email: 'connectors-all@example.com' })
createUser({ id: 'u-connectors-persistent', email: 'connectors-persistent@example.com' })
createUser({ id: 'u-connector-tool-visibility', email: 'connector-tool-visibility@example.com' })

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Notion connector searches with the stored redacted credential', async () => {
  upsertIntegration({ userId: 'u-connectors', provider: 'notion', secret: { token: 'ntn_secret' }, enabled: true })
  const result = await searchNotion({
    userId: 'u-connectors',
    query: 'Roadmap',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.notion.com/v1/search')
      assert.equal(init.headers.Authorization, 'Bearer ntn_secret')
      assert.equal(JSON.parse(init.body).query, 'Roadmap')
      return new Response(JSON.stringify({ results: [{ id: 'page-1', object: 'page', url: 'https://notion.so/page-1', properties: { title: { title: [{ plain_text: 'Roadmap' }] } } }] }), { status: 200 })
    },
  })
  assert.equal(result.results[0].title, 'Roadmap')
})

test('GitHub connector decodes repository file content', async () => {
  upsertIntegration({ userId: 'u-connectors', provider: 'github', secret: { token: 'github_pat_secret' }, enabled: true })
  const result = await getGithubFile({
    userId: 'u-connectors', owner: 'octo', repo: 'demo', path: 'README.md', ref: 'main',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.github.com/repos/octo/demo/contents/README.md?ref=main')
      assert.equal(init.headers.Authorization, 'Bearer github_pat_secret')
      return new Response(JSON.stringify({ type: 'file', path: 'README.md', sha: 'abc', encoding: 'base64', content: Buffer.from('# Demo').toString('base64') }), { status: 200 })
    },
  })
  assert.equal(result.content, '# Demo')
})

test('enabled integration tool visibility is user-scoped and excludes disabled providers', () => {
  upsertIntegration({
    userId: 'u-connector-tool-visibility',
    provider: 'github',
    enabled: true,
    secret: { token: 'github-visible' },
  })
  upsertIntegration({
    userId: 'u-connector-tool-visibility',
    provider: 'dropbox',
    enabled: false,
    secret: { token: 'dropbox-hidden' },
  })
  const names = listEnabledIntegrationToolNames({ userId: 'u-connector-tool-visibility' })
  assert.ok(names.includes('github_search_repositories'))
  assert.ok(names.includes('github_get_file'))
  assert.equal(names.includes('dropbox_list_files'), false)
  assert.deepEqual(listEnabledIntegrationToolNames({ userId: 'u-connectors-other' }), [])
})

test('Browser defaults on and respects the saved Access toggle', () => {
  assert.equal(isIntegrationEnabled({ userId: 'u-connectors', provider: 'browser', defaultEnabled: true }), true)
  upsertIntegration({ userId: 'u-connectors', provider: 'browser', enabled: false })
  assert.equal(isIntegrationEnabled({ userId: 'u-connectors', provider: 'browser', defaultEnabled: true }), false)
})

test('Browser app connection uses the trusted catalog URL and stays user-scoped', async () => {
  upsertIntegration({ userId: 'u-connectors', provider: 'browser', enabled: true })
  const connectCalls = []
  const connected = await connectBrowserApp({
    userId: 'u-connectors',
    provider: 'web_gmail',
    connectImpl: async (input) => { connectCalls.push(input); return { connected: true, url: input.url } },
  })
  assert.equal(connectCalls[0].url, 'https://mail.google.com/')
  assert.equal(connected.integration.kind, 'browser_app')
  assert.equal(connected.app.capabilityLevel, 'browser_shortcut')
  assert.equal(connected.app.integrationDepth, 'browser_navigation_only')
  assert.deepEqual(connected.app.providerSpecificTools, [])
  assert.deepEqual(connected.app.availableTools, ['connected_app_open'])
  assert.match(connected.app.capability, /no provider-specific API or tools/i)
  assert.deepEqual(listConnectedBrowserApps({ userId: 'u-connectors' }).map((item) => item.provider), ['web_gmail'])
  assert.deepEqual(listConnectedBrowserApps({ userId: 'u-connectors-other' }), [])
})

test('provider registry distinguishes native APIs from managed-browser shortcuts', () => {
  const providers = listProviderRegistry()
  const nativeApis = providers
    .filter((provider) => provider.capabilityLevel === 'native_api')
    .map((provider) => provider.provider)
    .sort()
  assert.deepEqual(nativeApis, [
    'airtable', 'asana', 'clickup', 'confluence', 'custom_mail', 'discord', 'dropbox', 'exchange', 'github',
    'gitlab', 'gmail', 'google_calendar', 'google_drive', 'hubspot', 'jira', 'linear', 'monday',
    'notion', 'onedrive', 'outlook', 'qq_mail', 'salesforce', 'slack', 'todoist', 'trello', 'zendesk',
  ])

  const browserApps = providers.filter((provider) => provider.kind === 'browser_app')
  assert.equal(browserApps.length, WEB_CONNECTOR_CATALOG.length)
  assert.ok(browserApps.every((provider) => provider.capabilityLevel === 'browser_shortcut'))
  assert.ok(browserApps.every((provider) => provider.integrationDepth === 'browser_navigation_only'))
  assert.ok(browserApps.every((provider) => provider.providerSpecificTools.length === 0))
  assert.ok(browserApps.every((provider) => provider.availableTools.join(',') === 'connected_app_open'))

  const browser = providers.find((provider) => provider.provider === 'browser')
  assert.deepEqual(browser.availableTools, ['connected_app_list', 'connected_app_open'])
})

test('connected app open rejects unconnected apps and never accepts a client URL', async () => {
  await assert.rejects(
    openConnectedBrowserApp({ userId: 'u-connectors', provider: 'web_google_docs', openImpl: async () => ({}) }),
    /not connected/i,
  )
  const calls = []
  await openConnectedBrowserApp({
    userId: 'u-connectors',
    provider: 'web_gmail',
    openImpl: async (input) => { calls.push(input); return { connected: true } },
  })
  assert.equal(calls[0].url, 'https://mail.google.com/')
})

test('persistent Browser connection automatically resumes after its in-memory session is gone', async () => {
  const userId = 'u-connectors-persistent'
  const connected = await connectBrowserApp({
    userId,
    provider: 'web_gmail',
    connectImpl: async ({ url }) => ({ connected: true, url }),
  })
  assert.equal(connected.app.persistent, true)
  assert.equal(getIntegrationByProvider({ userId, provider: 'web_gmail' }).config.connectionMode, 'persistent_browser')

  const resumedCalls = []
  const resumed = await ensureConnectedBrowserAppSession({
    userId,
    stateImpl: async () => ({ connected: false }),
    resumeImpl: async (input) => {
      resumedCalls.push(input)
      return { connected: true, url: input.url }
    },
  })
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.provider, 'web_gmail')
  assert.deepEqual(resumedCalls, [{ userId, url: 'https://mail.google.com/' }])

  const current = await ensureConnectedBrowserAppSession({
    userId,
    stateImpl: async () => ({ connected: true, headless: false, url: 'https://mail.google.com/mail/u/0/' }),
    resumeImpl: async () => { throw new Error('must not relaunch an active session') },
  })
  assert.equal(current.url, 'https://mail.google.com/mail/u/0/')

  const recovered = await ensureConnectedBrowserAppSession({
    userId,
    stateImpl: async () => { throw new Error('stale CDP socket') },
    resumeImpl: async ({ url }) => ({ connected: true, url }),
  })
  assert.equal(recovered.resumed, true)
  assert.equal(recovered.url, 'https://mail.google.com/')
})

test('every catalog app can establish an isolated Browser assistance connection', async () => {
  const visited = []
  for (const connector of WEB_CONNECTOR_CATALOG) {
    await connectBrowserApp({
      userId: 'u-connectors-all',
      provider: connector.provider,
      connectImpl: async ({ url }) => { visited.push(url); return { connected: true, url } },
    })
  }
  assert.equal(visited.length, WEB_CONNECTOR_CATALOG.length)
  assert.deepEqual(visited, WEB_CONNECTOR_CATALOG.map((connector) => connector.webUrl))
  assert.equal(listConnectedBrowserApps({ userId: 'u-connectors-all' }).length, WEB_CONNECTOR_CATALOG.length)
})

test('managed app URLs require an enabled connection while ordinary sites remain available', () => {
  assert.throws(
    () => assertBrowserAppUrlAccess({ userId: 'u-connectors-other', url: 'https://mail.google.com/mail/u/0/' }),
    /not connected/i,
  )
  assert.equal(assertBrowserAppUrlAccess({ userId: 'u-connectors', url: 'https://mail.google.com/mail/u/0/' })?.provider, 'web_gmail')
  assert.equal(assertBrowserAppUrlAccess({ userId: 'u-connectors-other', url: 'https://example.com/docs' }), null)
})

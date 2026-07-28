import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-connectors-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { closeDb, createUser } = await import('../server/db.js')
const { WEB_CONNECTOR_CATALOG } = await import('../shared/webConnectorCatalog.js')
const { isIntegrationEnabled, upsertIntegration } = await import('../server/services/integrationsStore.js')
const {
  assertBrowserAppUrlAccess,
  connectBrowserApp,
  getGithubFile,
  listConnectedBrowserApps,
  openConnectedBrowserApp,
  searchNotion,
} = await import('../server/services/connectorService.js')

createUser({ id: 'u-connectors', email: 'connectors@example.com' })
createUser({ id: 'u-connectors-other', email: 'connectors-other@example.com' })
createUser({ id: 'u-connectors-all', email: 'connectors-all@example.com' })

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
  assert.deepEqual(listConnectedBrowserApps({ userId: 'u-connectors' }).map((item) => item.provider), ['web_gmail'])
  assert.deepEqual(listConnectedBrowserApps({ userId: 'u-connectors-other' }), [])
})

test('connected app open rejects unconnected apps and never accepts a client URL', async () => {
  await assert.rejects(
    openConnectedBrowserApp({ userId: 'u-connectors', provider: 'web_jira', openImpl: async () => ({}) }),
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

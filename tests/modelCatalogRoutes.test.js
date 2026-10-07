import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-model-catalog-routes-'))
process.env.APP_DATA_DIR = dir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')
const { resetCatalogCache } = await import('../server/services/modelCatalogService.js')

const compactionArchiveController = activateTestCompactionArchivePort({ source: 'test.model-catalog-routes' })
const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  compactionArchiveController.release()
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

test('the catalogue route requires an authenticated caller', async () => {
  const response = await fetch(`${origin}/api/model/catalog`)
  assert.equal(response.status, 401)
})

test('the catalogue route reports the provenance of the data in use', async () => {
  resetCatalogCache()
  const session = issueTestSession({ email: 'catalog-status@example.com' })
  const response = await fetch(`${origin}/api/model/catalog`, { headers: headers(session.token) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.catalog.available, true)
  // No refresh has run in this process, so the reader is on the shipped snapshot.
  assert.equal(body.catalog.source, 'bundled')
  assert.ok(body.catalog.providers > 100)
  assert.equal(body.catalog.error, '')
  // The plain status call stays small: the provider index is opt-in, so the
  // settings page does not pay for 200+ entries it is not showing.
  assert.equal('providers' in body, false)
})

test('the provider index is opt-in and searchable, so every catalogue provider is reachable', async () => {
  const session = issueTestSession({ email: 'catalog-index@example.com' })
  const all = await (await fetch(`${origin}/api/model/catalog?providers=1`, { headers: headers(session.token) })).json()
  assert.ok(Array.isArray(all.providers))
  assert.ok(all.providers.length > 100, `expected a broad index, got ${all.providers.length}`)
  assert.equal(all.providerCount, all.providers.length)
  for (const provider of all.providers) {
    assert.equal(typeof provider.id, 'string')
    assert.equal(typeof provider.name, 'string')
    assert.equal(typeof provider.modelCount, 'number')
    assert.ok(provider.modelCount > 0)
  }
  // The ids from the settings screenshots, which had no bundled preset at all.
  const ids = new Set(all.providers.map((provider) => provider.id))
  for (const id of ['amazon-bedrock', 'cerebras', 'baseten', 'github-copilot', 'google-vertex', 'minimax-cn']) {
    assert.ok(ids.has(id), `the index is missing ${id}`)
  }

  const filtered = await (await fetch(`${origin}/api/model/catalog?providers=1&q=bedrock`, { headers: headers(session.token) })).json()
  assert.ok(filtered.providers.length > 0)
  assert.ok(filtered.providers.every((provider) => `${provider.id} ${provider.name}`.toLowerCase().includes('bedrock')))
  assert.ok(filtered.providers.length < all.providers.length)
})

test('one provider returns the models it currently serves, with their limits', async () => {
  const session = issueTestSession({ email: 'catalog-provider@example.com' })
  const response = await fetch(`${origin}/api/model/catalog/openai`, { headers: headers(session.token) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.provider.id, 'openai')
  assert.ok(Array.isArray(body.models) && body.models.length > 0)
  const model = body.models[0]
  for (const key of ['id', 'name', 'context', 'output']) assert.ok(key in model, `model has ${key}`)
  for (const key of ['tools', 'vision', 'pdf', 'reasoning']) assert.equal(typeof model[key], 'boolean')
})

test('a preset id is translated to the catalogue id that keys it upstream', async () => {
  const session = issueTestSession({ email: 'catalog-alias@example.com' })
  // This app ships the preset as `gemini`; the catalogue keys Google as `google`.
  const response = await fetch(`${origin}/api/model/catalog/gemini`, { headers: headers(session.token) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.provider.id, 'google')
  assert.ok(body.models.length > 0)
})

test('an unknown provider is a 404 that still reports catalogue provenance', async () => {
  const session = issueTestSession({ email: 'catalog-unknown@example.com' })
  const response = await fetch(`${origin}/api/model/catalog/not-a-real-provider`, { headers: headers(session.token) })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error.code, 'CATALOG_PROVIDER_UNKNOWN')
  assert.equal(body.catalog.available, true)
})

test('a provider the bundled presets never covered is now reachable', async () => {
  const session = issueTestSession({ email: 'catalog-bedrock@example.com' })
  // amazon-bedrock, cerebras and baseten had no bundled preset before this:
  // the settings screen could not offer them at all.
  for (const id of ['amazon-bedrock', 'cerebras', 'baseten', 'google-vertex']) {
    const response = await fetch(`${origin}/api/model/catalog/${id}`, { headers: headers(session.token) })
    assert.equal(response.status, 200, `${id} must be reachable`)
    const body = await response.json()
    assert.ok(body.models.length > 0, `${id} must list models`)
  }
})

test('an unsupported method on the catalogue route is rejected', async () => {
  const session = issueTestSession({ email: 'catalog-method@example.com' })
  const response = await fetch(`${origin}/api/model/catalog/openai`, { method: 'DELETE', headers: headers(session.token) })
  assert.equal(response.status, 405)
})

test('a refresh reports its outcome in the payload and leaves the settings page usable', async () => {
  const session = issueTestSession({ email: 'catalog-refresh@example.com' })
  // This test is offline by design. The refresh is answered 200 either way,
  // because it only ever improves data the app already has: whatever happens to
  // the network, the caller must still be handed a working catalogue.
  const response = await fetch(`${origin}/api/model/catalog/refresh`, {
    method: 'POST',
    headers: headers(session.token),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.catalog.available, true)
  assert.ok(['bundled', 'models.dev'].includes(body.catalog.source))
  assert.ok(body.catalog.providers > 100)
  assert.equal(typeof body.catalog.error, 'string')
  assert.equal(typeof body.ok, 'boolean')
})

test('a failed refresh never empties the catalogue the reader is using', async () => {
  const session = issueTestSession({ email: 'catalog-refresh-fallback@example.com' })
  await fetch(`${origin}/api/model/catalog/refresh`, { method: 'POST', headers: headers(session.token) })
  // Whatever the refresh did above, a provider must still resolve afterwards.
  const response = await fetch(`${origin}/api/model/catalog/openai`, { headers: headers(session.token) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.models.length > 0)
})

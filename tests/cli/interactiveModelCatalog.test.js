import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { createInteractiveModelCatalog, modelCatalogEntries, selectCatalogModel } from '../../bin/cli/interactiveModelCatalog.js'
import { chooseModelInteractively } from '../../bin/cli/interactiveModelSelection.js'
import { startInteractiveSession } from '../../bin/cli/interactiveSession.js'

const provider = (id, models = ['org/model']) => ({ id, key: id, label: id, models, enabled: true, configRevision: 3,
  baseUrl: 'https://never-contact.invalid', apiKey: 'never-persist-this', headers: { authorization: 'secret' } })

test('catalog keeps Provider/model identity separate, including slash names and ambiguity', () => {
  const entries = modelCatalogEntries([provider('one'), provider('two')])
  assert.throws(() => selectCatalogModel(entries, 'org/model'), { code: 'MODEL_PROVIDER_AMBIGUOUS' })
  assert.equal(selectCatalogModel(entries, 'org/model', { currentProviderId: 'one' }).providerId, 'one')
  const selected = selectCatalogModel(entries, 'two/org/model')
  assert.equal(selected.providerId, 'two')
  assert.equal(selected.modelName, 'org/model')
  assert.equal(JSON.stringify(entries).includes('never-persist-this'), false)
  assert.equal(JSON.stringify(entries).includes('https://'), false)
})

test('qualified unknown, mismatched and disabled selections never become a free-form model', () => {
  const enabled = { ...provider('enabled-id'), key: 'enabled' }
  const disabled = { ...provider('disabled-id'), key: 'disabled', enabled: false }
  const entries = modelCatalogEntries([enabled, disabled])
  for (const value of ['missing/org/model', 'removed-id/org/model']) {
    assert.throws(() => selectCatalogModel(entries, value), { code: 'MODEL_PROVIDER_NOT_FOUND' })
  }
  for (const value of ['enabled/other', 'enabled-id/other']) {
    assert.throws(() => selectCatalogModel(entries, value), { code: 'MODEL_PROVIDER_MODEL_INVALID' })
  }
  for (const value of ['disabled/org/model', 'disabled-id/org/model']) {
    assert.throws(() => selectCatalogModel(entries, value), { code: 'MODEL_PROVIDER_DISABLED' })
  }
  assert.equal(selectCatalogModel(entries, 'org/model').providerId, 'enabled-id', 'a declared slash model remains a bare model name')
  assert.deepEqual(selectCatalogModel(entries, 'legacy-model'), { modelName: 'legacy-model', providerId: null })
})

test('a removed or catalog-budget-excluded qualified selection cannot fall back to the default Provider', async () => {
  let rows = [provider('local')]
  const catalog = createInteractiveModelCatalog({ userId: 'owner', readProviders: async () => rows })
  await catalog.refresh()
  const previous = catalog.entries()[0]
  rows = [provider('cloud', ['cloud-model'])]
  await assert.rejects(catalog.select(previous.value), { code: 'MODEL_PROVIDER_NOT_FOUND' })
  await assert.rejects(catalog.select(previous), { code: 'MODEL_PROVIDER_CONFIG_CHANGED' })
  const bounded = modelCatalogEntries([provider('cloud', Array.from({ length: 500 }, (_, index) => `cloud-${index}`)), provider('local')])
  assert.equal(bounded.length, 500)
  assert.throws(() => selectCatalogModel(bounded, 'local/org/model'), { code: 'MODEL_PROVIDER_NOT_FOUND' })
  catalog.close()
})

test('owner-scoped v2 cache is display-only until an authoritative refresh; deletions really disappear', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-scoped-models-'))
  try {
    let rows = [provider('one')]
    const options = { userId: 'owner', env: { APP_DATA_DIR: dir }, readProviders: async () => rows, now: () => 100 }
    const catalog = createInteractiveModelCatalog(options)
    await catalog.refresh()
    assert.equal(catalog.entries()[0].providerId, 'one')
    const persisted = readFileSync(path.join(dir, readdirSync(dir)[0]), 'utf8')
    assert.equal(persisted.includes('never-persist-this'), false)
    const other = createInteractiveModelCatalog({ ...options, userId: 'other' })
    assert.deepEqual(other.list(), [])
    const offline = createInteractiveModelCatalog({ ...options, readProviders: async () => { throw new Error('offline') } })
    assert.deepEqual(offline.list(), ['one/org/model'])
    await assert.rejects(offline.select('one/org/model'), { code: 'CLI_MODEL_CATALOG_UNAVAILABLE' })
    rows = []
    await catalog.refresh()
    assert.deepEqual(catalog.list(), [])
    assert.deepEqual(createInteractiveModelCatalog(options).list(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a stale picker selection cannot survive Provider revision or enabled-state changes', async () => {
  let row = provider('one')
  const catalog = createInteractiveModelCatalog({ userId: 'owner', readProviders: async () => [row] })
  await catalog.refresh()
  const selection = catalog.entries()[0]
  row = { ...row, configRevision: 4 }
  await assert.rejects(catalog.select(selection), { code: 'MODEL_PROVIDER_CONFIG_CHANGED' })
  row = { ...row, enabled: false }
  await assert.rejects(catalog.select('one/org/model'), { code: 'MODEL_PROVIDER_DISABLED' })
})

test('late refresh after close never writes a cache or reopens a session', async () => {
  let release
  const catalog = createInteractiveModelCatalog({ userId: 'owner', readProviders: () => new Promise((resolve) => { release = resolve }) })
  const pending = catalog.refresh()
  await Promise.resolve()
  catalog.close()
  release([provider('late')])
  assert.equal(await pending, false)
  assert.deepEqual(catalog.entries(), [])
})

test('picker suspends the editor and uses the same injected terminal; cancellation does not select', async () => {
  const catalog = createInteractiveModelCatalog({ userId: 'owner', readProviders: async () => [provider('one')] })
  const stdin = { isTTY: true, read: () => null }
  const stdout = { isTTY: true }
  let suspended = false
  const reader = { suspend() { suspended = true } }
  const picked = await chooseModelInteractively({ catalog, current: {}, stdin, stdout, reader,
    selectModel: async (options, context) => {
      assert.equal(suspended, true)
      assert.equal(context.input, stdin)
      assert.equal(context.output, stdout)
      return options.choices[0].value
    } })
  assert.equal(picked.providerId, 'one')
  const controller = new AbortController()
  const cancelled = await chooseModelInteractively({ catalog, current: {}, stdin, stdout, reader, signal: controller.signal,
    selectModel: async (options) => { controller.abort(); return options.choices[0].value } })
  assert.equal(cancelled, null)
})

test('the real interactive command submits the structured local model binding without HTTP discovery', async () => {
  const calls = []
  const stream = new Writable({ write(_chunk, _encoding, done) { done() } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { assert.fail('a local chat must not perform unauthenticated HTTP discovery') }
  try {
    const code = await startInteractiveSession({
      options: { sessionId: 'model-scope' }, env: {}, lines: ['/model one/org/model', 'hello', '/exit'],
      stdout: stream, stderr: stream, resolveUserId: async () => 'owner',
      readModelProviders: async ({ userId }) => { assert.equal(userId, 'owner'); return [provider('one')] },
      runTurn: async (input) => { calls.push(input); return { status: 'completed', exitCode: 0 } },
    })
    assert.equal(code, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].model, 'org/model')
    assert.equal(calls[0].modelProviderId, 'one')
  } finally { globalThis.fetch = originalFetch }
})

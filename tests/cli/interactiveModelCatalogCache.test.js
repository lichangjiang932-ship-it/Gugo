import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInteractiveModelCatalog } from '../../bin/cli/interactiveModelCatalog.js'

const rows = [{ id: 'local', key: 'local', label: 'Local', models: ['org/model'], enabled: true, configRevision: 2 }]

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gugo-real-model-cache-'))
  const catalogs = []
  t.after(() => {
    for (const catalog of catalogs) catalog.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, create(options = {}) {
    const catalog = createInteractiveModelCatalog({ userId: 'fixture-owner', env: { APP_DATA_DIR: root },
      readProviders: async () => rows, now: () => 100_000_000, ...options })
    catalogs.push(catalog)
    return catalog
  } }
}

test('the real catalog coalesces simultaneous refreshes and synchronous snapshots do not refresh', async (t) => {
  const io = fixture(t)
  let calls = 0
  let release
  const source = new Promise((resolve) => { release = resolve })
  const catalog = io.create({ readProviders: () => { calls++; return source } })
  assert.deepEqual(catalog.list(), [])
  assert.deepEqual(catalog.entries(), [])
  assert.equal(catalog.diagnostics().source, 'empty')
  assert.equal(calls, 0)
  const first = catalog.refresh()
  const second = catalog.refresh()
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)
  release(rows)
  assert.equal(await first, true)
  const files = readdirSync(io.root)
  assert.equal(files.length, 1)
  const before = readFileSync(path.join(io.root, files[0]), 'utf8')
  for (let index = 0; index < 20; index++) {
    assert.deepEqual(catalog.list(), ['local/org/model'])
    assert.equal(catalog.entries()[0].modelName, 'org/model')
    assert.equal(catalog.diagnostics().source, 'local')
  }
  assert.equal(calls, 1)
  assert.equal(readFileSync(path.join(io.root, files[0]), 'utf8'), before)
  assert.equal(await catalog.refresh(), false, 'an unchanged authoritative snapshot is not a list change')
  assert.equal(calls, 2)
  catalog.close()
  assert.equal(await catalog.refresh(), false)
  assert.equal(calls, 2)
})

test('the real v2 cache rejects foreign, expired, future and malformed snapshots', async (t) => {
  const io = fixture(t)
  const first = io.create()
  await first.refresh()
  first.close()
  const cachePath = path.join(io.root, readdirSync(io.root)[0])
  const original = JSON.parse(readFileSync(cachePath, 'utf8'))
  const invalid = [
    '{not-json', JSON.stringify({ ...original, version: 99 }),
    JSON.stringify({ ...original, scope: 'another-owner-runtime' }),
    JSON.stringify({ ...original, updatedAt: original.updatedAt + 1 }),
    JSON.stringify({ ...original, updatedAt: original.updatedAt - 24 * 60 * 60 * 1000 - 1 }),
    JSON.stringify({ ...original, entries: {} }),
  ]
  for (const body of invalid) {
    writeFileSync(cachePath, body)
    const catalog = io.create({ readProviders: async () => { throw new Error('offline fixture') } })
    assert.deepEqual(catalog.list(), [])
    assert.equal(catalog.diagnostics().cached, false)
    await assert.rejects(catalog.select('local/org/model'), { code: 'CLI_MODEL_CATALOG_UNAVAILABLE' })
    assert.equal(readFileSync(cachePath, 'utf8'), body, 'invalid display cache is not silently migrated or overwritten')
    catalog.close()
  }
  writeFileSync(cachePath, JSON.stringify(original))
  const restored = io.create({ readProviders: async () => { throw new Error('offline fixture') } })
  assert.deepEqual(restored.list(), ['local/org/model'])
  assert.equal(restored.diagnostics().source, 'cache')
  await assert.rejects(restored.select('local/org/model'), { code: 'CLI_MODEL_CATALOG_UNAVAILABLE' })
  assert.deepEqual(restored.list(), ['local/org/model'], 'offline names remain display-only')
})

test('a blocked cache path cannot prevent a valid local catalog from refreshing and selecting', async (t) => {
  const io = fixture(t)
  const occupied = path.join(io.root, 'not-a-directory')
  writeFileSync(occupied, 'preserve this fixture file')
  const catalog = io.create({ env: { APP_DATA_DIR: occupied } })
  assert.equal(await catalog.refresh(), true)
  assert.deepEqual(catalog.list(), ['local/org/model'])
  assert.equal((await catalog.select('local/org/model')).providerId, 'local')
  assert.equal(readFileSync(occupied, 'utf8'), 'preserve this fixture file')
  assert.deepEqual(readdirSync(io.root), ['not-a-directory'])
})

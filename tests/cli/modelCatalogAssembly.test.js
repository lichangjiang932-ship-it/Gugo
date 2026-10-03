import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { assertModelCatalog } from '../../bin/cli/cliContracts.js'
import { createInteractiveModelCatalog } from '../../bin/cli/interactiveModelCatalog.js'
import { startInteractiveSession } from '../../bin/cli/interactiveSession.js'

const provider = { id: 'local', key: 'local', label: 'Local', models: ['org/model'], enabled: true, configRevision: 4 }
const output = () => new Writable({ write(_chunk, _encoding, done) { done() } })

function startupFixture(t, overrides = {}) {
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = (value) => { stdin.isRaw = value }
  const stream = output()
  stream.isTTY = true
  const signal = overrides.signal || new AbortController().signal
  const counts = { refreshes: 0, closes: 0, models: 0 }
  const catalog = {
    entries: () => [], list: () => [],
    diagnostics: () => ({ source: 'empty', lastSuccessfulRefresh: null, cached: false }),
    refresh: async () => { counts.refreshes++; return false },
    select: async () => { throw new Error('unexpected selection') },
    close() { counts.closes++ },
  }
  t.after(() => { stdin.destroy(); stream.destroy() })
  const listenersBefore = process.listenerCount('SIGINT')
  return {
    stdin, signal, counts,
    run: () => startInteractiveSession({ stdin, stdout: stream, stderr: stream, signal,
      options: { sessionId: 'startup-fixture', files: ['pending-fixture.txt'] },
      env: { GUGO_CLI_HISTORY: '0' }, resolveUserId: async () => 'fixture-owner',
      modelCatalogFactory: () => catalog, runTurn: async () => { counts.models++; return { status: 'completed', exitCode: 0 } },
      ...overrides,
    }),
    assertClean() {
      assert.deepEqual(counts, { refreshes: 0, closes: 1, models: 0 })
      assert.equal(stdin.isRaw, false)
      for (const event of ['keypress', 'end', 'close']) assert.equal(stdin.listenerCount(event), 0, event)
      assert.equal(getEventListeners(signal, 'abort').length, 0)
      assert.equal(process.listenerCount('SIGINT'), listenersBefore)
    },
  }
}

test('invalid input mode closes the validated catalog before any refresh or stdin ownership', async (t) => {
  const io = startupFixture(t, { env: { GUGO_CLI_INPUT: 'invalid', GUGO_CLI_HISTORY: '0' } })
  await assert.rejects(io.run(), { code: 'CLI_INPUT_MODE_INVALID' })
  io.assertClean()
  assert.equal(io.stdin.listenerCount('data'), 0)
})

test('reader construction failure closes the catalog without starting refresh or model work', async (t) => {
  const io = startupFixture(t)
  const once = io.stdin.once
  io.stdin.once = undefined
  try {
    await assert.rejects(io.run(), TypeError)
    io.assertClean()
    assert.equal(io.stdin.listenerCount('data'), 0)
  } finally { io.stdin.once = once }
})

test('history path setup failure closes the catalog before the input reader is created', async (t) => {
  const io = startupFixture(t, { env: { APP_DATA_DIR: 42, GUGO_CLI_HISTORY: '1' } })
  await assert.rejects(io.run(), { code: 'ERR_INVALID_ARG_TYPE' })
  io.assertClean()
})

test('already-cancelled startup closes the catalog without refresh or input ownership', async (t) => {
  const controller = new AbortController()
  const reason = new Error('cancelled before input startup')
  controller.abort(reason)
  const io = startupFixture(t, { signal: controller.signal })
  await assert.rejects(io.run(), (error) => error === reason)
  io.assertClean()
})

test('setup failure after constructing a reader still releases its ownership and catalog', async (t) => {
  const controller = new AbortController()
  const signal = controller.signal
  const add = signal.addEventListener
  const failure = new Error('fixture signal setup failure')
  let registrations = 0
  signal.addEventListener = function (...args) {
    registrations++
    if (registrations === 2) throw failure
    return Reflect.apply(add, this, args)
  }
  const io = startupFixture(t, { signal })
  try {
    await assert.rejects(io.run(), (error) => error === failure)
    io.assertClean()
    assert.equal(io.stdin.isPaused(), true)
  } finally { signal.addEventListener = add }
})

test('Node 20 Ink admission failure closes the catalog without refresh', {
  skip: Number(process.versions.node.split('.')[0]) >= 22,
}, async (t) => {
  const io = startupFixture(t, { env: { GUGO_CLI_INPUT: 'ink', GUGO_CLI_HISTORY: '0' } })
  await assert.rejects(io.run(), { code: 'CLI_INK_NODE_UNSUPPORTED' })
  io.assertClean()
})

test('checking production catalog snapshots performs no provider lookup or cache write', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cli-contract-cache-'))
  let reads = 0
  const options = { userId: 'owner', env: { APP_DATA_DIR: root },
    readProviders: async () => { reads++; return [provider] }, now: () => 100 }
  try {
    const first = createInteractiveModelCatalog(options)
    assert.equal(assertModelCatalog(first), first)
    assert.equal(reads, 0)
    assert.deepEqual(readdirSync(root), [])
    await first.refresh()
    const files = readdirSync(root)
    assert.equal(files.length, 1)
    const bytes = readFileSync(path.join(root, files[0]))
    const cached = createInteractiveModelCatalog({ ...options, readProviders: async () => { reads++; throw new Error('offline') } })
    assert.equal(assertModelCatalog(cached), cached)
    assert.equal(reads, 1)
    assert.deepEqual(cached.diagnostics(), { source: 'cache', lastSuccessfulRefresh: null, cached: true })
    assert.deepEqual(readFileSync(path.join(root, files[0])), bytes)
    await cached.refresh()
    assert.equal(assertModelCatalog(cached), cached)
    assert.equal(cached.diagnostics().source, 'stale')
    assert.equal(reads, 2)
    assert.deepEqual(readdirSync(root), files)
    assert.deepEqual(readFileSync(path.join(root, files[0])), bytes)
    first.close()
    cached.close()
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep))
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat validates its real catalog factory result and retains structured model selection', async () => {
  const stream = output()
  const calls = []
  let created = 0
  let closed = 0
  const readProviders = async () => [provider]
  const env = {}
  const code = await startInteractiveSession({
    env, lines: ['/model local/org/model', 'fixture task', '/exit'], stdout: stream, stderr: stream,
    resolveUserId: async () => 'owner', readModelProviders: readProviders,
    modelCatalogFactory: (input) => {
      created++
      assert.equal(input.userId, 'owner')
      assert.equal(input.env, env)
      assert.equal(input.readProviders, readProviders)
      const catalog = createInteractiveModelCatalog(input)
      const close = catalog.close
      return { ...catalog, close() { closed++; close() } }
    },
    runTurn: async (input) => { calls.push(input); return { status: 'completed', exitCode: 0 } },
  })
  assert.equal(code, 0)
  assert.equal(created, 1)
  assert.equal(closed, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'org/model')
  assert.equal(calls[0].modelProviderId, 'local')
})

test('chat rejects invalid catalog wiring before refresh, model calls, or input listeners', async () => {
  const factories = [
    () => ({ list: () => [], size: () => 0, has: () => false, source: () => 'empty', refresh: async () => false }),
    () => ({ ...createInteractiveModelCatalog({ env: {} }), select: null }),
    () => ({ ...createInteractiveModelCatalog({ env: {} }), list: () => 'bad snapshot' }),
    () => ({ ...createInteractiveModelCatalog({ env: {} }), diagnostics: async () => { throw new Error('must not execute') } }),
    () => Promise.reject(new Error('bad asynchronous factory')),
  ]
  for (const factory of factories) {
    let models = 0
    let reads = 0
    let refreshes = 0
    const stream = output()
    const listenersBefore = process.listenerCount('SIGINT')
    await assert.rejects(startInteractiveSession({
      env: {}, lines: ['must never run', '/exit'], stdout: stream, stderr: stream,
      resolveUserId: async () => 'owner', readModelProviders: async () => { reads++; return [] },
      modelCatalogFactory: () => {
        const catalog = factory()
        if (catalog && typeof catalog.refresh === 'function') {
          catalog.refresh = async () => { refreshes++; return false }
        }
        return catalog
      },
      runTurn: async () => { models++; return { status: 'completed', exitCode: 0 } },
    }), { code: 'CLI_MODEL_CATALOG_INVALID' })
    assert.equal(models, 0)
    assert.equal(reads, 0)
    assert.equal(refreshes, 0)
    assert.equal(process.listenerCount('SIGINT'), listenersBefore)
  }
  await new Promise(setImmediate)
})

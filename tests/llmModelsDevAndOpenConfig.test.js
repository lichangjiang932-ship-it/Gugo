import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  indexModelsDevPayload,
  isCacheFresh,
  modelsDevMeta,
  modelsDevPath,
  modelsDevStatus,
  readModelsDevCache,
  refreshModelsDev,
} from '../server/llm/modelsDevCache.js'
import { configPathFor, openConfigFile, platformOpenCommand } from '../server/llm/openConfigFile.js'
import { writeSettings } from '../server/llm/llmConfigStore.js'

async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'gugo-models-dev-'))
  const previous = process.env.GUGO_HOME
  process.env.GUGO_HOME = home
  try {
    return await run(process.env, home)
  } finally {
    if (previous === undefined) delete process.env.GUGO_HOME
    else process.env.GUGO_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

const PAYLOAD = {
  anthropic: { models: { 'claude-opus-4-6': { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', limit: { context: 200000, output: 8192 } } } },
  deepseek: { models: { 'deepseek-chat': { id: 'deepseek-chat', name: 'DeepSeek Chat' } } },
}

test('the payload index keeps names, context windows and output limits', () => {
  const index = indexModelsDevPayload(PAYLOAD)
  assert.deepEqual(index['claude-opus-4-6'], { displayName: 'Claude Opus 4.6', contextWindow: 200000, maxTokens: 8192 })
  assert.deepEqual(index['deepseek-chat'], { displayName: 'DeepSeek Chat' })
  assert.deepEqual(indexModelsDevPayload(null), {})
})

test('a refresh caches metadata, and the cache ages out after the TTL', async () => {
  await withHome(async (env) => {
    writeSettings({ modelsDev: { cacheTtlHours: 24 } }, env)
    const before = modelsDevStatus(env, { now: 1_000_000 })
    assert.equal(before.count, 0)
    assert.equal(before.fresh, false)

    const now = 1_700_000_000_000
    const result = await refreshModelsDev({ env, now, fetchImpl: async () => ({ ok: true, json: async () => PAYLOAD }) })
    assert.equal(result.ok, true)
    assert.equal(result.count, 2)
    assert.equal(result.fresh, true)
    assert.deepEqual(modelsDevMeta('deepseek-chat', env), { displayName: 'DeepSeek Chat' })
    // Fresh inside the window, stale after it.
    assert.equal(isCacheFresh(readModelsDevCache(env), { now: now + 3600_000, ttlHours: 24 }), true)
    assert.equal(isCacheFresh(readModelsDevCache(env), { now: now + 25 * 3600_000, ttlHours: 24 }), false)
    assert.equal(modelsDevStatus(env, { now: now + 25 * 3600_000 }).fresh, false)
  })
})

test('an offline refresh keeps the previous cache instead of emptying it', async () => {
  await withHome(async (env) => {
    await refreshModelsDev({ env, now: 1, fetchImpl: async () => ({ ok: true, json: async () => PAYLOAD }) })
    const failed = await refreshModelsDev({ env, now: 2, fetchImpl: async () => { throw new Error('offline') } })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'MODELS_DEV_FETCH_FAILED')
    assert.equal(failed.count, 2, 'the cached entries survive a failed refresh')
    const httpError = await refreshModelsDev({ env, now: 3, fetchImpl: async () => ({ ok: false, status: 503 }) })
    assert.equal(httpError.ok, false)
    assert.equal(httpError.count, 2)
  })
})

test('a corrupt cache is treated as absent, not as a crash', async () => {
  await withHome(async (env) => {
    writeSettings({ modelsDev: { enabled: false } }, env)
    writeFileSync(modelsDevPath(env), '{ this is not json', 'utf8')
    assert.deepEqual(readModelsDevCache(env), { fetchedAt: 0, models: {} })
    assert.equal(modelsDevMeta('anything', env), null)
    const disabled = await refreshModelsDev({ env, fetchImpl: async () => { throw new Error('must not run') } })
    assert.equal(disabled.code, 'MODELS_DEV_DISABLED')
  })
})

test('cached models.dev metadata decorates the provider models, configuration winning', async () => {
  await withHome(async (env) => {
    await refreshModelsDev({ env, now: 5, fetchImpl: async () => ({ ok: true, json: async () => PAYLOAD }) })
    const { listProviders, upsertProvider } = await import('../server/llm/llmProviderService.js')
    upsertProvider({ id: 'meta-demo', api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'deepseek-chat' }, { id: 'claude-opus-4-6', contextWindow: 64 }] }, env)
    const provider = listProviders(env).providers[0]
    const [fromMeta, configured] = provider.models
    assert.equal(fromMeta.displayName, 'DeepSeek Chat', 'the cache supplies the readable name')
    assert.equal(configured.contextWindow, 64, 'a configured context window is never overwritten')
    assert.equal(configured.displayName, 'Claude Opus 4.6')
    assert.equal(configured.maxTokens, 8192)
  })
})

test('opening a config file is limited to the two files the page shows', async () => {
  await withHome(async (env) => {
    const spawned = []
    const spawnImpl = (command, args) => { spawned.push({ command, args }); return { unref() {} } }
    const missing = openConfigFile('settings', { env, spawnImpl })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'LLM_CONFIG_FILE_MISSING')

    writeSettings({ llm: { providers: {} } }, env)
    const opened = openConfigFile('settings', { env, spawnImpl, platform: 'win32' })
    assert.equal(opened.ok, true)
    assert.deepEqual(spawned[0], { command: 'cmd', args: ['/c', 'start', '', configPathFor('settings', env)] })
    assert.deepEqual(platformOpenCommand('/tmp/a.yaml', 'darwin'), { command: 'open', args: ['/tmp/a.yaml'] })
    assert.deepEqual(platformOpenCommand('/tmp/a.yaml', 'linux'), { command: 'xdg-open', args: ['/tmp/a.yaml'] })

    // A caller cannot name a path: unknown targets are refused before spawning.
    const refused = openConfigFile('/etc/passwd', { env, spawnImpl })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'LLM_OPEN_TARGET_INVALID')
    assert.equal(spawned.length, 1)
    assert.equal(configPathFor('credentials', env).endsWith('.credentials.yaml'), true)
    void readFileSync(new URL('../server/llm/openConfigFile.js', import.meta.url), 'utf8')
  })
})

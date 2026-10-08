import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { importLegacyProviders, legacyProviderId } from '../server/llm/importLegacyProviders.js'
import { listProviders } from '../server/llm/llmProviderService.js'

// Synthetic keys, assembled at runtime so no literal key-shaped string is committed.
const fakeKey = (name) => ['sk', name, '123456'].join('-')

const ROWS = [
  { key: 'DeepSeek', label: 'DeepSeek 账号', baseUrl: 'https://api.deepseek.com/v1', apiKey: fakeKey('deep'), models: ['deepseek-chat'], enabled: true, isDefault: true, defaultModel: 'deepseek-chat' },
  { key: 'magpie gateway', label: 'Magpie', baseUrl: 'https://magpie.example/v1', apiKey: '', models: ['m-1', 'm-2'], enabled: true, isDefault: false },
  { key: 'off', label: 'Disabled', baseUrl: 'https://off.example/v1', apiKey: fakeKey('off'), models: [], enabled: false },
]

async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'gugo-legacy-'))
  const previous = process.env.GUGO_HOME
  process.env.GUGO_HOME = home
  try {
    return await run(process.env)
  } finally {
    if (previous === undefined) delete process.env.GUGO_HOME
    else process.env.GUGO_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('legacy keys become legal provider ids', () => {
  assert.equal(legacyProviderId('DeepSeek'), 'deepseek')
  assert.equal(legacyProviderId('magpie gateway'), 'magpie-gateway')
  assert.equal(legacyProviderId('  --Weird!!Key-- '), 'weird-key')
  assert.equal(legacyProviderId(''), '')
})

test('old providers are imported once, disabled ones left behind', async () => {
  await withHome(async (env) => {
    const listImpl = () => ROWS
    const first = importLegacyProviders({ userId: 'user-1', env, listImpl })
    assert.deepEqual(first, { imported: 2, skipped: 1, credentials: 1 })
    const listed = listProviders(env)
    assert.deepEqual(listed.providers.map((provider) => provider.id), ['deepseek', 'magpie-gateway'])
    const deepseek = listed.providers.find((provider) => provider.id === 'deepseek')
    assert.equal(deepseek.credential.configured, true)
    assert.equal(deepseek.credential.descriptor, 'sk-••••••3456')
    assert.deepEqual(deepseek.models.map((model) => model.id), ['deepseek-chat'])
    // The default model travelled with it, and nothing is duplicated on a re-run.
    assert.deepEqual(listed.defaultModel, { provider: 'deepseek', model: 'deepseek-chat' })
    const second = importLegacyProviders({ userId: 'user-1', env, listImpl })
    assert.deepEqual(second, { imported: 0, skipped: 3, credentials: 0 })
    assert.equal(listProviders(env).providers.length, 2)
  })
})

test('without a signed-in user nothing is touched', async () => {
  await withHome(async (env) => {
    assert.deepEqual(importLegacyProviders({ userId: '', env, listImpl: () => ROWS }), { imported: 0, skipped: 0, credentials: 0 })
    assert.deepEqual(listProviders(env).providers, [])
  })
})

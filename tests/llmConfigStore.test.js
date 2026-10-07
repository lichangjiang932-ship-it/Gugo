import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  allStoredSecrets,
  credentialDescriptor,
  readCredentials,
  readSettings,
  redactSecrets,
  resolveApiKey,
  resolveGugoHome,
  writeCredentials,
  writeSettings,
} from '../server/llm/llmConfigStore.js'
import { setCredential } from '../server/llm/llmProviderService.js'

async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'gugo-llm-config-'))
  const previous = process.env.GUGO_HOME
  process.env.GUGO_HOME = home
  try {
    return await run({ env: process.env, home })
  } finally {
    if (previous === undefined) delete process.env.GUGO_HOME
    else process.env.GUGO_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('GUGO_HOME decides where the two files live', async () => {
  withHome(({ env, home }) => {
    assert.equal(resolveGugoHome(env), home)
    assert.equal(resolveGugoHome({}), resolveGugoHome({ GUGO_HOME: '' }))
  })
})

test('settings.yaml round-trips and never needs a key to do it', async () => {
  withHome(({ env }) => {
    assert.deepEqual(readSettings(env), {})
    const next = {
      'agent-default-model': { provider: 'bailian', model: 'qwen3.8-max' },
      llm: { providers: { bailian: { displayName: '百炼', api: 'openai-completions', baseURL: 'https://example/v1', apiKeyEnv: 'BAILIAN_API_KEY', models: [{ id: 'qwen3.8-max' }] } } },
    }
    writeSettings(next, env)
    assert.deepEqual(readSettings(env), next)
  })
})

test('the credential file is written 0600 and the UI only ever sees a descriptor', async () => {
  withHome(({ env, home }) => {
    setCredential('bailian', 'sk-abcdefghijkl', env)
    const stored = readCredentials(env)
    assert.equal(stored.providers.bailian.apiKey, 'sk-abcdefghijkl')
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(home, '.credentials.yaml')).mode & 0o777, 0o600)
    }
    assert.equal(credentialDescriptor('sk-abcdefghijkl'), 'sk-••••••ijkl')
    assert.deepEqual(allStoredSecrets(stored), ['sk-abcdefghijkl'])
    // A key never leaks into a rendered log line.
    assert.equal(redactSecrets('failed with sk-abcdefghijkl', allStoredSecrets(stored)), 'failed with ••••••')
  })
})

test('the environment beats the file, and an empty credential clears it', async () => {
  withHome(({ env }) => {
    writeCredentials({ version: 1, providers: { bailian: { apiKey: 'from-file' } } }, env)
    const provider = { apiKeyEnv: 'BAILIAN_API_KEY' }
    assert.deepEqual(resolveApiKey('bailian', provider, { env: { ...env, BAILIAN_API_KEY: 'from-env' } }), { apiKey: 'from-env', source: 'env' })
    assert.equal(resolveApiKey('bailian', provider, { env }).source, 'credentials')
    assert.deepEqual(resolveApiKey('missing', {}, { env }), { apiKey: '', source: 'none' })
    setCredential('bailian', '', env)
    assert.equal(readCredentials(env).providers.bailian, undefined)
  })
})

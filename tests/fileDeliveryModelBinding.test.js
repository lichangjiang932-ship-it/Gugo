import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { getDiagnosticRuntimeScope } from '../server/core/diagnosticRuntimeScope.js'
import { FileDeliveryModelBindingError, resolveFileDeliveryModelBinding } from '../scripts/file-delivery-verification/modelBinding.mjs'

const SELECTED_KEY = 'synthetic-selected-model-secret'
const OTHER_KEY = 'synthetic-unselected-model-secret'
const HEADER_SECRET = 'synthetic-selected-header-secret'
const VAULT_KEY = '37'.repeat(32)

function fixture(context, { settings, credentials, extraEnv = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gugo-delivery-binding-'))
  context.after(() => rmSync(home, { recursive: true, force: true }))
  if (settings) writeFileSync(join(home, 'settings.yaml'), yaml.dump(settings))
  if (credentials) writeFileSync(join(home, '.credentials.yaml'), yaml.dump(credentials))
  return {
    home,
    env: { GUGO_HOME: home, APP_DB_PATH: join(home, 'must-not-create.db'), CREDENTIAL_ENCRYPTION_KEY: VAULT_KEY, ...extraEnv },
  }
}

function savedSettings({ enabled = true, models = ['shared', 'sibling'], defaultModel = { provider: 'chosen', model: 'shared' } } = {}) {
  return {
    'agent-default-model': defaultModel,
    llm: { providers: {
      chosen: { enabled, baseURL: 'https://chosen.invalid/v1', api: 'openai-responses', models },
      other: { baseURL: 'https://other.invalid/v1', models: ['shared'] },
    } },
  }
}

function filesSnapshot(home) {
  return Object.fromEntries(readdirSync(home).sort().map(name => {
    const path = join(home, name)
    const stat = statSync(path)
    return [name, { hash: createHash('sha256').update(readFileSync(path)).digest('hex'), size: stat.size, mtime: stat.mtimeMs, mode: stat.mode }]
  }))
}

function safeCode(code) {
  return error => {
    assert.equal(error.code, code)
    const publicError = JSON.stringify({ ...error, message: error.message, stack: error.stack })
    for (const secret of [SELECTED_KEY, OTHER_KEY, HEADER_SECRET, VAULT_KEY]) assert.ok(!publicError.includes(secret))
    assert.equal('cause' in error, false)
    assert.equal('details' in error, false)
    return true
  }
}

test('opt-in is strict and checked before any settings, environment or runtime read', async () => {
  const unread = () => { throw new Error('must not read') }
  for (const enabled of [undefined, false, 'true', 1]) {
    await assert.rejects(resolveFileDeliveryModelBinding({ enabled, get env() { return unread() } }, {
      readSettings: unread, loadRuntime: unread,
    }), safeCode('FILE_DELIVERY_MODEL_OPT_IN_REQUIRED'))
  }
})

test('settings default uses production readiness/config and returns only its provider in memory without writes', async context => {
  const { home, env } = fixture(context, {
    settings: savedSettings({ models: [{ id: 'shared', contextWindow: 64000 }, { id: 'sibling', contextWindow: 128000 }] }),
    credentials: { providers: { chosen: { apiKey: SELECTED_KEY }, other: { apiKey: OTHER_KEY } } },
    extraEnv: { UNRELATED_SECRET: OTHER_KEY, MODEL_PROVIDER_OTHER_API_KEY: OTHER_KEY },
  })
  writeFileSync(join(home, '.env'), `MODEL_NAME=must-not-load\nMODEL_API_KEY=${OTHER_KEY}`)
  writeFileSync(join(home, 'session-do-not-read.json'), 'synthetic unrelated session')
  const before = filesSnapshot(home)
  const result = await resolveFileDeliveryModelBinding({ enabled: true, env })
  assert.deepEqual(result.binding, {
    providerId: 'chosen', modelName: 'shared', configRevision: result.binding.configRevision, source: 'environment',
  })
  assert.ok(result.binding.configRevision > 0)
  assert.equal(result.transport.apiKey, SELECTED_KEY)
  assert.equal(result.transport.baseUrl, 'https://chosen.invalid/v1')
  assert.equal(result.transport.providerKey, 'chosen')
  assert.equal(result.transport.profileOverrides.kind, 'openai-responses')
  assert.equal(result.transport.profile.contextWindow, 64000)
  assert.deepEqual(Object.keys(result.transport.modelProfiles), ['shared'])
  assert.equal('env' in result, false)
  assert.equal('env' in result.transport, false)
  assert.equal('readiness' in result.binding, false)
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.transport))
  // Inspect values in memory, never stringify/persist credential-bearing output.
  assert.ok(!Object.values(result.transport).includes(OTHER_KEY))
  assert.deepEqual(filesSnapshot(home), before)
})

test('already-exported environment wins its named credential and settings profile remains selected', async context => {
  const settings = savedSettings()
  settings.llm.providers.chosen.apiKeyEnv = 'SYNTHETIC_CHOSEN_KEY'
  const { env } = fixture(context, {
    settings,
    credentials: { providers: { chosen: { apiKey: 'synthetic-file-fallback' } } },
    extraEnv: { SYNTHETIC_CHOSEN_KEY: SELECTED_KEY },
  })
  const result = await resolveFileDeliveryModelBinding({ enabled: true, env })
  assert.equal(result.transport.apiKey, SELECTED_KEY)
  assert.equal(result.transport.profileOverrides.kind, 'openai-responses')
  assert.equal('SYNTHETIC_CHOSEN_KEY' in result.transport, false)
})

test('environment binding containing multiple providers is projected to the exact default transport', async context => {
  const { home, env } = fixture(context, { extraEnv: {
    MODEL_NAME: 'chosen-model', MODEL_PROVIDERS: 'chosen,other',
    MODEL_PROVIDER_CHOSEN_BASE_URL: 'https://chosen.invalid/v1',
    MODEL_PROVIDER_CHOSEN_API_KEY: SELECTED_KEY,
    MODEL_PROVIDER_CHOSEN_MODELS: 'chosen-model,sibling',
    MODEL_PROVIDER_CHOSEN_HEADERS: JSON.stringify({ 'x-fixture-secret': HEADER_SECRET }),
    MODEL_PROVIDER_CHOSEN_PROFILE: JSON.stringify({
      kind: 'openai-responses', contextWindow: 96000, notAProfileField: OTHER_KEY,
      models: { 'chosen-model': { contextWindow: 72000 }, sibling: { contextWindow: 180000, private: OTHER_KEY } },
    }),
    MODEL_PROVIDER_OTHER_BASE_URL: 'https://other.invalid/v1',
    MODEL_PROVIDER_OTHER_API_KEY: OTHER_KEY,
    MODEL_PROVIDER_OTHER_MODELS: 'other-model',
    MODEL_API_KEY: OTHER_KEY,
    UNRELATED_SECRET: OTHER_KEY,
  } })
  const before = filesSnapshot(home)
  const result = await resolveFileDeliveryModelBinding({ enabled: true, env })
  assert.equal(result.binding.providerId, 'chosen')
  assert.equal(result.transport.modelName, 'chosen-model')
  assert.equal(result.transport.apiKey, SELECTED_KEY)
  assert.deepEqual(result.transport.headers, { 'x-fixture-secret': HEADER_SECRET })
  assert.equal(result.transport.profile.contextWindow, 72000)
  assert.deepEqual(result.transport.modelProfiles, { 'chosen-model': { contextWindow: 72000 } })
  assert.equal(result.transport.profileOverrides.models, undefined)
  assert.equal(result.transport.profileOverrides.notAProfileField, undefined)
  assert.equal(result.transport.MODEL_PROVIDERS, undefined)
  assert.ok(!Object.values(result.transport).includes(OTHER_KEY))
  assert.deepEqual(filesSnapshot(home), before)
})

test('legacy single-provider exported env needs no fabricated vault or readiness row', async context => {
  const { home, env } = fixture(context, { extraEnv: {
    CREDENTIAL_ENCRYPTION_KEY: '',
    MODEL_BASE_URL: 'https://legacy.invalid/v1', MODEL_NAME: 'legacy-model', MODEL_API_KEY: SELECTED_KEY,
    MODEL_HEADERS: JSON.stringify({ 'x-fixture-secret': HEADER_SECRET }),
  } })
  const result = await resolveFileDeliveryModelBinding({ enabled: true, env })
  assert.equal(result.binding.providerId, null)
  assert.equal(result.binding.configRevision, null)
  assert.equal(result.transport.apiKey, SELECTED_KEY)
  assert.equal(result.transport.profile.supportsTools, true)
  assert.deepEqual(readdirSync(home), [])
})

test('missing/incomplete/disabled defaults fail closed instead of selecting another usable provider', async context => {
  const missingEndpoint = savedSettings()
  delete missingEndpoint.llm.providers.chosen.baseURL
  const cases = [
    [{ llm: savedSettings().llm }, {}, 'FILE_DELIVERY_MODEL_DEFAULT_MISSING'],
    [missingEndpoint, {}, 'MODEL_CONFIG_MISSING'],
    [savedSettings(), { MODEL_NAME: 'nonexistent' }, 'FILE_DELIVERY_MODEL_MODEL_DISABLED'],
    [savedSettings({ enabled: false }), {}, 'FILE_DELIVERY_MODEL_PROVIDER_DISABLED'],
    [savedSettings({ models: [{ id: 'shared', enabled: false }, 'sibling'] }), {}, 'FILE_DELIVERY_MODEL_MODEL_DISABLED'],
    [savedSettings({ defaultModel: { provider: 'missing', model: 'shared' } }), {}, 'FILE_DELIVERY_MODEL_MODEL_DISABLED'],
    [savedSettings({ defaultModel: { model: 'shared' } }), {}, 'FILE_DELIVERY_MODEL_DEFAULT_MISSING'],
    [savedSettings(), { MODEL_NAME: 'shared' }, 'FILE_DELIVERY_MODEL_AMBIGUOUS'],
  ]
  for (const [settings, extraEnv, code] of cases) {
    const { home, env } = fixture(context, { settings, extraEnv })
    const before = filesSnapshot(home)
    await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }), safeCode(code))
    assert.deepEqual(filesSnapshot(home), before)
  }
})

test('colliding normalized env provider namespaces are rejected', async context => {
  const { env } = fixture(context, { extraEnv: {
    MODEL_NAME: 'unique', MODEL_PROVIDERS: 'a-b,a_b',
    MODEL_PROVIDER_A_B_BASE_URL: 'https://fixture.invalid/v1', MODEL_PROVIDER_A_B_MODELS: 'unique',
  } })
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }), safeCode('FILE_DELIVERY_MODEL_AMBIGUOUS'))
})

test('duplicate provider declarations cannot be resolved by incidental list order', async context => {
  const { env } = fixture(context, { extraEnv: {
    MODEL_NAME: 'unique', MODEL_PROVIDERS: 'same,same',
    MODEL_PROVIDER_SAME_BASE_URL: 'https://fixture.invalid/v1', MODEL_PROVIDER_SAME_MODELS: 'unique',
  } })
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }), safeCode('FILE_DELIVERY_MODEL_AMBIGUOUS'))
})

test('Agent-incompatible endpoint is refused by the production readiness assertion', async context => {
  const { env } = fixture(context, { extraEnv: {
    MODEL_PROVIDERS: 'chosen', MODEL_NAME: 'chosen-model',
    MODEL_PROVIDER_CHOSEN_MODELS: 'chosen-model',
    MODEL_PROVIDER_CHOSEN_BASE_URL: 'https://fixture.invalid/v1',
    MODEL_PROVIDER_CHOSEN_PROFILE: JSON.stringify({ supportsTools: false }),
  } })
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }), safeCode('MODEL_PROVIDER_CHAT_ONLY'))
})

test('fingerprint only reads an existing explicitly located vault key, never creates or repairs one', async context => {
  const { home, env } = fixture(context, { settings: savedSettings(), extraEnv: { CREDENTIAL_ENCRYPTION_KEY: '' } })
  const before = filesSnapshot(home)
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }), safeCode('FILE_DELIVERY_MODEL_VAULT_UNAVAILABLE'))
  assert.deepEqual(filesSnapshot(home), before)
  writeFileSync(join(home, '.credentials.key'), VAULT_KEY)
  const withKey = filesSnapshot(home)
  const result = await resolveFileDeliveryModelBinding({ enabled: true, env })
  assert.ok(result.binding.configRevision > 0)
  assert.deepEqual(filesSnapshot(home), withKey)
  const noLocator = { GUGO_HOME: home }
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env: noLocator }), safeCode('FILE_DELIVERY_MODEL_VAULT_UNAVAILABLE'))
})

test('DB-backed selection and accidental DB access are denied inside a real diagnostic read-only scope', async context => {
  const { home, env } = fixture(context)
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env, userId: 'synthetic-owner' }),
    safeCode('FILE_DELIVERY_MODEL_DATABASE_UNAVAILABLE'))
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }, {
    loadRuntime: async () => {
      const scope = getDiagnosticRuntimeScope()
      assert.equal(scope.credentialsReadOnly, true)
      assert.equal(scope.env.CREDENTIAL_ENCRYPTION_KEY, VAULT_KEY)
      const { getDb } = await import('../server/db.js')
      getDb().prepare('DO NOT READ OR WRITE DATABASE')
    },
  }), safeCode('FILE_DELIVERY_MODEL_DATABASE_UNAVAILABLE'))
  assert.deepEqual(readdirSync(home), [])
})

test('dependency failures cannot leak secret-bearing messages, causes, code or YAML context', async context => {
  const { env } = fixture(context)
  for (const dependencies of [
    { readSettings: () => { throw Object.assign(new Error(SELECTED_KEY), { code: OTHER_KEY, cause: HEADER_SECRET }) } },
    { loadRuntime: async () => { throw new Error(HEADER_SECRET) } },
    { loadRuntime: async () => { throw Object.assign(new FileDeliveryModelBindingError(OTHER_KEY), { message: HEADER_SECRET, cause: SELECTED_KEY }) } },
  ]) {
    await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }, dependencies),
      safeCode('FILE_DELIVERY_MODEL_UNAVAILABLE'))
  }
})

test('runtime binding/config identity drift is blocked rather than silently switching', async context => {
  const { env } = fixture(context, { settings: savedSettings() })
  const provider = { id: 'chosen', models: ['shared'], baseUrl: 'https://chosen.invalid/v1', apiKey: SELECTED_KEY }
  const runtime = {
    getModelProviders: () => [provider],
    resolveAgentModelRuntimeBinding: () => ({ source: 'environment', providerId: 'other', modelName: 'shared', env }),
  }
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }, { loadRuntime: async () => runtime }),
    safeCode('FILE_DELIVERY_MODEL_SOURCE_CHANGED'))
  runtime.resolveAgentModelRuntimeBinding = () => ({ source: 'environment', providerId: 'chosen', modelName: 'shared', env })
  runtime.resolveModelConfigForModel = () => ({ configured: true, providerId: 'chosen', modelName: 'shared', baseUrl: provider.baseUrl, apiKey: OTHER_KEY })
  await assert.rejects(resolveFileDeliveryModelBinding({ enabled: true, env }, { loadRuntime: async () => runtime }),
    safeCode('FILE_DELIVERY_MODEL_SOURCE_CHANGED'))
})

test('fresh process emits no model credential output and creates no source files during production imports/binding', context => {
  const { home, env } = fixture(context, {
    settings: savedSettings(),
    credentials: { providers: { chosen: { apiKey: SELECTED_KEY }, other: { apiKey: OTHER_KEY } } },
  })
  const before = filesSnapshot(home)
  const moduleUrl = new URL('../scripts/file-delivery-verification/modelBinding.mjs', import.meta.url).href
  const script = `import {resolveFileDeliveryModelBinding} from ${JSON.stringify(moduleUrl)}; const result = await resolveFileDeliveryModelBinding({enabled:true}); if(result.transport.apiKey !== '${SELECTED_KEY}') process.exitCode = 2;`
  const osEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]))
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: home, env: { ...osEnv, ...env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(result.status, 0)
  assert.equal(result.error, undefined)
  for (const output of [result.stdout, result.stderr]) {
    for (const secret of [SELECTED_KEY, OTHER_KEY, HEADER_SECRET, VAULT_KEY]) assert.ok(!output.includes(secret))
  }
  assert.equal(result.stdout, '')
  assert.deepEqual(filesSnapshot(home), before)
})

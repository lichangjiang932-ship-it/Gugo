import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-model-providers-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const {
  buildUserModelEnv,
  deleteModelProvider,
  listModelProviders,
  normalizeModelProviderBaseUrl,
  recordModelProviderReadiness,
  resolveUserModelProvider,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')
const { callBackgroundModel } = await import('../server/adapters/modelProxy.js')
const {
  assertAgentModelReady,
  resolveAgentModelRuntimeBinding,
} = await import('../server/services/modelReadinessService.js')

const CONCURRENT_PROVIDER_WRITER = fileURLToPath(new URL(
  './fixtures/modelProviderConcurrentWriter.mjs',
  import.meta.url,
))

function runConcurrentProviderWriter(mode, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CONCURRENT_PROVIDER_WRITER,
      mode,
      JSON.stringify({ ...payload, dbPath: process.env.APP_DB_PATH }),
    ], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`provider writer failed (${code ?? signal}): ${stderr || stdout}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (cause) {
        reject(new Error(`provider writer returned invalid JSON: ${stdout || stderr}`, { cause }))
      }
    })
  })
}

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('model providers are user-scoped, redacted and converted to runtime env', () => {
  createUser({ id: 'u-model-1', email: 'model-1@example.com' })
  createUser({ id: 'u-model-2', email: 'model-2@example.com' })
  const provider = upsertModelProvider({
    userId: 'u-model-1',
    provider: {
      key: 'custom-openai',
      label: 'Custom OpenAI',
      baseUrl: 'https://models.example.com/v1/',
      apiKey: 'sk-secret',
      models: ['alpha', 'beta', 'alpha'],
      defaultModel: 'beta',
      headers: { 'X-Tenant': 'atelier' },
      enabled: true,
      isDefault: true,
    },
  })

  assert.equal(provider.baseUrl, 'https://models.example.com/v1')
  assert.equal(provider.hasApiKey, true)
  assert.equal(provider.configRevision, 1)
  assert.equal(provider.readiness, null)
  assert.equal('apiKey' in provider, false)
  assert.deepEqual(provider.models, ['alpha', 'beta'])
  assert.equal(listModelProviders({ userId: 'u-model-2' }).length, 0)

  const env = buildUserModelEnv({ userId: 'u-model-1', env: {} })
  assert.equal(env.MODEL_NAME, 'beta')
  assert.equal(env.MODEL_BASE_URL, 'https://models.example.com/v1')
  assert.equal(env.MODEL_API_KEY, 'sk-secret')
  assert.equal(env.MODEL_PROVIDER_CUSTOM_OPENAI_API_KEY, 'sk-secret')
  assert.equal(env.MODEL_PROVIDER_CUSTOM_OPENAI_LABEL, 'Custom OpenAI')
  assert.equal(env.MODEL_PROVIDER_CUSTOM_OPENAI_MODELS, 'alpha,beta')
  assert.equal(JSON.parse(env.MODEL_PROVIDER_CUSTOM_OPENAI_HEADERS)['X-Tenant'], 'atelier')

  const tested = recordModelProviderReadiness({
    userId: 'u-model-1',
    id: provider.id,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
    now: 1234,
  })
  assert.deepEqual(tested.readiness, {
    chat: true,
    tools: true,
    agent: true,
    mode: 'agent',
    checkedAt: 1234,
    configRevision: 1,
  })

  const updated = upsertModelProvider({
    userId: 'u-model-1',
    provider: { ...provider, apiKey: '', models: ['beta'], defaultModel: 'beta' },
  })
  assert.equal(updated.hasApiKey, true, 'blank API key keeps the existing secret')
  assert.equal(updated.configRevision, 2)
  assert.equal(updated.readiness, null, 'a config change invalidates the old probe')
  assert.equal(buildUserModelEnv({ userId: 'u-model-1', env: {} }).MODEL_PROVIDER_CUSTOM_OPENAI_HEADERS,
    JSON.stringify({ 'X-Tenant': 'atelier' }), 'redacted headers keep their existing values')

  const cleared = upsertModelProvider({
    userId: 'u-model-1',
    provider: { ...updated, clearApiKey: true },
  })
  assert.equal(cleared.hasApiKey, false, 'clearApiKey explicitly removes the stored secret')
  assert.equal(cleared.configRevision, 3)
  assert.equal(deleteModelProvider({ userId: 'u-model-2', id: provider.id }), false)
  assert.equal(deleteModelProvider({ userId: 'u-model-1', id: provider.id }), true)
})

test('model provider Header updates preserve unreturned secrets and explicit replacement can clear all Headers', () => {
  const userId = 'u-model-header-updates'
  createUser({ id: userId, email: 'model-header-updates@example.com' })
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: 'header-updates',
      label: 'Header updates',
      baseUrl: 'https://headers.example.test/v1',
      models: ['header-model'],
      defaultModel: 'header-model',
      headers: {
        Authorization: 'Bearer stored-secret',
        'X-Tenant': 'tenant-a',
      },
      enabled: true,
      isDefault: true,
    },
  })

  const updated = upsertModelProvider({
    userId,
    provider: {
      id: provider.id,
      configRevision: provider.configRevision,
      key: provider.key,
      label: provider.label,
      baseUrl: provider.baseUrl,
      models: provider.models,
      defaultModel: provider.defaultModel,
      enabled: provider.enabled,
      isDefault: provider.isDefault,
      headerUpdates: {
        'X-Tenant': 'tenant-b',
        'X-Trace': 'trace-new',
      },
    },
  })

  assert.deepEqual(Object.keys(updated.headers).sort(), ['Authorization', 'X-Tenant', 'X-Trace'])
  assert.equal(Object.values(updated.headers).every((value) => value === '••••••'), true)
  assert.doesNotMatch(JSON.stringify(updated), /stored-secret|tenant-a|tenant-b|trace-new/)
  assert.deepEqual(
    JSON.parse(buildUserModelEnv({ userId, env: {} }).MODEL_PROVIDER_HEADER_UPDATES_HEADERS),
    {
      Authorization: 'Bearer stored-secret',
      'X-Tenant': 'tenant-b',
      'X-Trace': 'trace-new',
    },
  )

  const cleared = upsertModelProvider({
    userId,
    provider: {
      id: provider.id,
      configRevision: updated.configRevision,
      key: provider.key,
      label: provider.label,
      baseUrl: provider.baseUrl,
      models: provider.models,
      defaultModel: provider.defaultModel,
      enabled: provider.enabled,
      isDefault: provider.isDefault,
      headers: {},
    },
  })
  assert.deepEqual(cleared.headers, {})
  assert.equal(buildUserModelEnv({ userId, env: {} }).MODEL_PROVIDER_HEADER_UPDATES_HEADERS, undefined)
})

test('model provider removes Headers case-insensitively before applying incremental updates', () => {
  const userId = 'u-model-header-removal'
  createUser({ id: userId, email: 'model-header-removal@example.com' })
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: 'header-removal',
      label: 'Header removal',
      baseUrl: 'https://header-removal.example.test/v1',
      models: ['header-model'],
      defaultModel: 'header-model',
      headers: {
        Authorization: 'Bearer removed-secret',
        'X-Tenant': 'removed-tenant-secret',
        'X-Keep': 'kept-secret',
      },
    },
  })

  const updated = upsertModelProvider({
    userId,
    provider: {
      id: provider.id,
      configRevision: provider.configRevision,
      key: provider.key,
      label: provider.label,
      baseUrl: provider.baseUrl,
      models: provider.models,
      defaultModel: provider.defaultModel,
      removeHeaderKeys: [' authorization ', 'X-TENANT', 'AUTHORIZATION'],
      headerUpdates: {
        'x-tenant': 'replacement-tenant-secret',
        'X-Trace': 'new-trace-secret',
      },
    },
  })

  assert.deepEqual(Object.keys(updated.headers).sort(), ['X-Keep', 'X-Trace', 'x-tenant'])
  assert.equal(Object.values(updated.headers).every((value) => value === '••••••'), true)
  assert.doesNotMatch(
    JSON.stringify(updated),
    /removed-secret|removed-tenant-secret|kept-secret|replacement-tenant-secret|new-trace-secret/,
  )
  const runtimeHeaders = JSON.parse(
    buildUserModelEnv({ userId, env: {} }).MODEL_PROVIDER_HEADER_REMOVAL_HEADERS,
  )
  assert.deepEqual(runtimeHeaders, {
    'X-Keep': 'kept-secret',
    'x-tenant': 'replacement-tenant-secret',
    'X-Trace': 'new-trace-secret',
  })
  assert.equal(Object.keys(runtimeHeaders).some((name) => name.toLowerCase() === 'authorization'), false)

  assert.throws(
    () => upsertModelProvider({
      userId,
      provider: {
        id: provider.id,
        configRevision: updated.configRevision,
        key: provider.key,
        label: provider.label,
        baseUrl: provider.baseUrl,
        models: provider.models,
        defaultModel: provider.defaultModel,
        headers: {},
        removeHeaderKeys: [],
      },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_HEADERS_CONFLICT'
      && error?.statusCode === 400
      && error?.field === 'removeHeaderKeys',
  )
})

test('model provider rejects malformed Header collections, names and values with structured errors', () => {
  const userId = 'u-model-header-validation'
  createUser({ id: userId, email: 'model-header-validation@example.com' })
  const baseProvider = {
    key: 'header-validation',
    label: 'Header validation',
    baseUrl: 'https://header-validation.example.test/v1',
    models: ['header-model'],
    defaultModel: 'header-model',
  }

  class HeaderBag {}
  for (const [field, value] of [
    ['headers', null],
    ['headers', []],
    ['headers', 'X-Test: value'],
    ['headers', new HeaderBag()],
    ['headerUpdates', null],
    ['headerUpdates', []],
    ['headerUpdates', 'X-Test: value'],
    ['headerUpdates', new HeaderBag()],
  ]) {
    assert.throws(
      () => upsertModelProvider({
        userId,
        provider: { ...baseProvider, [field]: value },
      }),
      (error) => error?.code === 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'
        && error?.statusCode === 400
        && error?.field === field,
    )
  }

  for (const removeHeaderKeys of [
    null,
    {},
    'Authorization',
    ['Authorization', 1],
    [new String('Authorization')],
  ]) {
    assert.throws(
      () => upsertModelProvider({
        userId,
        provider: { ...baseProvider, removeHeaderKeys },
      }),
      (error) => error?.code === 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'
        && error?.statusCode === 400
        && error?.field === 'removeHeaderKeys',
    )
  }

  for (const removeHeaderKeys of [
    [''],
    ['   '],
    ['X Bad'],
    ['X-Test\r\nInjected'],
  ]) {
    assert.throws(
      () => upsertModelProvider({
        userId,
        provider: { ...baseProvider, removeHeaderKeys },
      }),
      (error) => error?.code === 'MODEL_PROVIDER_HEADER_NAME_INVALID'
        && error?.statusCode === 400
        && error?.field === 'removeHeaderKeys',
    )
  }

  for (const headers of [
    { '': 'empty' },
    { '   ': 'blank' },
    { 'X-Test\r\nInjected': 'unsafe' },
    { 'X Test': 'space' },
  ]) {
    assert.throws(
      () => upsertModelProvider({ userId, provider: { ...baseProvider, headers } }),
      (error) => error?.code === 'MODEL_PROVIDER_HEADER_NAME_INVALID'
        && error?.statusCode === 400
        && error?.field === 'headers',
    )
  }

  assert.throws(
    () => upsertModelProvider({
      userId,
      provider: {
        ...baseProvider,
        headers: { 'X-Unsafe': { toString() { throw new Error('must not escape') } } },
      },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_HEADER_VALUE_INVALID'
      && error?.statusCode === 400
      && error?.field === 'headers',
  )
  assert.throws(
    () => upsertModelProvider({
      userId,
      provider: { ...baseProvider, headerUpdates: { 'X-Unsafe': 'ok\r\ninjected' } },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_HEADER_VALUE_INVALID'
      && error?.statusCode === 400
      && error?.field === 'headerUpdates',
  )
})

test('model provider safely stringifies Header values while preserving redacted incremental updates', () => {
  const userId = 'u-model-header-string-values'
  createUser({ id: userId, email: 'model-header-string-values@example.com' })
  const nullPrototypeHeaders = Object.assign(Object.create(null), {
    Authorization: 'Bearer stored-secret',
    'X-Count': 1,
    'X-Optional': null,
  })
  const original = upsertModelProvider({
    userId,
    provider: {
      key: 'header-string-values',
      label: 'Header string values',
      baseUrl: 'https://header-string-values.example.test/v1',
      models: ['header-model'],
      headers: nullPrototypeHeaders,
    },
  })

  const updated = upsertModelProvider({
    userId,
    provider: {
      id: original.id,
      configRevision: original.configRevision,
      key: original.key,
      label: original.label,
      baseUrl: original.baseUrl,
      models: original.models,
      defaultModel: original.defaultModel,
      enabled: original.enabled,
      isDefault: original.isDefault,
      headerUpdates: {
        Authorization: '••••••',
        'X-Count': 2,
        'X-Enabled': true,
      },
    },
  })
  assert.deepEqual(
    JSON.parse(buildUserModelEnv({ userId, env: {} }).MODEL_PROVIDER_HEADER_STRING_VALUES_HEADERS),
    {
      Authorization: 'Bearer stored-secret',
      'X-Count': '2',
      'X-Optional': '',
      'X-Enabled': 'true',
    },
  )
  assert.equal(updated.headers.Authorization, '••••••')
})

test('model provider rejects explicitly submitted invalid numeric configuration with exact field paths', () => {
  const userId = 'u-model-numeric-validation'
  createUser({ id: userId, email: 'model-numeric-validation@example.com' })
  const baseProvider = {
    key: 'numeric-validation',
    label: 'Numeric validation',
    baseUrl: 'https://numeric-validation.example.test/v1',
    models: ['numeric-model'],
    defaultModel: 'numeric-model',
  }
  const cases = [
    [{ contextWindow: 1024.5 }, 'contextWindow', 'safeInteger', 1024],
    [{ firstTokenTimeoutMs: 999 }, 'firstTokenTimeoutMs', 'min', 1000],
    [{ idleTimeoutMs: '9007199254740992' }, 'idleTimeoutMs', 'safeInteger', 1000],
    [{
      modelProfiles: { 'numeric-model': { contextWindow: 1023 } },
    }, 'modelProfiles.numeric-model.contextWindow', 'min', 1024],
    [{
      modelProfiles: { 'numeric-model': { maxOutputTokens: '1.5' } },
    }, 'modelProfiles.numeric-model.maxOutputTokens', 'integer', 1],
  ]

  for (const [submitted, field, reason, min] of cases) {
    assert.throws(
      () => upsertModelProvider({
        userId,
        provider: { ...baseProvider, ...submitted },
      }),
      (error) => error?.code === 'MODEL_PROVIDER_NUMERIC_FIELD_INVALID'
        && error?.statusCode === 400
        && error?.field === field
        && error?.reason === reason
        && error?.min === min
        && error?.max === Number.MAX_SAFE_INTEGER,
    )
  }
})

test('model provider numeric configuration accepts empty values and inclusive integer boundaries', () => {
  const userId = 'u-model-numeric-boundaries'
  createUser({ id: userId, email: 'model-numeric-boundaries@example.com' })
  const minimum = upsertModelProvider({
    userId,
    provider: {
      key: 'numeric-boundaries',
      label: 'Numeric boundaries',
      baseUrl: 'https://numeric-boundaries.example.test/v1',
      models: ['numeric-model'],
      defaultModel: 'numeric-model',
      contextWindow: 1024,
      firstTokenTimeoutMs: '1000',
      idleTimeoutMs: 1000,
      modelProfiles: {
        'numeric-model': { contextWindow: '1024', maxOutputTokens: 1 },
      },
    },
  })
  assert.equal(minimum.contextWindow, 1024)
  assert.equal(minimum.firstTokenTimeoutMs, 1000)
  assert.equal(minimum.idleTimeoutMs, 1000)
  assert.deepEqual(minimum.modelProfiles['numeric-model'], {
    contextWindow: 1024,
    maxOutputTokens: 1,
  })

  const maximum = upsertModelProvider({
    userId,
    provider: {
      ...minimum,
      contextWindow: Number.MAX_SAFE_INTEGER,
      firstTokenTimeoutMs: Number.MAX_SAFE_INTEGER,
      idleTimeoutMs: Number.MAX_SAFE_INTEGER,
      modelProfiles: {
        'numeric-model': {
          contextWindow: Number.MAX_SAFE_INTEGER,
          maxOutputTokens: Number.MAX_SAFE_INTEGER,
        },
      },
    },
  })
  assert.equal(maximum.contextWindow, Number.MAX_SAFE_INTEGER)
  assert.equal(maximum.firstTokenTimeoutMs, Number.MAX_SAFE_INTEGER)
  assert.equal(maximum.idleTimeoutMs, Number.MAX_SAFE_INTEGER)
  assert.equal(maximum.modelProfiles['numeric-model'].contextWindow, Number.MAX_SAFE_INTEGER)
  assert.equal(maximum.modelProfiles['numeric-model'].maxOutputTokens, Number.MAX_SAFE_INTEGER)

  const cleared = upsertModelProvider({
    userId,
    provider: {
      ...maximum,
      contextWindow: '',
      firstTokenTimeoutMs: null,
      idleTimeoutMs: '   ',
      modelProfiles: {
        'numeric-model': {
          contextWindow: null,
          maxOutputTokens: '',
          supportsTools: true,
        },
      },
    },
  })
  assert.equal(cleared.contextWindow, null)
  assert.equal(cleared.firstTokenTimeoutMs, null)
  assert.equal(cleared.idleTimeoutMs, null)
  assert.deepEqual(cleared.modelProfiles['numeric-model'], { supportsTools: true })
})

test('legacy database numeric values remain readable when numeric fields are omitted from an update', () => {
  const userId = 'u-model-legacy-numeric-values'
  createUser({ id: userId, email: 'model-legacy-numeric-values@example.com' })
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: 'legacy-numeric-values',
      label: 'Legacy numeric values',
      baseUrl: 'https://legacy-numeric-values.example.test/v1',
      models: ['legacy-model'],
      defaultModel: 'legacy-model',
    },
  })
  getDb().prepare(`UPDATE model_providers
    SET context_window = ?, first_token_timeout_ms = ?, idle_timeout_ms = ?, model_profiles_json = ?
    WHERE id = ?`).run(
    64,
    10,
    20,
    JSON.stringify({
      'legacy-model': { contextWindow: 32.75, maxOutputTokens: 'invalid', supportsTools: true },
    }),
    provider.id,
  )

  const [legacy] = listModelProviders({ userId })
  assert.equal(legacy.contextWindow, 64)
  assert.equal(legacy.firstTokenTimeoutMs, 10)
  assert.equal(legacy.idleTimeoutMs, 20)
  assert.deepEqual(legacy.modelProfiles['legacy-model'], { contextWindow: 32, supportsTools: true })

  const relabeled = upsertModelProvider({
    userId,
    provider: {
      id: legacy.id,
      configRevision: legacy.configRevision,
      key: legacy.key,
      label: 'Legacy numeric values relabeled',
      baseUrl: legacy.baseUrl,
      models: legacy.models,
      defaultModel: legacy.defaultModel,
    },
  })
  assert.equal(relabeled.contextWindow, 64)
  assert.equal(relabeled.firstTokenTimeoutMs, 10)
  assert.equal(relabeled.idleTimeoutMs, 20)
  assert.deepEqual(relabeled.modelProfiles['legacy-model'], { contextWindow: 32, supportsTools: true })
})

test('local model provider works without an API key', () => {
  createUser({ id: 'u-model-local', email: 'model-local@example.com' })
  const provider = upsertModelProvider({
    userId: 'u-model-local',
    provider: {
      key: 'ollama',
      label: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      models: ['qwen3:8b'],
      defaultModel: 'qwen3:8b',
      enabled: true,
    },
  })

  assert.equal(provider.hasApiKey, false)
  assert.equal(provider.isDefault, true)
  const env = buildUserModelEnv({ userId: 'u-model-local', env: {} })
  assert.equal(env.MODEL_PROVIDER_OLLAMA_API_KEY, '')
  assert.equal(env.MODEL_PROVIDER_OLLAMA_BASE_URL, 'http://127.0.0.1:11434/v1')
  assert.equal(env.MODEL_BASE_URL, 'http://127.0.0.1:11434/v1')
  assert.equal(env.MODEL_API_KEY, '')
  assert.equal(env.MODEL_NAME, 'qwen3:8b')
})

test('saved provider is directly usable by background model calls without .env model fields', async () => {
  createUser({ id: 'u-model-background', email: 'model-background@example.com' })
  upsertModelProvider({
    userId: 'u-model-background',
    provider: {
      key: 'saved-cloud',
      label: 'Saved Cloud',
      baseUrl: 'https://models.example.test/v1',
      apiKey: 'saved-secret',
      models: ['saved-model'],
      defaultModel: 'saved-model',
      enabled: true,
      isDefault: true,
    },
  })

  let request
  const reply = await callBackgroundModel({
    userId: 'u-model-background',
    env: {},
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'saved provider works' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  assert.equal(reply, 'saved provider works')
  assert.equal(request.url, 'https://models.example.test/v1/chat/completions')
  assert.equal(request.init.headers.Authorization, 'Bearer saved-secret')
  assert.equal(JSON.parse(request.init.body).model, 'saved-model')
})

test('deleting a referenced provider preserves durable model bindings', () => {
  const userId = 'u-model-delete-reference'
  createUser({ id: userId, email: 'model-delete-reference@example.com' })
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: 'referenced-provider',
      baseUrl: 'https://models.example.test/v1',
      models: ['referenced-model'],
      defaultModel: 'referenced-model',
    },
  })
  getDb().prepare(`
    INSERT INTO jobs (
      id, user_id, title, prompt, status, created_at, updated_at,
      model_name, model_provider_id, model_config_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'job-provider-reference', userId, 'Referenced job', 'Keep the binding', 'completed', 1, 1,
    'referenced-model', provider.id, provider.configRevision,
  )

  assert.throws(
    () => deleteModelProvider({ userId, id: provider.id }),
    (error) => error?.code === 'MODEL_PROVIDER_IN_USE'
      && error?.statusCode === 409
      && error?.action === 'clear_provider_references'
      && error?.providerId === provider.id
      && error?.details?.total === 1
      && error?.details?.references?.jobs === 1,
  )
  assert.equal(listModelProviders({ userId })[0]?.id, provider.id)
  assert.equal(
    getDb().prepare('SELECT model_provider_id FROM jobs WHERE id = ?').get('job-provider-reference')?.model_provider_id,
    provider.id,
  )
})

test('provider deletion uses SQLite secure delete and truncates credential WAL frames', () => {
  const userId = 'u-model-secure-delete'
  createUser({ id: userId, email: 'model-secure-delete@example.com' })
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: 'secure-delete-provider',
      baseUrl: 'https://secure-delete.example.test/v1',
      apiKey: 'credential-that-must-not-survive',
      headers: { 'X-Private-Token': 'private-header-that-must-not-survive' },
      models: ['secure-delete-model'],
      defaultModel: 'secure-delete-model',
    },
  })
  const stored = getDb().prepare(
    'SELECT secret_json, headers_json FROM model_providers WHERE id = ?',
  ).get(provider.id)

  assert.equal(getDb().pragma('secure_delete', { simple: true }), 1)
  assert.equal(deleteModelProvider({ userId, id: provider.id }), true)
  assert.equal(getDb().prepare('SELECT 1 FROM model_providers WHERE id = ?').get(provider.id), undefined)

  const walPath = `${process.env.APP_DB_PATH}-wal`
  const databaseBytes = fs.readFileSync(process.env.APP_DB_PATH)
  const walBytes = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0)
  for (const envelope of [stored.secret_json, stored.headers_json]) {
    const bytes = Buffer.from(envelope)
    assert.equal(databaseBytes.includes(bytes), false)
    assert.equal(walBytes.includes(bytes), false)
  }
  assert.equal(walBytes.length, 0)
})

test('model readiness is stored independently for every provider model', () => {
  createUser({ id: 'u-model-per-model-readiness', email: 'model-per-model-readiness@example.com' })
  const provider = upsertModelProvider({
    userId: 'u-model-per-model-readiness',
    provider: {
      key: 'per-model-readiness',
      baseUrl: 'https://per-model.example.test/v1',
      models: ['default-model', 'agent-model'],
      defaultModel: 'default-model',
    },
  })

  const agentTested = recordModelProviderReadiness({
    userId: 'u-model-per-model-readiness',
    id: provider.id,
    modelName: 'agent-model',
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
    now: 1001,
  })
  assert.equal(agentTested.readiness, null, 'testing a non-default model must not verify the default model')
  assert.deepEqual(Object.keys(agentTested.modelReadiness), ['agent-model'])
  assert.equal(agentTested.modelReadiness['agent-model'].checkedAt, 1001)
  assert.equal(resolveAgentModelRuntimeBinding({
    userId: 'u-model-per-model-readiness',
    providerId: provider.id,
    modelName: 'agent-model',
    env: {},
  }).modelName, 'agent-model')
  assert.throws(
    () => resolveAgentModelRuntimeBinding({
      userId: 'u-model-per-model-readiness',
      providerId: provider.id,
      modelName: 'default-model',
      env: {},
    }),
    (error) => error?.code === 'MODEL_PROVIDER_UNVERIFIED',
  )

  const defaultTested = recordModelProviderReadiness({
    userId: 'u-model-per-model-readiness',
    id: provider.id,
    modelName: 'default-model',
    readiness: { chat: true, tools: false, agent: false, mode: 'chat_only' },
    now: 1002,
  })
  assert.equal(defaultTested.readiness.mode, 'chat_only')
  assert.equal(defaultTested.modelReadiness['default-model'].checkedAt, 1002)
  assert.equal(defaultTested.modelReadiness['agent-model'].checkedAt, 1001)
})

test('legacy provider-wide readiness is attributed only to the default model', () => {
  createUser({ id: 'u-model-legacy-readiness', email: 'model-legacy-readiness@example.com' })
  const provider = upsertModelProvider({
    userId: 'u-model-legacy-readiness',
    provider: {
      key: 'legacy-readiness',
      baseUrl: 'https://legacy-readiness.example.test/v1',
      models: ['legacy-default', 'legacy-other'],
      defaultModel: 'legacy-default',
    },
  })
  const legacy = {
    chat: true,
    tools: true,
    agent: true,
    mode: 'agent',
    checkedAt: 2001,
    configRevision: provider.configRevision,
  }
  getDb().prepare('UPDATE model_providers SET readiness_json = ? WHERE id = ?').run(
    JSON.stringify(legacy),
    provider.id,
  )

  const [listed] = listModelProviders({ userId: 'u-model-legacy-readiness' })
  assert.deepEqual(listed.readiness, legacy)
  assert.deepEqual(listed.modelReadiness, { 'legacy-default': legacy })
  assert.equal(listed.modelReadiness['legacy-other'], undefined)

  const upgraded = recordModelProviderReadiness({
    userId: 'u-model-legacy-readiness',
    id: provider.id,
    modelName: 'legacy-other',
    readiness: { chat: false, tools: false, agent: false, mode: 'unavailable' },
    now: 2002,
  })
  assert.deepEqual(upgraded.modelReadiness['legacy-default'], legacy)
  assert.equal(upgraded.modelReadiness['legacy-other'].mode, 'unavailable')
  assert.equal(upgraded.readiness.mode, 'agent')
})

test('database providers do not inherit secrets from a same-key environment provider', async () => {
  createUser({ id: 'u-model-env-secret-isolation', email: 'model-env-secret-isolation@example.com' })
  upsertModelProvider({
    userId: 'u-model-env-secret-isolation',
    provider: {
      key: 'shadow',
      label: 'Database Shadow',
      baseUrl: 'https://database-shadow.example.test/v1',
      apiKey: '',
      headers: {},
      models: ['database-shadow-model'],
      defaultModel: 'database-shadow-model',
      enabled: true,
      isDefault: true,
    },
  })
  const environment = {
    MODEL_PROVIDERS: 'shadow,shadow_box',
    MODEL_PROVIDER_SHADOW_BASE_URL: 'https://environment-shadow.example.test/v1',
    MODEL_PROVIDER_SHADOW_API_KEY: 'environment-shadow-api-key',
    MODEL_PROVIDER_SHADOW_MODELS: 'environment-shadow-model',
    MODEL_PROVIDER_SHADOW_HEADERS: JSON.stringify({
      Authorization: 'Bearer environment-shadow-secret',
      'X-Environment-Secret': 'must-not-leak',
    }),
    MODEL_PROVIDER_SHADOW_PROFILE: JSON.stringify({ supportsTools: true }),
    MODEL_PROVIDER_SHADOW_FUTURE_SECRET: 'future-secret-must-not-leak',
    MODEL_PROVIDER_SHADOW_BOX_BASE_URL: 'https://shadow-box.example.test/v1',
    MODEL_PROVIDER_SHADOW_BOX_API_KEY: 'shadow-box-secret',
    MODEL_PROVIDER_SHADOW_BOX_MODELS: 'shadow-box-model',
    MODEL_TEMPERATURE: '0.25',
    MODEL_MAX_TOKENS: '321',
  }

  const runtimeEnv = buildUserModelEnv({ userId: 'u-model-env-secret-isolation', env: environment })
  assert.equal(runtimeEnv.MODEL_PROVIDER_SHADOW_BASE_URL, 'https://database-shadow.example.test/v1')
  assert.equal(runtimeEnv.MODEL_PROVIDER_SHADOW_API_KEY, '')
  assert.equal(runtimeEnv.MODEL_PROVIDER_SHADOW_MODELS, 'database-shadow-model')
  assert.equal('MODEL_PROVIDER_SHADOW_HEADERS' in runtimeEnv, false)
  assert.equal('MODEL_PROVIDER_SHADOW_PROFILE' in runtimeEnv, false)
  assert.equal('MODEL_PROVIDER_SHADOW_FUTURE_SECRET' in runtimeEnv, false)
  assert.equal(runtimeEnv.MODEL_PROVIDER_SHADOW_BOX_API_KEY, 'shadow-box-secret',
    'the longest provider prefix keeps an adjacent environment provider isolated')
  assert.equal(runtimeEnv.MODEL_TEMPERATURE, '0.25')
  assert.equal(runtimeEnv.MODEL_MAX_TOKENS, '321')

  let request
  const reply = await callBackgroundModel({
    userId: 'u-model-env-secret-isolation',
    env: environment,
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'isolated provider works' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  assert.equal(reply, 'isolated provider works')
  assert.equal(request.url, 'https://database-shadow.example.test/v1/chat/completions')
  assert.equal(Object.keys(request.init.headers).some((name) => name.toLowerCase() === 'authorization'), false)
  assert.equal(Object.keys(request.init.headers).some((name) => name.toLowerCase() === 'x-environment-secret'), false)
  assert.equal(JSON.parse(request.init.body).model, 'database-shadow-model')
})

test('model provider validation rejects unsafe identifiers and protocols', () => {
  assert.throws(() => upsertModelProvider({
    userId: 'u-model-1',
    provider: { key: '../bad', baseUrl: 'file:///tmp/model', apiKey: 'x', models: ['m'] },
  }), /Provider ID|Base URL/)
})

test('model provider Base URL rejects embedded credentials, query parameters, and fragments', () => {
  assert.equal(normalizeModelProviderBaseUrl(' https://models.example.com/v1/ '), 'https://models.example.com/v1')
  const unsafe = [
    ['https://user:secret@models.example.com/v1', 'MODEL_PROVIDER_BASE_URL_CREDENTIALS'],
    ['https://@models.example.com/v1', 'MODEL_PROVIDER_BASE_URL_CREDENTIALS'],
    ['https://models.example.com/v1?token=secret', 'MODEL_PROVIDER_BASE_URL_QUERY'],
    ['https://models.example.com/v1#credentials', 'MODEL_PROVIDER_BASE_URL_FRAGMENT'],
  ]
  for (const [baseUrl, code] of unsafe) {
    assert.throws(
      () => normalizeModelProviderBaseUrl(baseUrl),
      (error) => error.code === code && error.field === 'baseUrl',
    )
  }
})

test('stale readiness results cannot mark a newer provider revision as tested', () => {
  createUser({ id: 'u-model-stale-readiness', email: 'model-stale-readiness@example.com' })
  const original = upsertModelProvider({
    userId: 'u-model-stale-readiness',
    provider: {
      key: 'stale-readiness',
      baseUrl: 'https://old.example.test/v1',
      models: ['stale-model'],
      defaultModel: 'stale-model',
    },
  })
  const updated = upsertModelProvider({
    userId: 'u-model-stale-readiness',
    provider: {
      ...original,
      baseUrl: 'https://new.example.test/v1',
    },
  })

  assert.equal(recordModelProviderReadiness({
    userId: 'u-model-stale-readiness',
    id: original.id,
    expectedConfigRevision: original.configRevision,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  }), null)
  assert.equal(listModelProviders({ userId: 'u-model-stale-readiness' })[0].readiness, null)

  const current = recordModelProviderReadiness({
    userId: 'u-model-stale-readiness',
    id: original.id,
    expectedConfigRevision: updated.configRevision,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })
  assert.equal(current.readiness.configRevision, updated.configRevision)
})

test('concurrent provider updates use config revision CAS and cannot create a mixed configuration', async () => {
  const userId = 'u-model-concurrent-config-cas'
  createUser({ id: userId, email: 'model-concurrent-config-cas@example.com' })
  const original = upsertModelProvider({
    userId,
    provider: {
      key: 'concurrent-config-cas',
      label: 'Concurrent config CAS',
      baseUrl: 'https://original.example.test/v1',
      apiKey: 'original-secret',
      headers: { 'X-Writer': 'original' },
      models: ['original-model'],
      defaultModel: 'original-model',
    },
  })
  const candidates = [
    {
      ...original,
      baseUrl: 'https://writer-a.example.test/v1',
      apiKey: 'writer-a-secret',
      headers: { 'X-Writer': 'a' },
      models: ['writer-a-model'],
      defaultModel: 'writer-a-model',
    },
    {
      ...original,
      baseUrl: 'https://writer-b.example.test/v1',
      apiKey: 'writer-b-secret',
      headers: { 'X-Writer': 'b' },
      models: ['writer-b-model'],
      defaultModel: 'writer-b-model',
    },
  ]

  const results = await Promise.all(candidates.map((provider) => (
    runConcurrentProviderWriter('config', { userId, provider })
  )))
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.code),
    ['MODEL_PROVIDER_CONFIG_CHANGED'],
  )

  const winner = results.find((result) => result.ok).provider
  const winnerCandidate = candidates.find((candidate) => candidate.baseUrl === winner.baseUrl)
  assert.ok(winnerCandidate)
  const [stored] = listModelProviders({ userId, includeSecrets: true })
  assert.equal(stored.configRevision, original.configRevision + 1)
  assert.equal(stored.baseUrl, winner.baseUrl)
  assert.deepEqual(stored.models, winner.models)
  assert.equal(stored.defaultModel, winner.defaultModel)
  assert.equal(stored.apiKey, winnerCandidate.apiKey)
  assert.deepEqual(stored.headers, winnerCandidate.headers)
})

test('concurrent readiness probes on separate SQLite connections preserve both model results', async () => {
  const userId = 'u-model-concurrent-readiness'
  createUser({ id: userId, email: 'model-concurrent-readiness@example.com' })
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: 'concurrent-readiness',
      baseUrl: 'https://concurrent-readiness.example.test/v1',
      models: ['model-a', 'model-b'],
      defaultModel: 'model-a',
    },
  })

  const results = await Promise.all([
    runConcurrentProviderWriter('readiness', {
      userId,
      id: provider.id,
      modelName: 'model-a',
      expectedConfigRevision: provider.configRevision,
      readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
      now: 3001,
    }),
    runConcurrentProviderWriter('readiness', {
      userId,
      id: provider.id,
      modelName: 'model-b',
      expectedConfigRevision: provider.configRevision,
      readiness: { chat: true, tools: false, agent: false, mode: 'chat_only' },
      now: 3002,
    }),
  ])
  assert.equal(results.every((result) => result.ok), true)

  const [stored] = listModelProviders({ userId })
  assert.equal(stored.modelReadiness['model-a'].checkedAt, 3001)
  assert.equal(stored.modelReadiness['model-a'].mode, 'agent')
  assert.equal(stored.modelReadiness['model-b'].checkedAt, 3002)
  assert.equal(stored.modelReadiness['model-b'].mode, 'chat_only')
})

test('provider revision changes only when runtime configuration changes', () => {
  createUser({ id: 'u-model-revision-semantics', email: 'model-revision-semantics@example.com' })
  const original = upsertModelProvider({
    userId: 'u-model-revision-semantics',
    provider: {
      key: 'revision-semantics',
      label: 'Original label',
      baseUrl: 'https://revision.example.test/v1',
      apiKey: 'revision-secret',
      headers: { 'X-Tenant': 'one' },
      models: ['revision-model'],
      defaultModel: 'revision-model',
    },
  })
  const tested = recordModelProviderReadiness({
    userId: 'u-model-revision-semantics',
    id: original.id,
    expectedConfigRevision: original.configRevision,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
    now: 4321,
  })

  const relabeled = upsertModelProvider({
    userId: 'u-model-revision-semantics',
    provider: { ...tested, label: 'Presentation only', isDefault: true },
  })
  assert.equal(relabeled.configRevision, original.configRevision)
  assert.deepEqual(relabeled.readiness, tested.readiness)

  const unchanged = upsertModelProvider({
    userId: 'u-model-revision-semantics',
    provider: { ...relabeled },
  })
  assert.equal(unchanged.configRevision, original.configRevision)
  assert.deepEqual(unchanged.readiness, tested.readiness)

  const runtimeChanged = upsertModelProvider({
    userId: 'u-model-revision-semantics',
    provider: { ...unchanged, baseUrl: 'https://revision-2.example.test/v1' },
  })
  assert.equal(runtimeChanged.configRevision, original.configRevision + 1)
  assert.equal(runtimeChanged.readiness, null)
})

test('provider ids that collapse to the same runtime env prefix are rejected', () => {
  createUser({ id: 'u-model-prefix-collision', email: 'model-prefix-collision@example.com' })
  createUser({ id: 'u-model-prefix-collision-other', email: 'model-prefix-collision-other@example.com' })
  const first = upsertModelProvider({
    userId: 'u-model-prefix-collision',
    provider: {
      key: 'foo-bar',
      baseUrl: 'https://first.example.test/v1',
      apiKey: 'first-secret',
      models: ['first-model'],
    },
  })
  const second = upsertModelProvider({
    userId: 'u-model-prefix-collision',
    provider: {
      key: 'second-provider',
      baseUrl: 'https://second.example.test/v1',
      models: ['second-model'],
    },
  })
  assert.throws(
    () => upsertModelProvider({
      userId: 'u-model-prefix-collision',
      provider: {
        key: 'foo_bar',
        baseUrl: 'https://second.example.test/v1',
        apiKey: 'second-secret',
        models: ['second-model'],
      },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_KEY_COLLISION' && error?.field === 'key',
  )
  assert.throws(
    () => upsertModelProvider({
      userId: 'u-model-prefix-collision',
      provider: { ...second, key: 'foo_bar' },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_KEY_COLLISION'
      && error?.statusCode === 409
      && error?.field === 'key',
  )
  assert.equal(
    listModelProviders({ userId: 'u-model-prefix-collision' }).find((provider) => provider.id === second.id)?.key,
    'second-provider',
    'a rejected rename leaves the existing provider unchanged',
  )
  const otherUserProvider = upsertModelProvider({
    userId: 'u-model-prefix-collision-other',
    provider: {
      key: 'foo_bar',
      baseUrl: 'https://other-user.example.test/v1',
      models: ['other-model'],
    },
  })
  assert.equal(otherUserProvider.key, 'foo_bar', 'runtime prefixes are isolated by user')
  const env = buildUserModelEnv({ userId: 'u-model-prefix-collision', env: {} })
  assert.equal(env.MODEL_PROVIDER_FOO_BAR_BASE_URL, 'https://first.example.test/v1')
  assert.equal(env.MODEL_PROVIDER_FOO_BAR_API_KEY, 'first-secret')
  assert.equal(resolveUserModelProvider({
    userId: 'u-model-prefix-collision',
    providerId: first.key,
    modelName: 'first-model',
  })?.id, first.id, 'legacy runtime keys still normalize to the durable UUID')
})

test('durable provider UUIDs take precedence over a different provider with the same legacy key', () => {
  createUser({ id: 'u-model-uuid-precedence', email: 'model-uuid-precedence@example.com' })
  let target = null
  for (let index = 0; index < 64 && !target; index += 1) {
    const candidate = upsertModelProvider({
      userId: 'u-model-uuid-precedence',
      provider: {
        key: `uuid-target-${index}`,
        label: `UUID target ${index}`,
        baseUrl: 'https://uuid-target.example.test/v1',
        models: ['shared-uuid-model'],
      },
    })
    if (/^[a-f]/.test(candidate.id)) target = candidate
  }
  assert.ok(target, 'fixture must obtain a UUID that is also a valid provider key')
  const shadow = upsertModelProvider({
    userId: 'u-model-uuid-precedence',
    provider: {
      key: target.id,
      label: 'Legacy key shadow',
      baseUrl: 'https://uuid-shadow.example.test/v1',
      models: ['shared-uuid-model'],
      isDefault: true,
    },
  })
  assert.notEqual(shadow.id, target.id)

  assert.equal(resolveUserModelProvider({
    userId: 'u-model-uuid-precedence',
    providerId: target.id,
    modelName: 'shared-uuid-model',
  })?.id, target.id)
})

test('model-only Provider resolution fails closed when more than one Provider serves the model', () => {
  const userId = 'u-model-ambiguous-resolution'
  createUser({ id: userId, email: 'model-ambiguous-resolution@example.com' })
  const providers = ['ambiguous-resolution-a', 'ambiguous-resolution-b'].map((key) => upsertModelProvider({
    userId,
    provider: {
      key,
      label: key,
      baseUrl: `https://${key}.example.test/v1`,
      models: ['ambiguous-resolution-model'],
      defaultModel: 'ambiguous-resolution-model',
      enabled: true,
    },
  }))

  assert.throws(
    () => resolveUserModelProvider({
      userId,
      modelName: 'ambiguous-resolution-model',
    }),
    (error) => error?.code === 'MODEL_PROVIDER_AMBIGUOUS'
      && error?.statusCode === 409
      && error?.modelName === 'ambiguous-resolution-model'
      && error?.details?.providerIds?.length === 2,
  )
  assert.equal(resolveUserModelProvider({
    userId,
    providerId: providers[1].id,
    modelName: 'ambiguous-resolution-model',
  })?.id, providers[1].id)
})

test('agent readiness reports stable Provider selection errors for missing, disabled, and mismatched models', () => {
  const userId = 'u-model-readiness-selection-errors'
  createUser({ id: userId, email: 'model-readiness-selection-errors@example.com' })
  const disabled = upsertModelProvider({
    userId,
    provider: {
      key: 'disabled-selection-provider',
      baseUrl: 'https://disabled-selection.example.test/v1',
      models: ['disabled-selection-model'],
      defaultModel: 'disabled-selection-model',
      enabled: false,
    },
  })
  const enabled = upsertModelProvider({
    userId,
    provider: {
      key: 'enabled-selection-provider',
      baseUrl: 'https://enabled-selection.example.test/v1',
      models: ['enabled-selection-model'],
      defaultModel: 'enabled-selection-model',
      enabled: true,
    },
  })
  const env = {
    MODEL_PROVIDERS: '',
    MODEL_BASE_URL: '',
    MODEL_NAME: '',
  }

  assert.throws(
    () => assertAgentModelReady({
      userId,
      providerId: 'missing-selection-provider',
      modelName: 'missing-selection-model',
      env,
    }),
    (error) => error?.code === 'MODEL_PROVIDER_NOT_FOUND'
      && error?.action === 'choose_agent_provider'
      && error?.details?.reason === 'provider_not_found',
  )
  assert.throws(
    () => assertAgentModelReady({
      userId,
      providerId: disabled.key,
      modelName: disabled.defaultModel,
      env,
    }),
    (error) => error?.code === 'MODEL_PROVIDER_DISABLED'
      && error?.action === 'enable_provider'
      && error?.details?.reason === 'provider_disabled',
  )
  assert.throws(
    () => assertAgentModelReady({
      userId,
      providerId: enabled.id,
      modelName: 'model-outside-selected-provider',
      env,
    }),
    (error) => error?.code === 'MODEL_PROVIDER_MODEL_INVALID'
      && error?.action === 'choose_agent_provider'
      && error?.details?.reason === 'model_not_in_provider',
  )
})

test('environment provider bindings carry a stable runtime fingerprint and reject drift', () => {
  createUser({ id: 'u-model-environment-binding', email: 'model-environment-binding@example.com' })
  const env = {
    MODEL_PROVIDERS: 'alpha,beta',
    MODEL_PROVIDER_ALPHA_BASE_URL: 'https://alpha.example.test/v1',
    MODEL_PROVIDER_ALPHA_MODELS: 'shared-model',
    MODEL_PROVIDER_ALPHA_PROFILE: JSON.stringify({ supportsTools: true }),
    MODEL_PROVIDER_BETA_BASE_URL: 'https://beta.example.test/v1',
    MODEL_PROVIDER_BETA_MODELS: 'shared-model',
    MODEL_PROVIDER_BETA_PROFILE: JSON.stringify({ supportsTools: true }),
    MODEL_NAME: 'shared-model',
  }
  const binding = resolveAgentModelRuntimeBinding({
    userId: 'u-model-environment-binding',
    providerId: 'beta',
    modelName: 'shared-model',
    env,
  })
  assert.equal(binding.providerId, 'beta')
  assert.equal(binding.modelName, 'shared-model')
  assert.equal(Number.isSafeInteger(binding.configRevision), true)
  assert.ok(binding.configRevision > 0)

  const resumed = resolveAgentModelRuntimeBinding({
    userId: 'u-model-environment-binding',
    providerId: 'beta',
    modelName: 'shared-model',
    configRevision: binding.configRevision,
    requirePersistedBinding: true,
    env,
  })
  assert.equal(resumed.providerId, 'beta')
  assert.equal(resumed.configRevision, binding.configRevision)
  assert.equal(resumed.env.MODEL_PROVIDER_BETA_BASE_URL, 'https://beta.example.test/v1')

  for (const changedEnv of [
    { ...env, MODEL_PROVIDER_BETA_BASE_URL: 'https://beta-2.example.test/v1' },
    { ...env, MODEL_PROVIDER_BETA_API_KEY: 'changed-secret' },
  ]) {
    assert.throws(
      () => resolveAgentModelRuntimeBinding({
        userId: 'u-model-environment-binding',
        providerId: 'beta',
        modelName: 'shared-model',
        configRevision: binding.configRevision,
        requirePersistedBinding: true,
        env: changedEnv,
      }),
      (error) => error?.code === 'MODEL_PROVIDER_CONFIG_CHANGED'
        && error?.details?.reason === 'environment_provider_config_changed',
    )
  }
})

test('database and environment provider ids cannot collapse to one runtime prefix', () => {
  createUser({ id: 'u-model-cross-source-prefix', email: 'model-cross-source-prefix@example.com' })
  const environment = {
    MODEL_PROVIDERS: 'foo_bar',
    MODEL_PROVIDER_FOO_BAR_BASE_URL: 'https://environment.example.test/v1',
    MODEL_PROVIDER_FOO_BAR_MODELS: 'environment-model',
  }
  assert.throws(
    () => upsertModelProvider({
      userId: 'u-model-cross-source-prefix',
      env: environment,
      provider: {
        key: 'foo-bar',
        baseUrl: 'https://database.example.test/v1',
        models: ['database-model'],
      },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_ENV_KEY_COLLISION'
      && error?.statusCode === 409
      && error?.conflictingProviderKey === 'foo_bar',
  )

  const saved = upsertModelProvider({
    userId: 'u-model-cross-source-prefix',
    provider: {
      key: 'foo-bar',
      baseUrl: 'https://database.example.test/v1',
      models: ['database-model'],
    },
  })
  assert.ok(saved.id)
  assert.throws(
    () => buildUserModelEnv({ userId: 'u-model-cross-source-prefix', env: environment }),
    (error) => error?.code === 'MODEL_PROVIDER_ENV_KEY_COLLISION'
      && error?.providerId === saved.id,
  )
})

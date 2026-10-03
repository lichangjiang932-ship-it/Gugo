import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-doctor-selection-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

const { closeDb, createUser } = await import('../../server/db.js')
const { getModelProvider, recordModelProviderReadiness, resolveUserModelProvider, upsertModelProvider } =
  await import('../../server/services/modelProviderStore.js')
const { runHeadlessDoctor } = await import('../../server/services/headlessDoctorService.js')

test.after(() => {
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

let sequence = 0
function selectionFixture({ readiness = 'unverified', sharedModel = false, enabled = true } = {}) {
  const userId = `doctor-selection-${++sequence}`
  createUser({ id: userId, email: `${userId}@example.invalid` })
  const modelName = sharedModel ? 'shared-model' : 'local-model'
  const save = (provider) => upsertModelProvider({ userId, provider, env: {} })
  const defaultProvider = save({ key: 'default-cloud', label: 'Default cloud fixture',
    baseUrl: 'https://cloud.example.invalid/v1', apiKey: 'fixture-cloud-key',
    models: [sharedModel ? modelName : 'cloud-model'], enabled: true, isDefault: true, supportsTools: true })
  const selectedProvider = save({ key: 'selected-local', label: 'Selected local fixture',
    baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-local-key',
    models: [modelName], enabled, isDefault: false, supportsTools: true })
  const record = (provider, ready) => recordModelProviderReadiness({ userId, id: provider.id,
    modelName: provider.defaultModel, expectedConfigRevision: provider.configRevision,
    now: 1_700_000_000_000,
    readiness: { chat: ready, tools: ready, agent: ready, mode: ready ? 'agent' : 'unavailable' } })
  record(defaultProvider, true)
  if (readiness !== 'unverified') record(selectedProvider, readiness === 'ready')
  const requests = []
  const runtimeEnv = { APP_DATA_DIR: dataDir, APP_DB_PATH: process.env.APP_DB_PATH,
    ARTIFACT_DIR: path.join(dataDir, 'artifacts'), AUTH_MODE: 'local' }
  return { userId, defaultProvider, selectedProvider, modelName, requests, options: {
    runtimeCwd: dataDir, workspaceCwd: dataDir, env: runtimeEnv,
    preflight: () => ({ runtimeEnv }),
    auth: () => ({ authenticated: true, mode: 'local', user: { id: userId } }),
    probe: true,
    // Every production selection/readiness consumer remains real. Only the
    // network probe is replaced; no request may reach a model or fixture URL.
    runSteps: async ({ provider, modelName: selectedModel, testEnv }) => {
      requests.push({ providerId: provider.id, baseUrl: provider.baseUrl, modelName: selectedModel,
        apiKey: provider.apiKey, runtimeProviders: testEnv.MODEL_PROVIDERS,
        runtimeBaseUrl: testEnv.MODEL_PROVIDER_SELECTED_BASE_URL })
      return [{ name: 'reachable', ok: true }, { name: 'completion', ok: true }, { name: 'tools', ok: true }]
    },
  } }
}

function assertSelectedRequest(fixture) {
  const { selectedProvider, modelName, requests } = fixture
  assert.deepEqual(requests, [{ providerId: selectedProvider.id, baseUrl: selectedProvider.baseUrl,
    modelName, apiKey: 'fixture-local-key', runtimeProviders: 'selected',
    runtimeBaseUrl: selectedProvider.baseUrl }])
}

for (const readiness of ['unverified', 'unavailable']) {
  test(`doctor probes the uniquely selected non-default ${readiness} provider without falling back`, async () => {
    const fixture = selectionFixture({ readiness })
    assert.equal(resolveUserModelProvider({ userId: fixture.userId, modelName: fixture.modelName }).id,
      fixture.selectedProvider.id, 'the canonical selector resolves this provider before readiness')
    const report = await runHeadlessDoctor({ ...fixture.options, modelName: fixture.modelName })
    assertSelectedRequest(fixture)
    assert.equal(report.ok, true)
    assert.equal(report.model.providerId, fixture.selectedProvider.id)
    assert.equal(report.model.probe.status, 'passed')
    const selected = getModelProvider({ userId: fixture.userId, id: fixture.selectedProvider.id })
    assert.equal(selected.modelReadiness[fixture.modelName].agent, true)
    const untouched = getModelProvider({ userId: fixture.userId, id: fixture.defaultProvider.id })
    assert.equal(untouched.modelReadiness[untouched.defaultModel].checkedAt, 1_700_000_000_000)
  })
}

test('doctor refuses a model shared by saved providers before any probe', async () => {
  const fixture = selectionFixture({ sharedModel: true })
  const report = await runHeadlessDoctor({ ...fixture.options, modelName: fixture.modelName })
  assert.deepEqual(fixture.requests, [])
  assert.equal(report.ok, false)
  assert.equal(report.blocking.code, 'MODEL_PROVIDER_AMBIGUOUS')
})

test('doctor does not send an unknown model name to the default provider', async () => {
  const fixture = selectionFixture()
  const report = await runHeadlessDoctor({ ...fixture.options, modelName: 'not-configured' })
  assert.deepEqual(fixture.requests, [])
  assert.equal(report.ok, false)
  assert.equal(report.blocking.code, 'MODEL_PROVIDER_MODEL_INVALID')
})

for (const identifier of ['id', 'key']) {
  test(`doctor probes an explicit provider ${identifier} even before its first readiness result`, async () => {
    const fixture = selectionFixture({ sharedModel: true })
    const report = await runHeadlessDoctor({ ...fixture.options,
      providerId: fixture.selectedProvider[identifier], modelName: fixture.modelName })
    assertSelectedRequest(fixture)
    assert.equal(report.ok, true)
    assert.equal(report.model.providerId, fixture.selectedProvider.id)
  })
}

for (const [scenario, code] of [
  ['missing', 'MODEL_PROVIDER_NOT_FOUND'],
  ['disabled', 'MODEL_PROVIDER_DISABLED'],
  ['mismatched-model', 'MODEL_PROVIDER_MODEL_INVALID'],
]) {
  test(`doctor refuses an explicit ${scenario} provider selection without probing another endpoint`, async () => {
    const fixture = selectionFixture({ enabled: scenario !== 'disabled' })
    const providerId = scenario === 'missing' ? 'missing-provider' : fixture.selectedProvider.id
    const modelName = scenario === 'mismatched-model' ? 'cloud-model' : fixture.modelName
    const report = await runHeadlessDoctor({ ...fixture.options, providerId, modelName })
    assert.deepEqual(fixture.requests, [])
    assert.equal(report.ok, false)
    assert.equal(report.blocking.code, code)
  })
}

test('doctor without --probe retains a non-default unverified selection without sending a request', async () => {
  const fixture = selectionFixture()
  const report = await runHeadlessDoctor({ ...fixture.options, probe: false, modelName: fixture.modelName })
  assert.deepEqual(fixture.requests, [])
  assert.equal(report.ok, false)
  assert.equal(report.blocking.code, 'MODEL_PROVIDER_UNVERIFIED')
  assert.equal(report.model.providerId, fixture.selectedProvider.id)
  assert.equal(report.model.providerLabel, fixture.selectedProvider.label)
  assert.equal(report.model.probe.status, 'not_run')
})

test('doctor with no explicit model or provider still probes the canonical enabled default', async () => {
  const fixture = selectionFixture()
  const report = await runHeadlessDoctor(fixture.options)
  assert.equal(report.ok, true)
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0].providerId, fixture.defaultProvider.id)
  assert.equal(fixture.requests[0].modelName, fixture.defaultProvider.defaultModel)
})

for (const explicitModel of [true, false]) {
  test(`doctor blocks legacy local env shadowed by a saved cloud default ${explicitModel ? 'with --model' : 'without flags'}`, async () => {
    const fixture = selectionFixture()
    const runtimeEnv = { ...fixture.options.env, MODEL_BASE_URL: 'http://127.0.0.1:1234/v1',
      MODEL_NAME: 'legacy-environment-model', MODEL_API_KEY: 'fixture-legacy-key' }
    const options = { ...fixture.options, env: runtimeEnv, preflight: () => ({ runtimeEnv }),
      ...(explicitModel ? { modelName: runtimeEnv.MODEL_NAME } : {}),
    }
    const report = await runHeadlessDoctor(options)
    assert.deepEqual(fixture.requests, [], 'conflicting legacy config must never reach the cloud default')
    assert.equal(report.ok, false)
    assert.equal(report.blocking.code, 'MODEL_PROVIDER_BINDING_MISSING')
    assert.equal(report.blocking.action, 'choose_agent_provider')
    assert.match(report.blocking.message, /--provider/)
    const configured = await runHeadlessDoctor({ ...options, probe: false })
    assert.equal(configured.ok, false, 'a read-only preflight must expose the same binding conflict')
    assert.equal(configured.blocking.code, 'MODEL_PROVIDER_BINDING_MISSING')
    const untouched = getModelProvider({ userId: fixture.userId, id: fixture.defaultProvider.id })
    assert.equal(untouched.modelReadiness[untouched.defaultModel].checkedAt, 1_700_000_000_000)
    assert.ok(!JSON.stringify(report).includes('fixture-legacy-key'))
    assert.ok(!JSON.stringify(report).includes('fixture-cloud-key'))
  })
}

test('an explicit saved provider remains authoritative over unrelated legacy environment defaults', async () => {
  const fixture = selectionFixture()
  const runtimeEnv = { ...fixture.options.env, MODEL_BASE_URL: 'http://127.0.0.1:1234/v1',
    MODEL_NAME: 'legacy-environment-model', MODEL_API_KEY: 'fixture-legacy-key' }
  const report = await runHeadlessDoctor({ ...fixture.options, env: runtimeEnv,
    preflight: () => ({ runtimeEnv }), providerId: fixture.defaultProvider.id })
  assert.equal(report.ok, true)
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0].providerId, fixture.defaultProvider.id)
  assert.equal(fixture.requests[0].modelName, fixture.defaultProvider.defaultModel)
})

test('a named local environment provider coexists with saved defaults without changing probe targets', async () => {
  const fixture = selectionFixture()
  const baseUrl = 'http://127.0.0.1:1234/v1'
  const modelName = 'named-environment-model'
  const runtimeEnv = { ...fixture.options.env, MODEL_PROVIDERS: 'environment-local',
    MODEL_PROVIDER_ENVIRONMENT_LOCAL_BASE_URL: baseUrl,
    MODEL_PROVIDER_ENVIRONMENT_LOCAL_MODELS: modelName,
  }
  const report = await runHeadlessDoctor({ ...fixture.options, env: runtimeEnv, modelName,
    preflight: () => ({ runtimeEnv }), providerId: 'environment-local' })
  assert.equal(report.ok, true)
  assert.equal(report.model.source, 'environment')
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0].baseUrl, baseUrl)
  assert.equal(fixture.requests[0].modelName, modelName)
  const untouched = getModelProvider({ userId: fixture.userId, id: fixture.defaultProvider.id })
  assert.equal(untouched.modelReadiness[untouched.defaultModel].checkedAt, 1_700_000_000_000)
})

test('a legacy model declaration without its own endpoint cannot borrow the saved default endpoint', async () => {
  const fixture = selectionFixture()
  const runtimeEnv = { ...fixture.options.env, MODEL_NAME: 'legacy-without-endpoint' }
  const report = await runHeadlessDoctor({ ...fixture.options, env: runtimeEnv,
    preflight: () => ({ runtimeEnv }), modelName: runtimeEnv.MODEL_NAME })
  assert.deepEqual(fixture.requests, [])
  assert.equal(report.ok, false)
  assert.equal(report.blocking.code, 'MODEL_CONFIG_MISSING')
})

test('the final probe target is checked again after reloading a saved provider', async () => {
  const fixture = selectionFixture()
  const runtimeEnv = { ...fixture.options.env, MODEL_BASE_URL: fixture.selectedProvider.baseUrl,
    MODEL_NAME: fixture.modelName, MODEL_API_KEY: 'fixture-local-key' }
  let reloads = 0
  const report = await runHeadlessDoctor({ ...fixture.options, env: runtimeEnv,
    preflight: () => ({ runtimeEnv }), modelName: fixture.modelName,
    getProvider: (options) => {
      reloads += 1
      // Simulate another writer changing the provider after initial selection.
      upsertModelProvider({ userId: fixture.userId, env: {}, provider: {
        ...fixture.selectedProvider, baseUrl: fixture.defaultProvider.baseUrl,
      } })
      return getModelProvider(options)
    },
  })
  assert.equal(reloads, 1)
  assert.deepEqual(fixture.requests, [], 'a later provider snapshot must not bypass target validation')
  assert.equal(report.ok, false)
  assert.equal(report.probeSteps[0].code, 'MODEL_PROVIDER_BINDING_MISSING')
})

for (const namedProvider of [false, true]) {
  test(`doctor preserves real ${namedProvider ? 'named' : 'legacy'} environment-only binding and ephemeral probes`, async () => {
    const userId = `doctor-selection-${++sequence}`
    createUser({ id: userId, email: `${userId}@example.invalid` })
    const modelName = 'environment-local-model'
    const baseUrl = 'http://127.0.0.1:1234/v1'
    const runtimeEnv = { AUTH_MODE: 'local', APP_DATA_DIR: dataDir, APP_DB_PATH: process.env.APP_DB_PATH,
      MODEL_BASE_URL: baseUrl, MODEL_NAME: modelName,
      ...(namedProvider ? { MODEL_PROVIDERS: 'environment-local',
        MODEL_PROVIDER_ENVIRONMENT_LOCAL_BASE_URL: baseUrl,
        MODEL_PROVIDER_ENVIRONMENT_LOCAL_MODELS: modelName } : {}),
    }
    const requests = []
    const options = { runtimeCwd: dataDir, workspaceCwd: dataDir, env: runtimeEnv,
      preflight: () => ({ runtimeEnv }),
      auth: () => ({ authenticated: true, user: { id: userId } }),
      modelName, providerId: namedProvider ? 'environment-local' : '',
      runSteps: async ({ provider, modelName: selectedModel }) => {
        requests.push({ baseUrl: provider.baseUrl, modelName: selectedModel })
        return [{ name: 'completion', ok: true }, { name: 'tools', ok: true }]
      },
      recordReadiness: () => assert.fail('environment readiness must remain ephemeral'),
    }
    const configured = await runHeadlessDoctor(options)
    assert.equal(configured.ok, true)
    assert.equal(configured.model.source, 'environment')
    assert.equal(configured.model.probe.status, 'not_run')
    assert.equal(configured.model.probe.checkedAt, null)
    assert.deepEqual(requests, [])
    const probed = await runHeadlessDoctor({ ...options, probe: true })
    assert.equal(probed.ok, true)
    assert.equal(probed.model.probe.status, 'passed')
    assert.ok(probed.model.probe.checkedAt > 0)
    assert.deepEqual(requests, [{ baseUrl, modelName }])
  })
}

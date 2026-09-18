import assert from 'node:assert/strict'
import test from 'node:test'

import { parseDoctorArgs } from '../../bin/cli/headlessDoctor.js'
import { CliUsageError } from '../../bin/cli/errors.js'
import { runHeadlessDoctor } from '../../server/services/headlessDoctorService.js'

const ISO_RUNTIME_ENV = Object.freeze({
  APP_DATA_DIR: '/iso/runtime/data',
  APP_DB_PATH: '/iso/runtime/data/app.db',
  ARTIFACT_DIR: '/iso/runtime/artifacts',
  AUTH_MODE: 'local',
})

function preflightOk() {
  return () => ({ runtimeEnv: { ...ISO_RUNTIME_ENV } })
}

function authOk() {
  return () => ({ authenticated: true, mode: 'local', user: { id: 'local-owner' } })
}

function readyBinding() {
  return () => ({
    providerId: 'provider-1',
    modelName: 'demo-model',
    configRevision: 4,
    source: 'provider',
    readiness: {
      chat: true, tools: true, agent: true, mode: 'agent', checkedAt: 1_700_000_000_000,
    },
  })
}

const PROVIDER = Object.freeze({
  id: 'provider-1',
  key: 'local',
  label: 'Local endpoint',
  baseUrl: 'http://127.0.0.1:1234',
  defaultModel: 'demo-model',
  models: ['demo-model'],
  configRevision: 4,
  supportsTools: true,
})

test('doctor argument parsing keeps the HTTP default and guards headless options', () => {
  assert.deepEqual(parseDoctorArgs([]), {
    headless: false, probe: false, model: null, provider: null, cwd: null,
  })
  assert.deepEqual(parseDoctorArgs(['--headless', '--probe', '--model', 'm', '--provider=p1', '--cwd', './x']), {
    headless: true, probe: true, model: 'm', provider: 'p1', cwd: './x',
  })
  for (const argv of [
    ['--probe'],
    ['--model', 'm'],
    ['--provider', 'p'],
    ['--cwd', '.'],
    ['--bogus'],
    ['--headless=yes'],
    ['--headless', '--headless'],
    ['--headless', 'extra'],
    ['--headless', '--model'],
  ]) {
    assert.throws(() => parseDoctorArgs(argv), CliUsageError, JSON.stringify(argv))
  }
})

test('headless doctor reports missing model config without contacting a model', async () => {
  let probed = false
  const report = await runHeadlessDoctor({
    runtimeCwd: process.cwd(),
    workspaceCwd: process.cwd(),
    preflight: preflightOk(),
    auth: authOk(),
    getStatus: () => ({ configured: false, toolMaxRounds: 200 }),
    resolveBinding: () => { throw Object.assign(new Error('missing'), { code: 'MODEL_CONFIG_MISSING' }) },
    runSteps: async () => { probed = true; return [] },
  })
  assert.equal(report.ok, false)
  assert.equal(report.runtime.dataDir, ISO_RUNTIME_ENV.APP_DATA_DIR)
  assert.equal(report.model.configured, false)
  assert.equal(report.blocking.code, 'MODEL_CONFIG_MISSING')
  assert.equal(report.blocking.action, 'configure_model')
  assert.equal(probed, false)
})

test('headless doctor passes only with a ready Agent binding', async () => {
  const report = await runHeadlessDoctor({
    runtimeCwd: process.cwd(),
    workspaceCwd: process.cwd(),
    preflight: preflightOk(),
    auth: authOk(),
    getStatus: () => ({
      configured: true, modelName: 'demo-model', contextWindow: 131_072,
      contextWindowSource: 'probed', toolMaxRounds: 200,
    }),
    resolveBinding: readyBinding(),
    selectProvider: () => PROVIDER,
    getProvider: () => PROVIDER,
  })
  assert.equal(report.ok, true)
  assert.equal(report.blocking, null)
  assert.equal(report.model.providerId, 'provider-1')
  assert.equal(report.model.modelName, 'demo-model')
  assert.equal(report.model.configRevision, 4)
  assert.equal(report.model.contextWindow, 131_072)
  assert.equal(report.model.probe.status, 'passed')
  assert.equal(report.model.probe.checkedAt, 1_700_000_000_000)
})

test('an unverified persisted provider cannot report readiness as passed', async () => {
  const report = await runHeadlessDoctor({
    runtimeCwd: process.cwd(),
    workspaceCwd: process.cwd(),
    preflight: preflightOk(),
    auth: authOk(),
    getStatus: () => ({ configured: true, modelName: 'demo-model', toolMaxRounds: 200 }),
    resolveBinding: () => {
      throw Object.assign(new Error('unverified'), {
        code: 'MODEL_PROVIDER_UNVERIFIED', providerId: 'provider-1', modelName: 'demo-model',
      })
    },
    selectProvider: () => PROVIDER,
    getProvider: () => PROVIDER,
  })
  assert.equal(report.ok, false)
  assert.equal(report.model.readinessCode, 'MODEL_PROVIDER_UNVERIFIED')
  assert.equal(report.model.readinessAction, 'test_provider')
  assert.equal(report.model.probe.status, 'not_run')
  assert.equal(report.blocking.code, 'MODEL_PROVIDER_UNVERIFIED')
})

test('headless doctor blocks on a missing workspace without changing runtime paths', async () => {
  const report = await runHeadlessDoctor({
    runtimeCwd: process.cwd(),
    workspaceCwd: '/definitely/not/a/real/workspace',
    preflight: preflightOk(),
    auth: authOk(),
    getStatus: () => ({ configured: true, modelName: 'demo-model', toolMaxRounds: 200 }),
    resolveBinding: readyBinding(),
    selectProvider: () => PROVIDER,
    getProvider: () => PROVIDER,
  })
  assert.equal(report.ok, false)
  assert.equal(report.blocking.code, 'CLI_CWD_NOT_FOUND')
  assert.equal(report.workspace.cwd.replace(/\\/g, '/').endsWith('/definitely/not/a/real/workspace'), true)
  // The checked-out workspace path must never relocate trusted runtime state.
  assert.equal(report.runtime.cwd, process.cwd())
  assert.equal(report.runtime.dataDir, ISO_RUNTIME_ENV.APP_DATA_DIR)
  assert.equal(report.runtime.dbPath, ISO_RUNTIME_ENV.APP_DB_PATH)
})

test('probe runs only when explicitly requested and persists the readiness entry', async () => {
  const recorded = []
  let probeCalls = 0
  const report = await runHeadlessDoctor({
    runtimeCwd: process.cwd(),
    workspaceCwd: process.cwd(),
    providerId: 'provider-1',
    probe: true,
    preflight: preflightOk(),
    auth: authOk(),
    getStatus: () => ({ configured: true, modelName: 'demo-model', toolMaxRounds: 200 }),
    resolveBinding: readyBinding(),
    selectProvider: () => PROVIDER,
    getProvider: () => ({ ...PROVIDER, apiKey: 'secret', headers: {} }),
    runSteps: async () => {
      probeCalls += 1
      return [
        { name: 'reachable', ok: true, latency: 5 },
        { name: 'completion', ok: true, latency: 9, reply: 'pong' },
        { name: 'tools', ok: true, latency: 11 },
      ]
    },
    recordReadiness: (args) => { recorded.push(args) },
  })
  assert.equal(probeCalls, 1)
  assert.equal(report.ok, true)
  assert.deepEqual(report.probeSteps.map((step) => step.name), ['reachable', 'completion', 'tools'])
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].readiness.agent, true)
  assert.equal(recorded[0].readiness.mode, 'agent')
  assert.equal(recorded[0].modelName, 'demo-model')
})

function environmentDoctorOptions() {
  const runtimeEnv = { ...ISO_RUNTIME_ENV, MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'local-fixture' }
  return {
    runtimeCwd: process.cwd(), workspaceCwd: process.cwd(),
    preflight: () => ({ runtimeEnv }), auth: authOk(),
    getStatus: () => ({ configured: true, modelName: 'local-fixture', contextWindow: 8192 }),
    selectProvider: () => null, getProvider: () => null,
    resolveBinding: () => ({ source: 'environment', providerId: null, modelName: 'local-fixture', env: runtimeEnv,
      readiness: { chat: true, tools: true, agent: true, mode: 'agent', checkedAt: null } }),
    recordReadiness: () => assert.fail('an environment probe cannot create or modify a saved Provider'),
  }
}

test('environment declarations are accepted without claiming an actual model probe passed', async () => {
  const report = await runHeadlessDoctor({ ...environmentDoctorOptions(),
    runSteps: async () => assert.fail('no explicit probe was requested') })
  assert.equal(report.ok, true, 'legacy environment-only configuration remains usable')
  assert.equal(report.model.probe.status, 'not_run')
  assert.equal(report.model.probe.checkedAt, null)
  assert.equal(report.probeSteps, null)
})

test('an explicitly requested environment probe uses the bound endpoint and remains ephemeral', async () => {
  let calls = 0
  const report = await runHeadlessDoctor({ ...environmentDoctorOptions(), probe: true,
    runSteps: async ({ provider, modelName, testEnv }) => {
      calls += 1
      assert.equal(provider.baseUrl, 'http://127.0.0.1:9/v1')
      assert.equal(modelName, 'local-fixture')
      assert.equal(testEnv.MODEL_PROVIDERS, 'selected')
      assert.equal(testEnv.MODEL_PROVIDER_SELECTED_BASE_URL, provider.baseUrl)
      return [{ name: 'reachable', ok: true }, { name: 'completion', ok: true }, { name: 'tools', ok: true }]
    } })
  assert.equal(calls, 1)
  assert.equal(report.ok, true)
  assert.equal(report.model.probe.status, 'passed')
  assert.ok(report.model.probe.checkedAt > 0)
})

test('an explicit failed probe cannot be hidden by a previously ready binding', async () => {
  const report = await runHeadlessDoctor({ ...environmentDoctorOptions(), probe: true,
    runSteps: async () => { throw Object.assign(new Error('PRIVATE_PROBE_DETAIL'), { code: 'PROVIDER_UNREACHABLE' }) } })
  assert.equal(report.ok, false)
  assert.equal(report.model.probe.status, 'failed')
  assert.equal(report.blocking.code, 'PROVIDER_UNREACHABLE')
  assert.ok(!JSON.stringify(report).includes('PRIVATE_PROBE_DETAIL'))
})

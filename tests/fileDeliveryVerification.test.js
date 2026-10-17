import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { createFileDeliveryPolicy } from '../scripts/file-delivery-verification/policy.mjs'
import * as verificationEnvironment from '../scripts/file-delivery-verification/environment.mjs'
import { createFileDeliveryEnvironment } from '../scripts/file-delivery-verification/environment.mjs'
import { parseFileDeliveryArguments } from '../scripts/verify-file-delivery.mjs'
import * as verificationServer from '../scripts/file-delivery-verification/server.mjs'
import { spawnSync } from 'node:child_process'

test('verification CLI defaults offline and validates arguments before creating data', () => {
  assert.deepEqual(parseFileDeliveryArguments(['--serve']), { live: false, port: 5181 })
  assert.deepEqual(parseFileDeliveryArguments(['--live', '--port', '5182']), { live: true, port: 5182 })
  for (const args of [[], ['--serve', '--live'], ['--live', '--port', '0'], ['--serve', '--port', 'x'], ['--internal-worker']]) {
    assert.throws(() => parseFileDeliveryArguments(args))
  }
})

test('live CLI fails closed before resolving even synthetic model configuration', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'delivery-live-blocked-'))
  try {
    const env = createFileDeliveryEnvironment({ runRoot: root, projectRoot: path.resolve('.'), port: 5181 })
    const child = spawnSync(process.execPath, ['scripts/verify-file-delivery.mjs', '--live'], {
      env, encoding: 'utf8', timeout: 30000,
    })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /FILE_DELIVERY_LIVE_UNAVAILABLE/)
    assert.equal(child.stdout, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('direct host composition refuses model bindings before importing runtime or assigning env', async () => {
  const before = { ...process.env }
  await assert.rejects(verificationServer.serveFileDeliveryVerification({ modelBinding: {} }), {
    code: 'FILE_DELIVERY_LIVE_UNAVAILABLE',
  })
  assert.deepEqual({ ...process.env }, before)
})

test('worker environment validation rejects collisions and polluted IPC environments', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'delivery-worker-env-'))
  try {
    const projectRoot = path.resolve('.')
    const env = createFileDeliveryEnvironment({ runRoot: root, projectRoot, port: 5181 })
    const validate = actualEnv => verificationEnvironment.assertFileDeliveryWorkerEnvironment({
      runRoot: root, projectRoot, port: 5181, actualEnv, cwd: projectRoot,
    })
    assert.doesNotThrow(() => validate(env))
    assert.throws(() => validate({ ...env, MODEL_API_KEY: 'synthetic-secret' }), /isolated/)
    if (process.platform === 'win32') {
      assert.throws(() => validate({ ...env, home: env.HOME }), /duplicate/)
    } else {
      assert.throws(() => validate({ ...env, home: env.HOME }), /isolated/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verification child strips ambient configuration and pins every mutable root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'delivery-env-'))
  try {
    const env = createFileDeliveryEnvironment({
      sourceEnv: { MODEL_API_KEY: 'sentinel-secret', NODE_OPTIONS: '--import=unsafe', HTTP_PROXY: 'http://unsafe', VITE_SECRET: 'sentinel', PATH: process.env.PATH },
      runRoot: root, projectRoot: path.resolve('.'), port: 5181,
    })
    for (const key of ['MODEL_API_KEY', 'NODE_OPTIONS', 'HTTP_PROXY', 'VITE_SECRET', 'GUGO_PURE_LOCAL_MODE', 'GUGO_SQLITE_DRIVER']) assert.equal(env[key], undefined)
    for (const key of ['HOME', 'GUGO_HOME', 'APP_DATA_DIR', 'APP_DB_PATH', 'APP_CONFIG_PATH', 'ARTIFACT_DIR', 'WORKSPACE_ROOT', 'GUGO_RUNTIME_CWD']) {
      assert.ok(env[key].startsWith(root), key)
    }
    assert.equal(env.GUGO_LOAD_DOTENV, '0')
    assert.equal(env.AUTH_MODE, 'local')
    assert.equal(env.SERVER_HOST, '127.0.0.1')
    assert.equal(env.GUGO_CLI_WORKSPACE_ROOT, env.WORKSPACE_ROOT)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('offline verification exports no credential-bearing process environment projector', () => {
  assert.equal('projectVerificationModelEnvironment' in verificationServer, false)
})

test('model endpoint cannot change and rejected requests do not consume the budget', () => {
  const policy = createFileDeliveryPolicy({ workspace: tmpdir(), allowedTools: [], modelBaseUrl: 'https://fixture.example/v1' })
  assert.equal(policy.beforeModelRequest('https://fixture.example/v1/chat/completions'), 1)
  assert.throws(() => policy.beforeModelRequest('https://other.example/v1/chat/completions'), { code: 'FILE_DELIVERY_ENDPOINT_DENIED' })
  assert.equal(policy.snapshot().physicalRequests, 1)
})

test('file delivery verification denies unlisted tools before dispatch', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'delivery-policy-'))
  const calls = []
  try {
    const policy = createFileDeliveryPolicy({ workspace: root, allowedTools: ['read_file', 'write_file'] })
    const dispatch = policy.wrapDispatcher(async (...args) => { calls.push(args); return 'ok' })
    const specs = [{ function: { name: 'read_file' } }, { function: { name: 'bash_exec' } }, { function: { name: 'mcp__hidden' } }]
    assert.deepEqual(policy.projectToolSpecs(specs), [specs[0]])
    for (const name of ['bash_exec', 'run_code', 'mcp__hidden', 'Read', 'unknown', 'set_deliverables']) {
      const deniedPolicy = createFileDeliveryPolicy({ workspace: root, allowedTools: ['read_file', 'write_file'] })
      await assert.rejects(deniedPolicy.wrapDispatcher(async () => assert.fail('denied dispatch'))(name, { path: root }), { code: 'FILE_DELIVERY_TOOL_DENIED' })
      assert.equal(deniedPolicy.snapshot().reason, 'permission_denied')
    }
    assert.equal(calls.length, 0)
    assert.equal(await dispatch('read_file', { path: path.join(root, 'one.md') }), 'ok')
    assert.equal(calls.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('file delivery verification rejects escaped, missing and symlinked paths', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'delivery-paths-'))
  try {
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const args of [{}, { path: '../outside/x' }, { path: outside }, { path: 'escape/new.md' }]) {
      const policy = createFileDeliveryPolicy({ workspace, allowedTools: ['read_file', 'write_file'] })
      const dispatch = policy.wrapDispatcher(async () => assert.fail('denied path reached dispatcher'))
      await assert.rejects(dispatch('write_file', args), { code: 'FILE_DELIVERY_PATH_DENIED' })
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('one shared physical request budget includes redirects and auxiliary requests', () => {
  const policy = createFileDeliveryPolicy({ workspace: tmpdir(), allowedTools: [] })
  for (let n = 1; n <= 12; n += 1) {
    assert.equal(policy.reservePhysicalRequest(), n)
  }
  assert.throws(() => policy.reservePhysicalRequest(), { code: 'FILE_DELIVERY_REQUEST_LIMIT' })
  assert.equal(policy.snapshot().physicalRequests, 12)
  assert.equal(policy.snapshot().stopped, true)
})

test('cancel, rejected permissions and unknown results stop new requests without replay', async () => {
  for (const reason of ['cancelled', 'permission_denied', 'request_unknown']) {
    const policy = createFileDeliveryPolicy({ workspace: tmpdir(), allowedTools: ['read_file'] })
    policy.reservePhysicalRequest()
    policy.stop(reason)
    assert.throws(() => policy.reservePhysicalRequest(), { code: 'FILE_DELIVERY_STOPPED' })
    await assert.rejects(policy.wrapDispatcher(async () => assert.fail('stopped dispatch'))('read_file', { path: tmpdir() }), { code: 'FILE_DELIVERY_STOPPED' })
    assert.deepEqual(policy.snapshot(), { physicalRequests: 1, maxRequests: 12, stopped: true, reason })
  }
})

test('verification policy rejects unsafe capabilities and invalid budgets at construction', () => {
  for (const allowedTools of [['bash_exec'], ['run_code'], ['mcp__read'], ['subagent'], ['unknown']]) {
    assert.throws(() => createFileDeliveryPolicy({ workspace: tmpdir(), allowedTools }), /tool/i)
  }
  for (const maxRequests of [0, 13, -1, 1.5]) {
    assert.throws(() => createFileDeliveryPolicy({ workspace: tmpdir(), allowedTools: [], maxRequests }), /budget/i)
  }
  assert.throws(() => createFileDeliveryPolicy({ workspace: 'relative', allowedTools: [] }), /absolute/i)
})

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  RECOVERABLE_RUNTIME_CONFIG_CODES,
  createRuntimeConfigRecoveryServer,
  isRecoverableUserRuntimeConfigError,
  startRuntimeConfigRecoveryServer,
} from '../server/services/runtimeConfigRecoveryServer.js'
import { readRuntimePluginConfigLayerSources } from '../server/plugins/runtimePluginConfigFile.js'
import {
  MAX_RUNTIME_CONFIG_BYTES,
  readRuntimeConfigFileSnapshot,
} from '../server/utils/runtimeEnv.js'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function createFixture(t, content = '{ invalid json', { cleanup = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-config-recovery-'))
  const dataDir = path.join(cwd, 'data')
  const configPath = path.join(dataDir, 'runtime.json')
  const env = {
    APP_DATA_DIR: dataDir,
    APP_DB_PATH: path.join(dataDir, 'app.db'),
    GUGO_LOAD_DOTENV: '0',
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, content)
  if (cleanup) t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  return { cwd, dataDir, configPath, env }
}

function captureError(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  assert.fail('expected operation to throw')
}

function runtimeFileError(configPath) {
  return captureError(() => readRuntimeConfigFileSnapshot(configPath))
}

function pluginConfigError(cwd, env) {
  return captureError(() => readRuntimePluginConfigLayerSources({ cwd, env }))
}

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  return `http://${host}:${address.port}`
}

async function closeServer(server) {
  if (!server?.listening) return
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function waitForRecoveryUrl(child, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const finish = (callback, value) => {
      clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
      callback(value)
    }
    const inspect = () => {
      const match = stderr.match(/runtime\.json recovery is available at (http:\/\/127\.0\.0\.1:\d+\/)/u)
      if (match) finish(resolve, { baseUrl: match[1], stdout, stderr })
    }
    const onStdout = (chunk) => { stdout += String(chunk) }
    const onStderr = (chunk) => {
      stderr += String(chunk)
      inspect()
    }
    const onError = (error) => finish(reject, error)
    const onExit = (code, signal) => finish(
      reject,
      new Error(`recovery child exited before listening (${code ?? signal})\n${stdout}\n${stderr}`),
    )
    const timer = setTimeout(() => finish(
      reject,
      new Error(`timed out waiting for recovery listener\n${stdout}\n${stderr}`),
    ), timeoutMs)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  let timer
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
  child.kill()
  const stopped = await Promise.race([
    exited,
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 2_000) }),
  ])
  clearTimeout(timer)
  if (stopped) return
  child.kill('SIGKILL')
  await exited
}

function spawnServerEntry(fixture, dbPath) {
  const homeDir = path.join(fixture.cwd, 'home')
  fs.mkdirSync(homeDir)
  const childEnv = {
    ...process.env,
    APP_DATA_DIR: fixture.dataDir,
    APP_DB_PATH: dbPath,
    APPDATA: path.join(homeDir, 'appdata'),
    AUTH_MODE: 'local',
    GUGO_LOAD_DOTENV: '0',
    HOME: homeDir,
    LOCALAPPDATA: path.join(homeDir, 'local-appdata'),
    NODE_ENV: 'test',
    SERVER_PORT: '0',
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, 'xdg-config'),
  }
  delete childEnv.APP_CONFIG_PATH
  return spawn(process.execPath, [path.join(repoDir, 'server', 'start.js')], {
    cwd: fixture.cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function registerChildCleanup(t, child, fixture) {
  t.after(async () => {
    await stopChild(child)
    fs.rmSync(fixture.cwd, { recursive: true, force: true })
  })
}

async function startFixtureServer(t, fixture, startupError) {
  const server = createRuntimeConfigRecoveryServer({
    startupError,
    cwd: fixture.cwd,
    env: fixture.env,
  })
  t.after(() => closeServer(server))
  const baseUrl = await listen(server)
  const page = await (await fetch(`${baseUrl}/`)).text()
  const token = page.match(/data-recovery-token="([A-Za-z0-9_-]+)"/u)?.[1]
  assert.equal(typeof token, 'string')
  return { server, baseUrl, token }
}

async function readJsonResponse(response) {
  const text = await response.text()
  return { text, body: JSON.parse(text) }
}

async function putConfig(baseUrl, token, content, headers = {}) {
  return fetch(`${baseUrl}/api/recovery/config`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-gugo-recovery-token': token,
      ...headers,
    },
    body: content,
  })
}

async function rawRequest(baseUrl, { method = 'GET', headers = {} } = {}) {
  const target = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers,
    }, (response) => {
      response.resume()
      response.once('end', () => resolve({ status: response.statusCode }))
    })
    request.once('error', reject)
    request.end()
  })
}

function backupPathFor(configPath, backupFilename) {
  assert.equal(typeof backupFilename, 'string')
  assert.equal(path.basename(backupFilename), backupFilename)
  return path.join(path.dirname(configPath), backupFilename)
}

function listFilesRecursively(root) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name)
    return entry.isDirectory() ? listFilesRecursively(target) : [target]
  })
}

test('only known user runtime.json content failures enter recovery mode', (t) => {
  assert.deepEqual(
    new Set(RECOVERABLE_RUNTIME_CONFIG_CODES),
    new Set([
      'RUNTIME_CONFIG_FILE_INVALID',
      'RUNTIME_CONFIG_FILE_TOO_LARGE',
      'PLUGIN_CONFIG_FILE_INVALID',
    ]),
  )

  const fixture = createFixture(t)
  const userError = runtimeFileError(fixture.configPath)
  assert.equal(isRecoverableUserRuntimeConfigError({
    error: userError,
    cwd: fixture.cwd,
    env: fixture.env,
  }), true)

  const projectPath = path.join(fixture.cwd, '.gugo', 'runtime.json')
  fs.mkdirSync(path.dirname(projectPath), { recursive: true })
  fs.writeFileSync(projectPath, '{ invalid project json')
  const projectError = runtimeFileError(projectPath)
  assert.equal(isRecoverableUserRuntimeConfigError({
    error: projectError,
    cwd: fixture.cwd,
    env: fixture.env,
  }), false)
  assert.throws(
    () => createRuntimeConfigRecoveryServer({
      startupError: projectError,
      cwd: fixture.cwd,
      env: fixture.env,
    }),
    (error) => error === projectError,
  )

  const explicitPath = path.join(fixture.cwd, 'deployment-runtime.json')
  const explicitEnv = { ...fixture.env, APP_CONFIG_PATH: explicitPath }
  fs.writeFileSync(explicitPath, '{ invalid explicit json')
  const explicitError = runtimeFileError(explicitPath)
  assert.equal(isRecoverableUserRuntimeConfigError({
    error: explicitError,
    cwd: fixture.cwd,
    env: explicitEnv,
  }), false)
  assert.throws(
    () => createRuntimeConfigRecoveryServer({
      startupError: explicitError,
      cwd: fixture.cwd,
      env: explicitEnv,
    }),
    (error) => error === explicitError,
  )
})

test('invalid JSON exposes a local recovery page and redacted JSON status', async (t) => {
  const fixture = createFixture(t)
  const startupError = runtimeFileError(fixture.configPath)
  assert.equal(startupError.code, 'RUNTIME_CONFIG_FILE_INVALID')

  const { baseUrl } = await startFixtureServer(t, fixture, startupError)
  const statusResponse = await fetch(`${baseUrl}/api/recovery/status`)
  assert.equal(statusResponse.status, 200)
  assert.match(statusResponse.headers.get('content-type') || '', /application\/json/iu)
  const status = await readJsonResponse(statusResponse)
  assert.equal(status.body.ok, true)
  assert.equal(status.body.protocolVersion, 1)
  assert.equal(status.body.error.code, 'RUNTIME_CONFIG_FILE_INVALID')
  assert.doesNotMatch(status.text, new RegExp(fixture.cwd.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))

  const pageResponse = await fetch(`${baseUrl}/`)
  assert.equal(pageResponse.status, 200)
  assert.match(pageResponse.headers.get('content-type') || '', /text\/html/iu)
  const page = await pageResponse.text()
  assert.match(page, /runtime\.json/iu)
  assert.doesNotMatch(page, new RegExp(fixture.cwd.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))

  for (const pathname of ['/', '/api/recovery/status']) {
    const response = await fetch(`${baseUrl}${pathname}`, { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '')
  }
})

test('oversized runtime.json enters recovery but oversized replacement remains rejected', async (t) => {
  const fixture = createFixture(t, Buffer.alloc(MAX_RUNTIME_CONFIG_BYTES + 1, 0x20))
  const startupError = runtimeFileError(fixture.configPath)
  assert.equal(startupError.code, 'RUNTIME_CONFIG_FILE_TOO_LARGE')

  const { baseUrl, token } = await startFixtureServer(t, fixture, startupError)
  const oversizedReplacement = JSON.stringify({
    env: { FEATURE_FLAG: 'x'.repeat(MAX_RUNTIME_CONFIG_BYTES) },
  })
  const response = await putConfig(baseUrl, token, oversizedReplacement)
  assert.equal(response.status, 413)
  const { body } = await readJsonResponse(response)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'RUNTIME_CONFIG_FILE_TOO_LARGE')
  assert.equal(fs.statSync(fixture.configPath).size, MAX_RUNTIME_CONFIG_BYTES + 1)
  assert.equal(fs.readdirSync(fixture.dataDir).length, 1)
})

test('invalid user pluginConfig is recoverable and corrected content is accepted', async (t) => {
  const fixture = createFixture(t, JSON.stringify({
    env: {},
    pluginConfig: { layers: [{}] },
  }))
  const startupError = pluginConfigError(fixture.cwd, fixture.env)
  assert.equal(startupError.code, 'PLUGIN_CONFIG_FILE_INVALID')

  const { baseUrl, token } = await startFixtureServer(t, fixture, startupError)
  const replacement = JSON.stringify({
    env: { WORKSPACE_FS_ENABLED: '0' },
    pluginConfig: { layers: [] },
  })
  const response = await putConfig(baseUrl, token, replacement)
  assert.equal(response.status, 200)
  const { body } = await readJsonResponse(response)
  assert.equal(body.ok, true)
  assert.equal(body.restartRequired, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')), JSON.parse(replacement))
})

test('replacement rejects sensitive keys without echoing or changing the broken file', async (t) => {
  const original = '{ still invalid'
  const fixture = createFixture(t, original)
  const { baseUrl, token } = await startFixtureServer(t, fixture, runtimeFileError(fixture.configPath))
  const secret = 'sk-must-not-be-returned'
  const response = await putConfig(baseUrl, token, JSON.stringify({
    env: { MODEL_API_KEY: secret },
  }))
  assert.equal(response.status, 422)
  const result = await readJsonResponse(response)
  assert.equal(result.body.ok, false)
  assert.equal(typeof result.body.error.code, 'string')
  assert.doesNotMatch(result.text, new RegExp(secret, 'u'))
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original)
  assert.equal(fs.readdirSync(fixture.dataDir).length, 1)
})

test('recovery starter binds only to 127.0.0.1', async (t) => {
  const fixture = createFixture(t)
  const server = await startRuntimeConfigRecoveryServer({
    startupError: runtimeFileError(fixture.configPath),
    cwd: fixture.cwd,
    env: fixture.env,
    port: 0,
  })
  t.after(() => closeServer(server))
  const address = server.address()
  assert.equal(address.address, '127.0.0.1')
  assert.ok(address.port > 0)
})

test('real server entry exposes recovery without creating SQLite for invalid JSON', async (t) => {
  const fixture = createFixture(t, '{ invalid json', { cleanup: false })
  const original = fs.readFileSync(fixture.configPath)
  const dbDir = path.join(fixture.cwd, 'database-must-not-exist')
  const dbPath = path.join(dbDir, 'app.db')
  const child = spawnServerEntry(fixture, dbPath)
  registerChildCleanup(t, child, fixture)

  const { baseUrl } = await waitForRecoveryUrl(child)
  const statusResponse = await fetch(`${baseUrl}api/recovery/status`, {
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(statusResponse.status, 200)
  const { body } = await readJsonResponse(statusResponse)
  assert.equal(body.mode, 'runtime_config_recovery')
  assert.equal(body.error.code, 'RUNTIME_CONFIG_FILE_INVALID')

  const pageResponse = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) })
  assert.equal(pageResponse.status, 200)
  assert.match(pageResponse.headers.get('content-type') || '', /text\/html/iu)
  assert.match(await pageResponse.text(), /<title>Gugo 配置恢复<\/title>/u)

  const healthResponse = await fetch(`${baseUrl}api/health`, {
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(healthResponse.status, 404)

  const businessResponse = await fetch(`${baseUrl}api/auth/status`, {
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(businessResponse.status, 404)
  assert.equal((await readJsonResponse(businessResponse)).body.error.code, 'RECOVERY_NOT_FOUND')

  await stopChild(child)
  assert.deepEqual(fs.readFileSync(fixture.configPath), original)
  assert.deepEqual(fs.readdirSync(fixture.dataDir), ['runtime.json'])
  assert.equal(fs.existsSync(dbDir), false)
  assert.equal(fs.existsSync(path.join(fixture.cwd, 'server-data', 'app.db')), false)
  assert.equal(fs.existsSync(path.join(fixture.cwd, 'data', 'app.db')), false)
  assert.deepEqual(
    listFilesRecursively(fixture.cwd).filter((file) => /\.db-(?:wal|shm)$/iu.test(file)),
    [],
  )
})

test('real server entry recovers deeply invalid user plugin config without application routes', async (t) => {
  const original = JSON.stringify({ env: {}, pluginConfig: { layers: [{}] } })
  const fixture = createFixture(t, original, { cleanup: false })
  const dbPath = path.join(fixture.dataDir, 'plugin-preflight.db')
  const child = spawnServerEntry(fixture, dbPath)
  registerChildCleanup(t, child, fixture)

  const { baseUrl } = await waitForRecoveryUrl(child)
  const status = await readJsonResponse(await fetch(`${baseUrl}api/recovery/status`, {
    signal: AbortSignal.timeout(5_000),
  }))
  assert.equal(status.body.mode, 'runtime_config_recovery')
  assert.equal(status.body.protocolVersion, 1)
  assert.equal(status.body.error.code, 'PLUGIN_CONFIG_FILE_INVALID')
  assert.equal((await fetch(`${baseUrl}api/health`)).status, 404)
  assert.equal((await fetch(`${baseUrl}api/auth/status`)).status, 404)
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original)

  const movedDbPath = `${dbPath}.closed`
  fs.renameSync(dbPath, movedDbPath)
  fs.renameSync(movedDbPath, dbPath)
})

test('mutation endpoints reject a non-loopback peer', async (t) => {
  const networkAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry
      && (entry.family === 'IPv4' || entry.family === 4)
      && entry.internal === false)
    ?.address
  if (!networkAddress) {
    t.skip('host has no non-loopback IPv4 interface')
    return
  }

  const fixture = createFixture(t)
  const server = createRuntimeConfigRecoveryServer({
    startupError: runtimeFileError(fixture.configPath),
    cwd: fixture.cwd,
    env: fixture.env,
  })
  t.after(() => closeServer(server))
  await listen(server, '0.0.0.0')
  const response = await fetch(`http://${networkAddress}:${server.address().port}/api/recovery/reset`, {
    method: 'POST',
  })
  assert.equal(response.status, 403)
  const { body } = await readJsonResponse(response)
  assert.equal(body.ok, false)
  assert.equal(typeof body.error.code, 'string')
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), '{ invalid json')
})

test('mutations reject missing tokens, cross-site origins, and forged loopback hosts', async (t) => {
  const original = '{ invalid protected config'
  const fixture = createFixture(t, original)
  const { baseUrl, token } = await startFixtureServer(
    t,
    fixture,
    runtimeFileError(fixture.configPath),
  )

  const missingToken = await fetch(`${baseUrl}/api/recovery/reset`, { method: 'POST' })
  assert.equal(missingToken.status, 403)

  const crossSite = await fetch(`${baseUrl}/api/recovery/reset`, {
    method: 'POST',
    headers: {
      origin: 'https://attacker.example',
      'x-gugo-recovery-token': token,
    },
  })
  assert.equal(crossSite.status, 403)

  const forgedHost = await rawRequest(`${baseUrl}/api/recovery/reset`, {
    method: 'POST',
    headers: {
      host: 'attacker.example',
      'x-gugo-recovery-token': token,
    },
  })
  assert.equal(forgedHost.status, 403)
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original)
  assert.equal(fs.readdirSync(fixture.dataDir).length, 1)
})

test('recovery refuses directory and symbolic-link runtime config targets', (t) => {
  const directoryFixture = createFixture(t)
  fs.rmSync(directoryFixture.configPath)
  fs.mkdirSync(directoryFixture.configPath)
  const directoryError = runtimeFileError(directoryFixture.configPath)
  assert.throws(() => createRuntimeConfigRecoveryServer({
    startupError: directoryError,
    cwd: directoryFixture.cwd,
    env: directoryFixture.env,
  }))

  const symlinkFixture = createFixture(t)
  const linkedPath = path.join(symlinkFixture.cwd, 'linked-runtime.json')
  fs.writeFileSync(linkedPath, '{ invalid linked json')
  fs.rmSync(symlinkFixture.configPath)
  try {
    fs.symlinkSync(linkedPath, symlinkFixture.configPath, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.diagnostic(`symbolic-link assertion skipped: ${error.code}`)
      return
    }
    throw error
  }
  const symlinkError = runtimeFileError(symlinkFixture.configPath)
  assert.throws(() => createRuntimeConfigRecoveryServer({
    startupError: symlinkError,
    cwd: symlinkFixture.cwd,
    env: symlinkFixture.env,
  }))
})

test('recovery refuses runtime config targets below linked directories', (t) => {
  const fixture = createFixture(t)
  const realDataDir = path.join(fixture.cwd, 'real-data')
  const linkedDataDir = path.join(fixture.cwd, 'linked-data')
  const configPath = path.join(linkedDataDir, 'runtime.json')
  fs.mkdirSync(realDataDir)
  fs.writeFileSync(path.join(realDataDir, 'runtime.json'), '{ invalid linked-parent json')
  try {
    fs.symlinkSync(realDataDir, linkedDataDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.diagnostic(`linked-directory assertion skipped: ${error.code}`)
      return
    }
    throw error
  }

  const env = {
    ...fixture.env,
    APP_DATA_DIR: linkedDataDir,
    APP_DB_PATH: path.join(linkedDataDir, 'app.db'),
  }
  assert.throws(() => createRuntimeConfigRecoveryServer({
    startupError: runtimeFileError(configPath),
    cwd: fixture.cwd,
    env,
  }), { code: 'RECOVERY_TARGET_UNSAFE' })
})

test('replacement is rejected when the startup target identity drifts', async (t) => {
  const fixture = createFixture(t)
  const { baseUrl, token } = await startFixtureServer(t, fixture, runtimeFileError(fixture.configPath))
  const movedPath = path.join(fixture.dataDir, 'runtime.before-replacement.json')
  fs.renameSync(fixture.configPath, movedPath)
  const interveningContent = JSON.stringify({ env: { INTERVENING_WRITER: '1' } })
  fs.writeFileSync(fixture.configPath, interveningContent)

  const response = await putConfig(baseUrl, token, JSON.stringify({ env: { REQUESTED: '1' } }))
  assert.equal(response.status, 409)
  const { body } = await readJsonResponse(response)
  assert.equal(body.ok, false)
  assert.equal(typeof body.error.code, 'string')
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), interveningContent)
  assert.equal(fs.readFileSync(movedPath, 'utf8'), '{ invalid json')
})

test('valid replacement atomically preserves the broken bytes and requires restart', async (t) => {
  const original = Buffer.from('{ broken runtime config', 'utf8')
  const fixture = createFixture(t, original)
  const { baseUrl, token } = await startFixtureServer(t, fixture, runtimeFileError(fixture.configPath))
  const replacement = '{\n  "env": {\n    "WORKSPACE_FS_ENABLED": "1"\n  }\n}\n'

  const response = await putConfig(baseUrl, token, replacement)
  assert.equal(response.status, 200)
  const { body } = await readJsonResponse(response)
  assert.equal(body.ok, true)
  assert.equal(body.restartRequired, true)
  const saved = readRuntimeConfigFileSnapshot(fixture.configPath)
  assert.equal(saved.env.WORKSPACE_FS_ENABLED, '1')
  assert.equal(fs.lstatSync(fixture.configPath).isFile(), true)
  assert.equal(fs.lstatSync(fixture.configPath).isSymbolicLink(), false)

  const backupPath = backupPathFor(fixture.configPath, body.backupFilename)
  assert.deepEqual(fs.readFileSync(backupPath), original)
  assert.equal(
    fs.readdirSync(fixture.dataDir).some((name) => /\.tmp$/iu.test(name)),
    false,
  )
})

test('reset writes the minimal config, backs up the original, and requires restart', async (t) => {
  const original = '{ reset this invalid config'
  const fixture = createFixture(t, original)
  const { baseUrl, token } = await startFixtureServer(t, fixture, runtimeFileError(fixture.configPath))
  const response = await fetch(`${baseUrl}/api/recovery/reset`, {
    method: 'POST',
    headers: { 'x-gugo-recovery-token': token },
  })
  assert.equal(response.status, 200)
  const { body } = await readJsonResponse(response)
  assert.equal(body.ok, true)
  assert.equal(body.restartRequired, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')), { env: {} })
  assert.equal(
    fs.readFileSync(backupPathFor(fixture.configPath, body.backupFilename), 'utf8'),
    original,
  )
})

test('a repaired plugin config passes the real startup preflight in a clean process', async (t) => {
  const fixture = createFixture(t, JSON.stringify({
    env: {},
    pluginConfig: { unsupported: true },
  }))
  const { baseUrl, token } = await startFixtureServer(
    t,
    fixture,
    pluginConfigError(fixture.cwd, fixture.env),
  )
  const response = await putConfig(baseUrl, token, JSON.stringify({
    env: { WORKSPACE_FS_ENABLED: '0' },
    pluginConfig: { layers: [] },
  }))
  assert.equal(response.status, 200)
  assert.equal((await readJsonResponse(response)).body.restartRequired, true)

  const childEnv = {
    ...process.env,
    APP_DATA_DIR: fixture.dataDir,
    APP_DB_PATH: path.join(fixture.dataDir, 'preflight.db'),
    AUTH_MODE: 'local',
    GUGO_LOAD_DOTENV: '0',
    NODE_ENV: 'test',
  }
  delete childEnv.APP_CONFIG_PATH
  const script = [
    "import { runRuntimeConfigStartupPreflight } from './server/services/runtimeConfigStartupService.js'",
    'runRuntimeConfigStartupPreflight({ cwd: process.cwd(), env: process.env })',
    "process.stdout.write('PREFLIGHT_OK')",
  ].join(';')
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoDir,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PREFLIGHT_OK/u)
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDesktopSmokeEnvironment } from '../scripts/smoke-test-desktop-package.mjs'

const isolatedPathKeys = [
  'APP_DATA_DIR', 'APP_DB_PATH', 'APP_CONFIG_PATH', 'ARTIFACT_DIR', 'WORKSPACE_ROOT',
  'TEMP', 'TMP', 'TMPDIR',
]
const blockedKeys = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_ENABLE_LOGGING',
  'GUGO_TURN_PERSISTENCE_MODULE', 'GUGO_TURN_PERSISTENCE_TRUST_ROOT',
  'GUGO_CODEX_SIGNATURE_MODULE', 'CODEX_HOME', 'CODEX_CLI_PATH',
  'MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_PROVIDERS', 'OPENAI_API_KEY',
  'NPM_CONFIG_SCRIPT_SHELL', 'HTTP_PROXY', 'APP_AUTH_DISABLED', 'HUB_ENABLED',
]
const modeValues = {
  ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', GUGO_LOAD_DOTENV: '0',
  GUGO_PURE_LOCAL_MODE: '1', GUGO_SQLITE_DRIVER: 'node', SERVER_HOST: '127.0.0.1',
  CODEX_PLUGIN_ROOTS: '[]', CODEX_APP_SERVER_ENABLED: '0', MCP_STDIO_ENABLED: '0',
}

function assertIsolatedEnvironment(env, smokeRoot, appOutDir, port) {
  for (const key of isolatedPathKeys) {
    assert.equal(path.isAbsolute(env[key]), true, key)
    const relative = path.relative(smokeRoot, env[key])
    assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), key)
  }
  for (const key of blockedKeys) assert.equal(env[key], undefined, key)
  for (const [key, expected] of Object.entries(modeValues)) assert.equal(env[key], expected, key)
  assert.equal(env.SERVER_PORT, String(port))
  assert.equal(env.APP_DB_PATH, path.join(smokeRoot, 'app.db'))
  assert.equal(env.APP_CONFIG_PATH, path.join(smokeRoot, 'runtime.json'))
  assert.equal(env.GUGO_FFMPEG_PATH, path.join(appOutDir, 'resources', 'bin', 'ffmpeg.exe'))
  assert.equal(env.GUGO_FFPROBE_PATH, path.join(appOutDir, 'resources', 'bin', 'ffprobe.exe'))
}

test('desktop smoke keeps only explicit OS discovery inputs without modifying the source environment', () => {
  const smokeRoot = path.resolve(os.tmpdir(), 'synthetic-smoke')
  const appOutDir = path.resolve(os.tmpdir(), 'synthetic-package')
  const sourceEnv = Object.freeze({
    Path: 'synthetic-tool-path', PATHEXT: '.EXE;.COM', SystemRoot: 'synthetic-system-root',
    USERPROFILE: 'synthetic-user-profile', HOME: 'synthetic-home',
    ...Object.fromEntries(blockedKeys.map((key) => [key, 'must-not-inherit'])),
    ...Object.fromEntries(isolatedPathKeys.map((key) => [key, 'must-not-reuse'])),
    ...Object.fromEntries(Object.keys(modeValues).map((key) => [key, 'must-not-inherit'])),
    app_db_path: 'case-alias-must-not-inherit', Node_Options: 'case-alias-must-not-inherit',
    Unexpected_Deployment_Value: 'must-not-inherit',
  })
  const snapshot = { ...sourceEnv }
  const env = createDesktopSmokeEnvironment({ sourceEnv, smokeRoot, appOutDir, port: 43879 })
  assertIsolatedEnvironment(env, smokeRoot, appOutDir, 43879)
  assert.equal(env.PATH, sourceEnv.Path)
  assert.equal(env.PATHEXT, sourceEnv.PATHEXT)
  assert.equal(env.SYSTEMROOT, sourceEnv.SystemRoot)
  assert.equal(env.USERPROFILE, sourceEnv.USERPROFILE)
  assert.equal(env.HOME, sourceEnv.HOME)
  assert.equal(env.Path, undefined)
  assert.equal(env.app_db_path, undefined)
  assert.equal(env.Node_Options, undefined)
  assert.equal(env.Unexpected_Deployment_Value, undefined)
  assert.deepEqual(sourceEnv, snapshot)
})

test('desktop smoke rejects missing or relative roots and invalid ports', () => {
  const roots = { smokeRoot: path.resolve(os.tmpdir(), 'smoke'), appOutDir: path.resolve(os.tmpdir(), 'package') }
  for (const options of [{}, { ...roots, smokeRoot: '.' }, { ...roots, appOutDir: 'release' }]) {
    assert.throws(() => createDesktopSmokeEnvironment({ sourceEnv: {}, ...options, port: 43879 }), /absolute paths/)
  }
  for (const port of [undefined, null, 0, -1, 65_536, 1.5, NaN, '43879']) {
    assert.throws(() => createDesktopSmokeEnvironment({ sourceEnv: {}, ...roots, port }), /port must be between/)
  }
})

test('desktop smoke does not reuse mutable environment objects between runs', () => {
  const sourceEnv = Object.freeze({ PATH: 'fixture-path' })
  const appOutDir = path.resolve(os.tmpdir(), 'synthetic-package')
  const firstRoot = path.resolve(os.tmpdir(), 'synthetic-smoke-a')
  const secondRoot = path.resolve(os.tmpdir(), 'synthetic-smoke-b')
  const first = createDesktopSmokeEnvironment({ sourceEnv, smokeRoot: firstRoot, appOutDir, port: 40001 })
  const second = createDesktopSmokeEnvironment({ sourceEnv, smokeRoot: secondRoot, appOutDir, port: 40002 })
  first.APP_DB_PATH = 'fixture-mutation'
  assertIsolatedEnvironment(second, secondRoot, appOutDir, 40002)
  assert.deepEqual(sourceEnv, { PATH: 'fixture-path' })
})

for (const exitCode of [0, 17]) {
  test(`a harmless real Node child receives only the isolated desktop smoke environment (exit ${exitCode})`, (t) => {
    const temporaryRoot = fs.realpathSync(os.tmpdir())
    const fixtureRoot = fs.mkdtempSync(path.join(temporaryRoot, 'gugo-desktop-smoke-env-'))
    t.after(() => {
      assert.equal(path.dirname(fixtureRoot), temporaryRoot)
      assert.match(path.basename(fixtureRoot), /^gugo-desktop-smoke-env-/)
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    })
    const smokeRoot = path.join(fixtureRoot, 'smoke')
    const appOutDir = path.join(fixtureRoot, 'fake-package')
    const hostSentinel = path.join(fixtureRoot, 'host-sentinel.txt')
    const startupHook = path.join(fixtureRoot, 'forbidden-startup-hook.cjs')
    fs.mkdirSync(smokeRoot)
    fs.mkdirSync(appOutDir)
    fs.mkdirSync(path.join(smokeRoot, 'tmp'))
    fs.writeFileSync(hostSentinel, 'host data is unchanged')
    fs.writeFileSync(startupHook, 'throw new Error("Ambient Node startup hook must never run");')
    const nativeKeys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'USERPROFILE', 'HOME'])
    const sourceEnv = Object.freeze({
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => nativeKeys.has(key.toUpperCase()))),
      ...Object.fromEntries(blockedKeys.map((key) => [key, 'synthetic-deployment-value'])),
      ...Object.fromEntries(isolatedPathKeys.map((key) => [key, hostSentinel])),
      NODE_OPTIONS: `--require=${JSON.stringify(startupHook)}`,
      CODEX_PLUGIN_ROOTS: JSON.stringify([fixtureRoot]), CODEX_APP_SERVER_ENABLED: '1',
      GUGO_LOAD_DOTENV: '1', GUGO_PURE_LOCAL_MODE: '0', MCP_STDIO_ENABLED: '1',
    })
    const callerSnapshot = JSON.stringify(process.env)
    const env = createDesktopSmokeEnvironment({ sourceEnv, smokeRoot, appOutDir, port: 43879 })
    const child = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `process.stdout.write(JSON.stringify(process.env)); process.exitCode = ${exitCode};`,
    ], { cwd: fixtureRoot, env, encoding: 'utf8', timeout: 10_000, windowsHide: true })
    assert.equal(child.status, exitCode, child.error?.message || child.stderr)
    assertIsolatedEnvironment(JSON.parse(child.stdout), smokeRoot, appOutDir, 43879)
    assert.equal(fs.readFileSync(hostSentinel, 'utf8'), 'host data is unchanged')
    assert.equal(sourceEnv.APP_DB_PATH, hostSentinel)
    assert.equal(JSON.stringify(process.env), callerSnapshot, 'the caller environment must be unchanged')
  })
}
